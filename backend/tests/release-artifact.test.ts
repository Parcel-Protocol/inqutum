/**
 * Reproducible release artifacts and verification checks (#386).
 *
 * Uses a throwaway git repository so commits, trees and timestamps are fully
 * controlled. Covers normal, failure, retry and authorization paths.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  MANIFEST_SCHEMA,
  ReleaseArtifactError,
  buildRelease,
  canonicalJson,
  checkReproducible,
  main,
  manifestDigest,
  readTar,
  unsafeEntries,
  verifyRelease,
  writeRelease,
  type ReleaseManifest,
} from '../../scripts/release-artifact';

const KEY = 'release-signing-key-for-tests-0123456789';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let repo = '';
let c1 = '';
let c2 = '';
let scratch = '';

function git(args: string[], env: Record<string, string> = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

function commit(message: string, when: string) {
  git(['add', '-A']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
  return git(['rev-parse', 'HEAD']);
}

/** Minimal ustar writer for crafting hostile archives. */
function tarEntry(name: string, content: string | Buffer, type = '0', linkname = ''): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(linkname, 157, 100);
  header.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}
const tarOf = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);

/** Re-signs a manifest the way an attacker who edits it would: fixing its digest, not its signature. */
function redigest(manifest: ReleaseManifest): ReleaseManifest {
  const copy = { ...manifest, files: manifest.files.map((f) => ({ ...f })) } as ReleaseManifest;
  copy.digest = manifestDigest(copy);
  return copy;
}

const failing = (report: { checks: Array<{ name: string; ok: boolean }> }) => report.checks.filter((c) => !c.ok).map((c) => c.name);

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-artifact-'));
  repo = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repo, 'backend'), { recursive: true });
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'backend', 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }));
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const deep = path.join(repo, 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'long-path.txt'), 'a path longer than 100 characters needs a pax header\n');
  fs.symlinkSync('README.md', path.join(repo, 'link'));
  c1 = commit('first', '2026-01-01T00:00:00Z');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello again\n');
  fs.writeFileSync(path.join(repo, 'untracked-later'), 'x');
  fs.rmSync(path.join(repo, 'untracked-later'));
  c2 = commit('second', '2026-02-01T00:00:00Z');
});

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('build — reproducibility', () => {
  it('builds identical bytes and manifests from the same commit', () => {
    const a = buildRelease({ repoRoot: repo, ref: c1 });
    const b = buildRelease({ repoRoot: repo, ref: c1 });
    assert.ok(a.artifact.equals(b.artifact));
    assert.equal(canonicalJson(a.manifest), canonicalJson(b.manifest));
  });

  it('is independent of the build time and the working directory state', () => {
    const before = buildRelease({ repoRoot: repo, ref: c2 });
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted');
    fs.writeFileSync(path.join(repo, 'README.md'), 'edited but not committed');
    try {
      const after = buildRelease({ repoRoot: repo, ref: c2 });
      assert.ok(before.artifact.equals(after.artifact), 'uncommitted changes must not leak into the artifact');
      assert.ok(!after.manifest.files.some((f) => f.path === 'dirty.txt'));
    } finally {
      fs.rmSync(path.join(repo, 'dirty.txt'));
      git(['checkout', '--', 'README.md']);
    }
  });

  it('different commits give different artifacts, and the manifest names the commit, tree and commit time', () => {
    const a = buildRelease({ repoRoot: repo, ref: c1 });
    const b = buildRelease({ repoRoot: repo, ref: c2 });
    assert.notEqual(a.manifest.artifact.sha256, b.manifest.artifact.sha256);
    assert.equal(a.manifest.commit, c1);
    assert.equal(a.manifest.tree, git(['rev-parse', `${c1}^{tree}`]));
    assert.equal(a.manifest.commitTime, '2026-01-01T00:00:00.000Z');
    assert.equal(a.manifest.version, '1.2.3');
    assert.equal(a.manifest.schema, MANIFEST_SCHEMA);
  });

  it('records every file with sha256, size and mode, sorted, including pax long paths, modes and symlinks', () => {
    const { manifest } = buildRelease({ repoRoot: repo, ref: c1 });
    const paths = manifest.files.map((f) => f.path);
    assert.deepEqual(paths, [...paths].sort());
    const readme = manifest.files.find((f) => f.path === 'README.md')!;
    assert.equal(readme.sha256, sha('hello\n'));
    assert.equal(readme.size, 6);
    assert.equal(manifest.files.find((f) => f.path === 'run.sh')!.mode, '0755');
    const link = manifest.files.find((f) => f.path === 'link')!;
    assert.equal(link.type, 'symlink');
    assert.equal(link.sha256, sha('README.md'));
    assert.ok(paths.some((p) => p.length > 100 && p.endsWith('long-path.txt')), 'long path survives intact');
  });

  it('is not affected by the builder\'s git tar.umask config', () => {
    const baseline = buildRelease({ repoRoot: repo, ref: c1 });
    const prev = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'tar.umask';
    process.env.GIT_CONFIG_VALUE_0 = '0077';
    try {
      assert.ok(buildRelease({ repoRoot: repo, ref: c1 }).artifact.equals(baseline.artifact));
    } finally {
      if (prev === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = prev;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }
  });

  it('signs with HMAC when a key is supplied and leaves the unsigned digest unchanged', () => {
    const unsigned = buildRelease({ repoRoot: repo, ref: c1 });
    const signed = buildRelease({ repoRoot: repo, ref: c1, signingKey: KEY });
    assert.equal(unsigned.manifest.signature, undefined);
    assert.equal(signed.manifest.signature?.alg, 'hmac-sha256');
    assert.equal(signed.manifest.digest, unsigned.manifest.digest);
  });

  it('failure: an unknown ref, an option-like ref and a non-commit are rejected without touching anything', () => {
    for (const ref of ['does-not-exist', '--output=/tmp/x', '', `${c1}:README.md`]) {
      assert.throws(() => buildRelease({ repoRoot: repo, ref }), (e: unknown) => e instanceof ReleaseArtifactError && e.code === 'BAD_REF', ref);
    }
  });

  it('failure: a directory that is not a git repository reports GIT_FAILED/BAD_REF', () => {
    assert.throws(() => buildRelease({ repoRoot: scratch, ref: 'HEAD' }), (e: unknown) => e instanceof ReleaseArtifactError);
  });
});

describe('write — retry and overwrite protection', () => {
  it('retry: writing the same release twice is a no-op the second time', () => {
    const out = path.join(scratch, 'out-retry');
    const built = buildRelease({ repoRoot: repo, ref: c1 });
    const first = writeRelease(built, out);
    const mtime = fs.statSync(first.artifactPath).mtimeMs;
    const second = writeRelease(buildRelease({ repoRoot: repo, ref: c1 }), out);
    assert.equal(first.written, true);
    assert.equal(second.written, false);
    assert.equal(fs.statSync(second.artifactPath).mtimeMs, mtime);
    assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
  });

  it('failure: a different file already at the path is refused unless forced', () => {
    const out = path.join(scratch, 'out-conflict');
    const built = buildRelease({ repoRoot: repo, ref: c1 });
    const { artifactPath } = writeRelease(built, out);
    fs.writeFileSync(artifactPath, 'tampered');
    assert.throws(() => writeRelease(built, out), (e: unknown) => e instanceof ReleaseArtifactError && e.code === 'OUTPUT_EXISTS_DIFFERENT');
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'tampered', 'the existing file is untouched');
    assert.equal(writeRelease(built, out, true).written, true);
    assert.ok(fs.readFileSync(artifactPath).equals(built.artifact));
  });
});

