import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as path from 'path';
import * as fs from 'fs';
import {
  runReleaseReadinessGate,
  checkMigrationsGate,
  checkSecurityGate,
  checkSmokeTestsGate,
  checkRollbackRehearsalGate,
} from '../../scripts/release-readiness-gate';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('Release readiness gate contract (Issue #270)', () => {
  it('evaluates all 4 required gates successfully on current codebase', async () => {
    const report = await runReleaseReadinessGate({ repoRoot: REPO_ROOT });

    assert.equal(report.ready, true);
    assert.equal(report.totalGates, 4);
    assert.equal(report.passedGates, 4);
    assert.equal(report.failedGates, 0);

    assert.equal(report.gates.migrations.status, 'PASS');
    assert.equal(report.gates.security.status, 'PASS');
    assert.equal(report.gates.smoke_tests.status, 'PASS');
    assert.equal(report.gates.rollback_rehearsal.status, 'PASS');
  });

  it('blocks release if schema contains uncontained or unapproved destructive operations', async () => {
    // Test with temporary directory containing a destructive drop
    const tempDir = path.join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'temp-bad-schema');
    fs.mkdirSync(path.join(tempDir, 'db'), { recursive: true });

    try {
      fs.writeFileSync(
        path.join(tempDir, 'db', 'schema.sql'),
        `CREATE TABLE IF NOT EXISTS invoices (id UUID PRIMARY KEY);\nDROP TABLE invoices CASCADE;`
      );

      const result = await checkMigrationsGate(tempDir);
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /destructive action/i);
      assert.ok(result.details.some((d) => d.toLowerCase().includes('invoices')));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks release if schema table creations are non-idempotent', async () => {
    const tempDir = path.join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'temp-non-idempotent-schema');
    fs.mkdirSync(path.join(tempDir, 'db'), { recursive: true });

    try {
      fs.writeFileSync(
        path.join(tempDir, 'db', 'schema.sql'),
        `CREATE TABLE raw_invoices (id UUID PRIMARY KEY);`
      );

      const result = await checkMigrationsGate(tempDir);
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /without IF NOT EXISTS/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks release if deploy smoke test is missing', async () => {
    const tempDir = path.join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'temp-empty-repo');
    fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });

    try {
      const result = await checkSmokeTestsGate(tempDir);
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /deploy-smoke.mjs is missing/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks release if smoke test script lacks required endpoint coverage', async () => {
    const tempDir = path.join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'temp-incomplete-smoke');
    fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });

    try {
      fs.writeFileSync(
        path.join(tempDir, 'scripts', 'deploy-smoke.mjs'),
        `console.log("smoke test with no endpoints");`
      );

      const result = await checkSmokeTestsGate(tempDir);
      assert.equal(result.status, 'FAIL');
      assert.match(result.summary, /does not verify essential endpoints/i);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('validates rollback rehearsal invariants and produces actionable failure details on violations', async () => {
    const rehearsalResult = await checkRollbackRehearsalGate();
    assert.equal(rehearsalResult.status, 'PASS');
    assert.ok(rehearsalResult.details.some((d) => d.includes('data invariant checks')));
  });
});
