# Reproducible release artifacts and verification (#386)

`scripts/release-artifact.ts` packs one git commit into a deterministic
`.tar.gz` with a manifest, and verifies an artifact against its manifest. It
complements the [release readiness gate](RELEASE_READINESS_GATE.md): the gate
says a commit is *fit* to release, this says the thing you ship *is* that commit.

## Commands

Run from `backend/` (or call the script with `npx tsx scripts/release-artifact.ts`).

| Command | What it does |
|---------|--------------|
| `npm run release:artifact -- [--ref=HEAD] [--out=artifacts/release] [--force]` | Build `inqutum-<commit12>.tar.gz` and `inqutum-<commit12>.manifest.json` |
| `npm run release:artifact:verify -- --manifest=F --artifact=F [--rebuild] [--expect-commit=SHA] [--require-signature] [--json]` | Verify an artifact. Exit 0 pass, 1 fail, 2 usage |
| `npm run release:artifact:check` | CI gate: build twice, require identical output, then verify including a rebuild |

Signing is optional. Set `RELEASE_SIGNING_KEY` in the environment to sign on
build and to check the signature on verify. The key is never read from argv, so it
stays out of shell history and process listings. `artifacts/` is git-ignored.

## Why the build is reproducible

- It reads a **commit**, through `git archive`, never the working directory.
  Untracked and uncommitted files cannot leak in.
- Entry times are the commit time. Modes come from git with `tar.umask` pinned to
  `0022` in the build, because git otherwise takes it from the builder's config
  (default `0002`), which would change file modes from machine to machine.
- gzip is written with no timestamp.
- The manifest records the **commit time**, not the build time, and keys are
  sorted before hashing.

Caveat: `git archive` output is stable for a given git version. A different git
version can change tar framing for the same content. `verify --rebuild` therefore
fails only if the *contents* differ, and reports whether the bytes are identical.
The per-file SHA-256 list is the version-independent check.

## What verification checks

Each check is independent, so defeating one does not defeat the others.

| Check | Catches |
|-------|---------|
| `manifest-shape` | A file that is not a release manifest |
| `manifest-digest` | The manifest being edited after it was written |
| `signature` | A forged manifest whose digest was recomputed. Fails if a key is supplied and the manifest is unsigned (no silent downgrade) or signed with another key. `--require-signature` with no key fails closed |
| `expected-commit` | The wrong release, for example when rolling back to a specific commit (a prefix of at least 7 characters is accepted) |
| `artifact-digest`, `artifact-size` | A corrupted, truncated or swapped artifact |
| `archive-readable` | A corrupt gzip or tar, or an archive that expands past 512 MB |
| `archive-safe` | Absolute paths, `..`, duplicate entries, symlinks that leave the tree |
| `contents` | Missing, unexpected or modified files, judged from the tarball itself, so it still catches a manifest that was re-digested to match |
| `rebuild` (opt-in) | A manifest whose commit does not match its contents |

## Failure, retry and recovery

| Situation | Behaviour |
|-----------|-----------|
| Unknown ref, option-like ref (`--output=...`), or a ref that is not a commit | `BAD_REF`; nothing written |
| Re-running a build for the same commit | No-op; files are identical, so `Already present (identical)` |
| A different file already at the output path | `OUTPUT_EXISTS_DIFFERENT`; the existing file is untouched. Pass `--force` to replace it |
| Interrupted build | Files are written to a temp name then renamed, artifact first, so a manifest never points at a missing artifact |
| Verification of a corrupt or truncated artifact | Reported as failed checks, never an exception |

## Rollback

Keep each released artifact and manifest. To roll back, verify the previous
release **before** deploying it, and pin the commit you intend to restore:

```bash
RELEASE_SIGNING_KEY=... npm run release:artifact:verify -- \
  --manifest=inqutum-<prev>.manifest.json --artifact=inqutum-<prev>.tar.gz \
  --require-signature --expect-commit=<prev-sha> --rebuild
```

If it fails, do not deploy that artifact. Rebuild from the commit with
`release:artifact -- --ref=<prev-sha>`. The same commit gives the same contents,
so the rebuilt manifest's file list will match the one you recorded.

## Compatibility

Additive: a new script, three npm scripts and one CI step. No runtime code, API,
schema or existing script changes. CI runs `release:artifact:check` after the
release readiness gate. Tests: `backend/tests/release-artifact.test.ts`.