describe('verify — normal path', () => {
  it('passes for an untouched signed release, including a rebuild from the commit', () => {
    const built = buildRelease({ repoRoot: repo, ref: c2, signingKey: KEY });
    const report = verifyRelease(built.manifest, built.artifact, { repoRoot: repo, signingKey: KEY, requireSignature: true, rebuild: true, expectCommit: c2.slice(0, 12) });
    assert.deepEqual(failing(report), []);
    assert.equal(report.ok, true);
    assert.equal(report.commit, c2);
    assert.match(report.checks.find((c) => c.name === 'rebuild')!.detail, /byte-for-byte identical/);
  });

  it('passes unsigned when no signature is required', () => {
    const built = buildRelease({ repoRoot: repo, ref: c1 });
    const report = verifyRelease(built.manifest, built.artifact);
    assert.equal(report.ok, true);
    assert.match(report.checks.find((c) => c.name === 'signature')!.detail, /unsigned/);
  });
});

describe('verify — failure paths', () => {
  it('detects a flipped byte in the artifact', () => {
    const built = buildRelease({ repoRoot: repo, ref: c1 });
    const bad = Buffer.from(built.artifact);
    bad[bad.length - 12] ^= 0xff;
    const report = verifyRelease(built.manifest, bad);
    assert.equal(report.ok, false);
    assert.ok(failing(report).includes('artifact-digest'));
  });

  it('detects a truncated artifact without throwing', () => {
    const built = buildRelease({ repoRoot: repo, ref: c1 });
    const report = verifyRelease(built.manifest, built.artifact.subarray(0, 40));
    assert.equal(report.ok, false);
    assert.ok(failing(report).includes('artifact-size'));
    assert.ok(failing(report).includes('archive-readable'));
  });

  it('detects an edited manifest', () => {
    const built = buildRelease({ repoRoot: repo, ref: c1 });
    const edited = { ...built.manifest, version: '9.9.9' };
    assert.ok(failing(verifyRelease(edited, built.artifact)).includes('manifest-digest'));
  });

  it('detects a swapped artifact even when the attacker re-digests the manifest', () => {
    const real = buildRelease({ repoRoot: repo, ref: c1 });
    const other = buildRelease({ repoRoot: repo, ref: c2 });
    const forged = redigest({ ...real.manifest, artifact: { ...real.manifest.artifact, sha256: other.manifest.artifact.sha256, bytes: other.artifact.length } });
    const report = verifyRelease(forged, other.artifact);
    assert.ok(failing(report).includes('contents'), 'file list still describes the old tree');
    assert.equal(report.ok, false);
  });

  it('reports missing, unexpected and modified files', () => {
    const tar = tarOf(tarEntry('README.md', 'changed\n'), tarEntry('extra.txt', 'surprise'));
    const artifact = zlib.gzipSync(tar);
    const base = buildRelease({ repoRoot: repo, ref: c1 });
    const manifest = redigest({ ...base.manifest, artifact: { name: 'x.tar.gz', bytes: artifact.length, sha256: sha(artifact) } });
    const report = verifyRelease(manifest, artifact);
    const contents = report.checks.find((c) => c.name === 'contents')!;
    assert.equal(contents.ok, false);
    assert.match(contents.detail, /missing: /);
    assert.match(contents.detail, /unexpected: extra\.txt/);
    assert.match(contents.detail, /modified: README\.md/);
  });

  it('rejects path traversal, absolute paths, duplicate entries and escaping symlinks', () => {
    const hostile = tarOf(
      tarEntry('../evil.txt', 'x'),
      tarEntry('/etc/passwd', 'x'),
      tarEntry('dup.txt', '1'),
      tarEntry('dup.txt', '2'),
      tarEntry('out', '', '2', '../../outside')
    );
    const problems = unsafeEntries(readTar(hostile));
    assert.ok(problems.some((p) => p.includes('../evil.txt')));
    assert.ok(problems.some((p) => p.includes('/etc/passwd')));
    assert.ok(problems.some((p) => p.includes('duplicate entry: dup.txt')));
    assert.ok(problems.some((p) => p.includes('symlink escapes')));

    const artifact = zlib.gzipSync(hostile);
    const base = buildRelease({ repoRoot: repo, ref: c1 });
    const manifest = redigest({ ...base.manifest, artifact: { name: 'h.tar.gz', bytes: artifact.length, sha256: sha(artifact) } });
    assert.ok(failing(verifyRelease(manifest, artifact)).includes('archive-safe'));
  });

  it('rejects a corrupt tar header instead of reading garbage', () => {
    const tar = Buffer.from(tarOf(tarEntry('a.txt', 'a')));
    tar[10] ^= 0x01; // checksum no longer matches
    assert.throws(() => readTar(tar), (e: unknown) => e instanceof ReleaseArtifactError && e.code === 'BAD_ARCHIVE');
  });

  it('refuses to expand an archive beyond the size limit', () => {
    const built = buildRelease({ repoRoot: repo, ref: c1 });
    const report = verifyRelease(built.manifest, built.artifact, { maxArtifactBytes: 1024 });
    assert.match(report.checks.find((c) => c.name === 'archive-readable')!.detail, /size limit/);
    assert.equal(report.ok, false);
  });

  it('reports malformed manifests instead of throwing', () => {
    const artifact = Buffer.from('x');
    for (const bad of [null, undefined, 'text', 42, {}, { schema: 'other' }, { ...buildRelease({ repoRoot: repo, ref: c1 }).manifest, files: 'nope' }]) {
      const report = verifyRelease(bad, artifact);
      assert.equal(report.ok, false);
      assert.equal(report.checks[0].name, 'manifest-shape');
    }
  });

  it('rebuild detects a manifest whose commit does not match its contents', () => {
    const a = buildRelease({ repoRoot: repo, ref: c1 });
    const b = buildRelease({ repoRoot: repo, ref: c2 });
    // Contents and files of c2, but claiming to be c1.
    const lying = redigest({ ...b.manifest, commit: c1, tree: a.manifest.tree });
    const report = verifyRelease(lying, b.artifact, { repoRoot: repo, rebuild: true });
    assert.ok(failing(report).includes('rebuild'));
  });
});

