/**
 * Reproducible release artifacts and verification checks (#386).
 *
 * `build` packs one git commit into a deterministic `.tar.gz` plus a manifest
 * that names every file with its SHA-256. `verify` re-derives everything from
 * the artifact itself and compares it with the manifest. `check` is the CI gate:
 * it builds twice and proves the two builds are identical and verifiable.
 *
 * Reproducibility comes from the inputs, not from luck:
 *  - the tree is read from a commit with `git archive`, never the working dir, so
 *    untracked and uncommitted files cannot leak in;
 *  - tar entry mtimes are the commit time, modes come from git with `tar.umask`
 *    pinned (so user git config cannot change them), and gzip is written with no
 *    timestamp, so the same commit gives the same bytes.
 *
 * Trust comes from checks that do not rely on each other:
 *  - the artifact digest and size,
 *  - the manifest's own digest (detects edits),
 *  - an optional HMAC signature (detects a re-digested, forged manifest),
 *  - the tarball's real contents against the manifest's file list (detects
 *    missing, extra and altered files even if both digests were recomputed),
 *  - unsafe entries (absolute paths, `..`, duplicates, links outside the tree),
 *  - optionally a rebuild from the named commit.
 *
 * The signing key is read from RELEASE_SIGNING_KEY only, never from argv.
 *
 * Usage:
 *   npx tsx scripts/release-artifact.ts build  [--ref=HEAD] [--out=artifacts/release] [--force]
 *   npx tsx scripts/release-artifact.ts verify --manifest=<file> --artifact=<file>
 *        [--rebuild] [--expect-commit=<sha>] [--require-signature] [--json]
 *   npx tsx scripts/release-artifact.ts check  [--ref=HEAD]      # CI: build twice, verify
 *
 * See docs/RELEASE_ARTIFACTS.md.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export const MANIFEST_SCHEMA = 'inqutum.release-manifest/1';
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type ReleaseErrorCode =
  | 'BAD_REF'
  | 'GIT_FAILED'
  | 'OUTPUT_EXISTS_DIFFERENT'
  | 'BAD_MANIFEST'
  | 'BAD_ARCHIVE'
  | 'ARTIFACT_TOO_LARGE';

export class ReleaseArtifactError extends Error {
  constructor(public readonly code: ReleaseErrorCode, message: string) {
    super(message);
    this.name = 'ReleaseArtifactError';
  }
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  /** Octal mode as stored in the archive. */
  mode: string;
  type: 'file' | 'symlink';
}

export interface ManifestSignature {
  alg: 'hmac-sha256';
  value: string;
}

export interface ReleaseManifest {
  schema: typeof MANIFEST_SCHEMA;
  commit: string;
  tree: string;
  /** Commit time, ISO-8601 UTC. Not the build time, which would break reproducibility. */
  commitTime: string;
  version: string;
  artifact: { name: string; bytes: number; sha256: string };
  files: ManifestFile[];
  /** SHA-256 of the canonical manifest without `digest` and `signature`. */
  digest: string;
  signature?: ManifestSignature;
}