describe('verify — authorization (signing)', () => {
  it('rejects a manifest signed with a different key', () => {
    const built = buildRelease({ repoRoot: repo, ref: c1, signingKey: 'someone-elses-key-0123456789' });
    const report = verifyRelease(built.manifest, built.artifact, { signingKey: KEY });
    assert.ok(failing(report).includes('signature'));
  });

  it('rejects an unsigned manifest when a key is supplied (no silent downgrade)', () => {
    const built = buildRelease({ repoRoot: repo, ref: c1 });
    const report = verifyRelease(built.manifest, built.artifact, { signingKey: KEY });
    assert.match(report.checks.find((c) => c.name === 'signature')!.detail, /unsigned but a signing key was supplied/);
    assert.equal(report.ok, false);
  });

  it('requireSignature without a key fails closed', () => {
    const built = buildRelease({ repoRoot: repo, ref: c1, signingKey: KEY });
    const report = verifyRelease(built.manifest, built.artifact, { requireSignature: true });
    assert.equal(report.ok, false);
    assert.match(report.checks.find((c) => c.name === 'signature')!.detail, /no RELEASE_SIGNING_KEY/);
  });

  it('a re-digested forged manifest fails the signature even though every digest is consistent', () => {
    const real = buildRelease({ repoRoot: repo, ref: c1, signingKey: KEY });
    const forged = redigest({ ...real.manifest, version: '6.6.6' });
    const report = verifyRelease(forged, real.artifact, { signingKey: KEY });
    assert.equal(report.checks.find((c) => c.name === 'manifest-digest')!.ok, true);
    assert.equal(report.checks.find((c) => c.name === 'signature')!.ok, false);
  });
});

describe('rollback target check', () => {
  it('accepts the expected commit (full or abbreviated) and rejects any other', () => {
    const previous = buildRelease({ repoRoot: repo, ref: c1, signingKey: KEY });
    assert.equal(verifyRelease(previous.manifest, previous.artifact, { signingKey: KEY, expectCommit: c1 }).ok, true);
    assert.equal(verifyRelease(previous.manifest, previous.artifact, { signingKey: KEY, expectCommit: c1.slice(0, 8) }).ok, true);
    const wrong = verifyRelease(previous.manifest, previous.artifact, { signingKey: KEY, expectCommit: c2 });
    assert.ok(failing(wrong).includes('expected-commit'));
    assert.ok(failing(verifyRelease(previous.manifest, previous.artifact, { expectCommit: 'abc' })).includes('expected-commit'), 'too-short prefix is not accepted');
  });
});

describe('check — CI gate', () => {
  it('passes for a reproducible build', () => {
    const report = checkReproducible({ repoRoot: repo, ref: c2 });
    assert.equal(report.ok, true, JSON.stringify(failing(report)));
    assert.equal(report.checks[0].name, 'reproducible-build');
    assert.ok(report.checks.some((c) => c.name === 'rebuild' && c.ok));
  });
});

describe('CLI', () => {
  const quiet = <T>(fn: () => T): T => {
    const log = console.log;
    const err = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      return fn();
    } finally {
      console.log = log;
      console.error = err;
    }
  };

  it('verify exits 0 for a good release and 1 for a tampered one; key comes from the environment only', () => {
    const out = path.join(scratch, 'out-cli');
    const built = buildRelease({ repoRoot: repo, ref: c1, signingKey: KEY });
    const { manifestPath, artifactPath } = writeRelease(built, out);
    const env = { RELEASE_SIGNING_KEY: KEY } as NodeJS.ProcessEnv;
    assert.equal(quiet(() => main(['verify', `--manifest=${manifestPath}`, `--artifact=${artifactPath}`, '--require-signature'], env)), 0);
    assert.equal(quiet(() => main(['verify', `--manifest=${manifestPath}`, `--artifact=${artifactPath}`, '--require-signature'], {} as NodeJS.ProcessEnv)), 1, 'no key: fails closed');
    const bad = Buffer.from(built.artifact);
    bad[bad.length - 12] ^= 0xff;
    fs.writeFileSync(artifactPath, bad);
    assert.equal(quiet(() => main(['verify', `--manifest=${manifestPath}`, `--artifact=${artifactPath}`], env)), 1);
  });

  it('exits 2 on usage errors and 1 on an unreadable manifest', () => {
    assert.equal(quiet(() => main([], {} as NodeJS.ProcessEnv)), 2);
    assert.equal(quiet(() => main(['verify'], {} as NodeJS.ProcessEnv)), 2);
    const garbage = path.join(scratch, 'garbage.json');
    fs.writeFileSync(garbage, 'not json');
    assert.equal(quiet(() => main(['verify', `--manifest=${garbage}`, `--artifact=${garbage}`], {} as NodeJS.ProcessEnv)), 1);
  });
});