// -- helpers ------------------------------------------------------------------

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** JSON with sorted keys, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, sort(val)])
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function git(repoRoot: string, args: string[]): Buffer {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], { maxBuffer: MAX_ARTIFACT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new ReleaseArtifactError('GIT_FAILED', `git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function resolveCommit(repoRoot: string, ref: string) {
  // `--` and the ^{commit} suffix stop a ref from being read as an option or a non-commit.
  if (!ref || ref.startsWith('-')) throw new ReleaseArtifactError('BAD_REF', `Invalid ref "${ref}"`);
  let commit: string;
  try {
    commit = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).toString().trim();
  } catch {
    throw new ReleaseArtifactError('BAD_REF', `"${ref}" is not a commit in this repository`);
  }
  if (!COMMIT_RE.test(commit)) throw new ReleaseArtifactError('BAD_REF', `"${ref}" is not a commit in this repository`);
  const tree = git(repoRoot, ['rev-parse', `${commit}^{tree}`]).toString().trim();
  const epoch = Number(git(repoRoot, ['show', '-s', '--format=%ct', commit]).toString().trim());
  return { commit, tree, commitTime: new Date(epoch * 1000).toISOString() };
}

// -- tar reading ----------------------------------------------------------------

interface TarEntry {
  path: string;
  size: number;
  mode: string;
  type: 'file' | 'symlink' | 'dir';
  data: Buffer;
  linkTarget: string;
}

const readString = (buf: Buffer, start: number, len: number) => {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString('utf8');
};

const readOctal = (buf: Buffer, start: number, len: number): number => {
  const text = readString(buf, start, len).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new ReleaseArtifactError('BAD_ARCHIVE', 'Corrupt tar header (non-octal field)');
  return parseInt(text, 8);
};

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(data.subarray(offset, space).toString());
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) {
      throw new ReleaseArtifactError('BAD_ARCHIVE', 'Corrupt pax header');
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

/** Minimal ustar + pax reader; enough for `git archive` output. */
export function readTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingPax: Record<string, string> = {};
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const stored = readOctal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (sum !== stored) throw new ReleaseArtifactError('BAD_ARCHIVE', 'Tar header checksum mismatch');

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const rawSize = readOctal(header, 124, 12);
    const start = offset + 512;
    if (start + rawSize > tar.length) throw new ReleaseArtifactError('BAD_ARCHIVE', 'Tar entry runs past the end of the archive');
    const data = tar.subarray(start, start + rawSize);
    offset = start + Math.ceil(rawSize / 512) * 512;

    if (typeflag === 'g') continue;
    if (typeflag === 'x') {
      pendingPax = parsePax(data);
      continue;
    }
    const pax = pendingPax;
    pendingPax = {};
    const entryPath = pax.path ?? (prefix ? `${prefix}/${name}` : name);
    const linkTarget = pax.linkpath ?? readString(header, 157, 100);
    const mode = readOctal(header, 100, 8).toString(8).padStart(4, '0');
    if (typeflag === '5') entries.push({ path: entryPath.replace(/\/$/, ''), size: 0, mode, type: 'dir', data: Buffer.alloc(0), linkTarget: '' });
    else if (typeflag === '2') entries.push({ path: entryPath, size: 0, mode, type: 'symlink', data: Buffer.alloc(0), linkTarget });
    else if (typeflag === '0') entries.push({ path: entryPath, size: rawSize, mode, type: 'file', data, linkTarget: '' });
    else throw new ReleaseArtifactError('BAD_ARCHIVE', `Unsupported tar entry type "${typeflag}" for ${entryPath}`);
  }
  return entries;
}

function toManifestFiles(entries: TarEntry[]): ManifestFile[] {
  return entries
    .filter((e) => e.type !== 'dir')
    .map((e): ManifestFile =>
      e.type === 'symlink'
        ? { path: e.path, size: Buffer.byteLength(e.linkTarget), sha256: sha256(e.linkTarget), mode: e.mode, type: 'symlink' }
        : { path: e.path, size: e.size, sha256: sha256(e.data), mode: e.mode, type: 'file' }
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Entries that could escape the extraction directory or hide a duplicate. */
export function unsafeEntries(entries: TarEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const segments = e.path.split('/');
    if (e.path.startsWith('/') || /^[a-zA-Z]:/.test(e.path) || segments.includes('..') || e.path.includes('\0')) {
      problems.push(`unsafe path: ${e.path}`);
    }
    if (seen.has(e.path)) problems.push(`duplicate entry: ${e.path}`);
    seen.add(e.path);
    if (e.type === 'symlink') {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(e.path), e.linkTarget));
      if (e.linkTarget.startsWith('/') || resolved.startsWith('..')) problems.push(`symlink escapes the tree: ${e.path} -> ${e.linkTarget}`);
    }
  }
  return problems;
}

// -- signing --------------------------------------------------------------------

const hmac = (key: string, digest: string) => createHmac('sha256', key).update(digest).digest('hex');

const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

export function manifestDigest(manifest: Omit<ReleaseManifest, 'digest' | 'signature'> | ReleaseManifest): string {
  const { digest: _digest, signature: _signature, ...rest } = manifest as ReleaseManifest;
  return sha256(canonicalJson(rest));
}

// -- build ----------------------------------------------------------------------

export interface BuiltRelease {
  manifest: ReleaseManifest;
  artifact: Buffer;
}

export interface BuildOptions {
  repoRoot?: string;
  ref?: string;
  signingKey?: string;
  /** Package version recorded in the manifest. Defaults to backend/package.json at the commit. */
  version?: string;
}

/** Builds in memory. Same commit and same git version give the same bytes. */
export function buildRelease(options: BuildOptions = {}): BuiltRelease {
  const repoRoot = options.repoRoot ?? process.cwd();
  const { commit, tree, commitTime } = resolveCommit(repoRoot, options.ref ?? 'HEAD');
  // tar.umask is pinned: git otherwise takes it from the user's config (default 0002), which would change file modes between machines.
  const tar = git(repoRoot, ['-c', 'tar.umask=0022', 'archive', '--format=tar', commit]);
  const entries = readTar(tar);
  const problems = unsafeEntries(entries);
  if (problems.length) throw new ReleaseArtifactError('BAD_ARCHIVE', `Refusing to package unsafe tree: ${problems[0]}`);

  // zlib writes no mtime and a fixed OS byte, so the gzip stream is deterministic.
  const artifact = zlib.gzipSync(tar, { level: 9 });
  let version = options.version;
  if (!version) {
    try {
      version = JSON.parse(git(repoRoot, ['show', `${commit}:backend/package.json`]).toString()).version ?? '0.0.0';
    } catch {
      version = '0.0.0';
    }
  }

  const base = {
    schema: MANIFEST_SCHEMA,
    commit,
    tree,
    commitTime,
    version: String(version),
    artifact: { name: `inqutum-${commit.slice(0, 12)}.tar.gz`, bytes: artifact.length, sha256: sha256(artifact) },
    files: toManifestFiles(entries),
  } as const;
  const digest = manifestDigest(base as never);
  const manifest: ReleaseManifest = { ...base, files: [...base.files], digest };
  if (options.signingKey) manifest.signature = { alg: 'hmac-sha256', value: hmac(options.signingKey, digest) };
  return { manifest, artifact };
}

export interface WriteResult {
  manifestPath: string;
  artifactPath: string;
  /** False when identical files were already present (a safe retry). */
  written: boolean;
}

function atomicWrite(file: string, data: Buffer | string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Writes the artifact and manifest. Re-running with identical output is a no-op;
 * different content at the same name is refused unless `force`, so a published
 * artifact is never silently replaced.
 */
export function writeRelease(built: BuiltRelease, outDir: string, force = false): WriteResult {
  fs.mkdirSync(outDir, { recursive: true });
  const artifactPath = path.join(outDir, built.manifest.artifact.name);
  const manifestPath = path.join(outDir, `${built.manifest.artifact.name.replace(/\.tar\.gz$/, '')}.manifest.json`);
  const manifestText = `${JSON.stringify(built.manifest, null, 2)}\n`;

  const sameArtifact = fs.existsSync(artifactPath) && sha256(fs.readFileSync(artifactPath)) === built.manifest.artifact.sha256;
  const sameManifest = fs.existsSync(manifestPath) && fs.readFileSync(manifestPath, 'utf8') === manifestText;
  if (sameArtifact && sameManifest) return { manifestPath, artifactPath, written: false };

  const conflict = (fs.existsSync(artifactPath) && !sameArtifact) || (fs.existsSync(manifestPath) && !sameManifest);
  if (conflict && !force) {
    throw new ReleaseArtifactError('OUTPUT_EXISTS_DIFFERENT', `${outDir} already holds a different release for this commit; pass --force to replace it`);
  }
  // Artifact first: a manifest never points at a file that is not there yet.
  atomicWrite(artifactPath, built.artifact);
  atomicWrite(manifestPath, manifestText);
  return { manifestPath, artifactPath, written: true };
}

// -- verify ---------------------------------------------------------------------

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  commit: string | null;
  checks: VerifyCheck[];
}

export interface VerifyOptions {
  repoRoot?: string;
  signingKey?: string;
  /** Fail unless a valid signature is present (needs signingKey). */
  requireSignature?: boolean;
  /** Fail unless the manifest is for this commit, e.g. the rollback target. */
  expectCommit?: string;
  /** Rebuild from the manifest's commit and compare contents. Needs the repo. */
  rebuild?: boolean;
  maxArtifactBytes?: number;
}

function isManifest(value: unknown): value is ReleaseManifest {
  const m = value as ReleaseManifest;
  return (
    !!m &&
    typeof m === 'object' &&
    m.schema === MANIFEST_SCHEMA &&
    COMMIT_RE.test(String(m.commit)) &&
    typeof m.digest === 'string' &&
    SHA256_RE.test(m.digest) &&
    !!m.artifact &&
    SHA256_RE.test(String(m.artifact.sha256)) &&
    Number.isSafeInteger(m.artifact.bytes) &&
    Array.isArray(m.files) &&
    m.files.every((f) => f && typeof f.path === 'string' && SHA256_RE.test(String(f.sha256)) && Number.isSafeInteger(f.size))
  );
}

/** Verifies an artifact against a manifest. Never throws on bad input: it reports. */
export function verifyRelease(manifestInput: unknown, artifact: Buffer, options: VerifyOptions = {}): VerifyReport {
  const checks: VerifyCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const done = (commit: string | null): VerifyReport => ({ ok: checks.every((c) => c.ok), commit, checks });

  if (!isManifest(manifestInput)) {
    add('manifest-shape', false, `Not a ${MANIFEST_SCHEMA} manifest`);
    return done(null);
  }
  const manifest = manifestInput;
  add('manifest-shape', true, `schema ${manifest.schema}, ${manifest.files.length} files`);

  const digest = manifestDigest(manifest);
  add('manifest-digest', safeEqualHex(digest, manifest.digest), safeEqualHex(digest, manifest.digest) ? 'matches' : 'manifest was edited after it was written');

  if (options.signingKey) {
    const sig = manifest.signature;
    const ok = !!sig && sig.alg === 'hmac-sha256' && safeEqualHex(hmac(options.signingKey, manifest.digest), String(sig.value));
    add('signature', ok, ok ? 'valid' : sig ? 'does not match the signing key' : 'manifest is unsigned but a signing key was supplied');
  } else if (options.requireSignature) {
    add('signature', false, 'a signature is required but no RELEASE_SIGNING_KEY was supplied');
  } else {
    add('signature', true, manifest.signature ? 'present, not checked (no key supplied)' : 'unsigned (not required)');
  }

  if (options.expectCommit) {
    const expected = options.expectCommit.toLowerCase();
    const ok = expected.length >= 7 && manifest.commit.startsWith(expected);
    add('expected-commit', ok, ok ? `is ${manifest.commit.slice(0, 12)}` : `is ${manifest.commit.slice(0, 12)}, expected ${expected.slice(0, 12)}`);
  }

  const artifactSha = sha256(artifact);
  add('artifact-digest', safeEqualHex(artifactSha, manifest.artifact.sha256), safeEqualHex(artifactSha, manifest.artifact.sha256) ? 'matches' : `artifact is ${artifactSha.slice(0, 12)}…, manifest says ${manifest.artifact.sha256.slice(0, 12)}…`);
  add('artifact-size', artifact.length === manifest.artifact.bytes, `${artifact.length} bytes (manifest: ${manifest.artifact.bytes})`);

  let entries: TarEntry[] | null = null;
  try {
    const tar = zlib.gunzipSync(artifact, { maxOutputLength: options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES });
    entries = readTar(tar);
    add('archive-readable', true, `${entries.length} entries`);
  } catch (err) {
    const tooBig = (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
    add('archive-readable', false, tooBig ? 'archive expands beyond the size limit' : err instanceof Error ? err.message : String(err));
  }

  if (entries) {
    const unsafe = unsafeEntries(entries);
    add('archive-safe', unsafe.length === 0, unsafe.length === 0 ? 'no unsafe paths, duplicates or escaping links' : unsafe.slice(0, 3).join('; '));

    const actual = new Map(toManifestFiles(entries).map((f) => [f.path, f]));
    const declared = new Map(manifest.files.map((f) => [f.path, f]));
    const missing = [...declared.keys()].filter((p) => !actual.has(p));
    const extra = [...actual.keys()].filter((p) => !declared.has(p));
    const changed = [...declared.keys()].filter((p) => {
      const a = actual.get(p);
      const d = declared.get(p)!;
      return a && (a.sha256 !== d.sha256 || a.size !== d.size);
    });
    const problems = [
      ...missing.slice(0, 3).map((p) => `missing: ${p}`),
      ...extra.slice(0, 3).map((p) => `unexpected: ${p}`),
      ...changed.slice(0, 3).map((p) => `modified: ${p}`),
    ];
    add('contents', problems.length === 0, problems.length === 0 ? `${declared.size} files match the manifest` : `${missing.length} missing, ${extra.length} unexpected, ${changed.length} modified (${problems.join('; ')})`);
  }

  if (options.rebuild) {
    try {
      const rebuilt = buildRelease({ repoRoot: options.repoRoot, ref: manifest.commit });
      const theirs = new Map(manifest.files.map((f) => [f.path, f.sha256]));
      const ours = new Map(rebuilt.manifest.files.map((f) => [f.path, f.sha256]));
      const diff = [...new Set([...theirs.keys(), ...ours.keys()])].filter((p) => theirs.get(p) !== ours.get(p));
      const identical = rebuilt.manifest.artifact.sha256 === manifest.artifact.sha256;
      add(
        'rebuild',
        diff.length === 0 && rebuilt.manifest.tree === manifest.tree,
        diff.length === 0 && rebuilt.manifest.tree === manifest.tree
          ? identical
            ? 'rebuilt from the commit; byte-for-byte identical'
            : 'rebuilt from the commit; same contents (bytes differ, likely a different git version)'
          : `rebuild differs from the manifest in ${diff.length} file(s)${rebuilt.manifest.tree !== manifest.tree ? ' and in the tree id' : ''}`
      );
    } catch (err) {
      add('rebuild', false, err instanceof Error ? err.message : String(err));
    }
  }
  return done(manifest.commit);
}

/** CI gate: two independent builds must be identical and must verify. */
export function checkReproducible(options: BuildOptions & { rebuild?: boolean } = {}): VerifyReport {
  const first = buildRelease(options);
  const second = buildRelease(options);
  const checks: VerifyCheck[] = [
    {
      name: 'reproducible-build',
      ok: first.manifest.artifact.sha256 === second.manifest.artifact.sha256 && canonicalJson(first.manifest) === canonicalJson(second.manifest),
      detail:
        first.manifest.artifact.sha256 === second.manifest.artifact.sha256
          ? `two builds of ${first.manifest.commit.slice(0, 12)} are identical (${first.manifest.artifact.sha256.slice(0, 12)}…)`
          : 'two builds of the same commit differ',
    },
  ];
  const verified = verifyRelease(first.manifest, first.artifact, {
    repoRoot: options.repoRoot,
    signingKey: options.signingKey,
    rebuild: options.rebuild ?? true,
  });
  return { ok: checks.every((c) => c.ok) && verified.ok, commit: first.manifest.commit, checks: [...checks, ...verified.checks] };
}

// -- CLI ------------------------------------------------------------------------

function printReport(report: VerifyReport, json: boolean) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const c of report.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  console.log(report.ok ? '\nRelease verified.' : '\nRelease verification FAILED.');
}

export function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
  const [command, ...rest] = argv;
  const flag = (name: string) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const has = (name: string) => rest.includes(`--${name}`);
  const signingKey = env.RELEASE_SIGNING_KEY || undefined;
  const repoRoot = path.resolve(__dirname, '..');
  const json = has('json');
  try {
    if (command === 'build') {
      const built = buildRelease({ repoRoot, ref: flag('ref'), signingKey });
      const out = writeRelease(built, path.resolve(flag('out') ?? path.join(repoRoot, 'artifacts', 'release')), has('force'));
      console.log(`${out.written ? 'Wrote' : 'Already present (identical)'}: ${out.artifactPath}`);
      console.log(`Manifest: ${out.manifestPath}`);
      console.log(`Commit ${built.manifest.commit}  sha256 ${built.manifest.artifact.sha256}  ${signingKey ? 'signed' : 'UNSIGNED'}`);
      return 0;
    }
    if (command === 'verify') {
      const manifestFile = flag('manifest');
      const artifactFile = flag('artifact');
      if (!manifestFile || !artifactFile) {
        console.error('verify needs --manifest=<file> --artifact=<file>');
        return 2;
      }
      let manifest: unknown;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      } catch {
        manifest = null;
      }
      const report = verifyRelease(manifest, fs.readFileSync(artifactFile), {
        repoRoot,
        signingKey,
        requireSignature: has('require-signature'),
        expectCommit: flag('expect-commit'),
        rebuild: has('rebuild'),
      });
      printReport(report, json);
      return report.ok ? 0 : 1;
    }
    if (command === 'check') {
      const report = checkReproducible({ repoRoot, ref: flag('ref'), signingKey });
      printReport(report, json);
      return report.ok ? 0 : 1;
    }
    console.error('usage: release-artifact <build|verify|check> [options]  (see docs/RELEASE_ARTIFACTS.md)');
    return 2;
  } catch (err) {
    console.error(err instanceof ReleaseArtifactError ? `${err.code}: ${err.message}` : err);
    return 1;
  }
}

if (require.main === module || (process.argv[1] && /release-artifact\.(ts|js)$/.test(process.argv[1]))) {
  process.exitCode = main();
}
