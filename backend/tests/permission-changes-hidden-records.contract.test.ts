/**
 * Contract tests: permission changes and hidden records (#385).
 *
 * The behaviours below are each tested in isolation elsewhere. This suite pins
 * the contract *between* them: what a viewer can see must follow the permission
 * state at the moment of the read, and a hidden record must be indistinguishable
 * from one that does not exist.
 *
 * Paths covered for each contract: normal, failure, retry, authorization.
 * See docs/PERMISSION_HIDDEN_RECORDS_CONTRACT.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PermissionDiffService } from '../src/services/permission-diff.service';
import {
  DEFAULT_ROLE_PERMISSIONS,
  HIGH_PRIVILEGE_PERMISSIONS,
  RoleEscalationForbiddenError,
  UnauthorizedPermissionDiffError,
  type SystemPermission,
} from '../src/domain/permission-diff';
import { paginateStable, InvalidStableCursorError, type Pageable } from '../src/domain/stable-cursor';
import { DisputeWorkflowService } from '../src/domain/dispute-workflow';
import { InvoiceArchiveService } from '../src/domain/invoice-archival';
import { SessionRevocationStore } from '../src/auth/revocation-store';
import { issueSessionToken } from '../src/auth/session-token';
import { actorFromBearer } from '../src/middleware/access-control';
import { MAINTAINER_TOKEN, TEST_SESSION_SECRET } from './fixtures/auth.fixture';

const SECRET = 'contract-cursor-secret';
const NOW = new Date('2026-11-01T00:00:00.000Z');

// -- Permission changes ------------------------------------------------------

describe('permission change contract', () => {
  const service = new PermissionDiffService();
  const OWNER = { actorId: 'owner-1', actorRole: 'OWNER' as const };

  /** The permission set a role would hold after a diff is applied. */
  const applyDiff = (current: readonly SystemPermission[], added: SystemPermission[], revoked: SystemPermission[]) =>
    [...current.filter((p) => !revoked.includes(p)), ...added];

  it('normal: a diff accounts for every permission exactly once (added + retained = proposed, revoked + retained = current)', () => {
    const proposed: SystemPermission[] = ['invoice:read', 'invoice:create', 'audit:read'];
    const { roleDiffs } = service.generateRoleDiff('COLLABORATOR', proposed, OWNER);
    const diff = roleDiffs[0];
    assert.deepEqual([...diff.addedPermissions, ...diff.retainedPermissions].sort(), [...proposed].sort());
    assert.deepEqual(
      [...diff.revokedPermissions, ...diff.retainedPermissions].sort(),
      [...DEFAULT_ROLE_PERMISSIONS.COLLABORATOR].sort()
    );
  });

  it('normal: applying the diff then its reversal plan restores the original permission set', () => {
    const proposed: SystemPermission[] = ['invoice:read', 'audit:read'];
    const { roleDiffs } = service.generateRoleDiff('COLLABORATOR', proposed, OWNER);
    const diff = roleDiffs[0];

    const changed = applyDiff(DEFAULT_ROLE_PERMISSIONS.COLLABORATOR, diff.addedPermissions, diff.revokedPermissions);
    assert.deepEqual([...changed].sort(), [...proposed].sort());

    const restored = diff.reversalPlan.restorePermissions;
    assert.deepEqual([...restored].sort(), [...DEFAULT_ROLE_PERMISSIONS.COLLABORATOR].sort());
  });

  it('retry: generating the same diff twice is read-only and yields the same decision', () => {
    const before = JSON.stringify(DEFAULT_ROLE_PERMISSIONS);
    const proposed: SystemPermission[] = [...DEFAULT_ROLE_PERMISSIONS.VIEWER, 'policy:update'];
    const first = service.generateRoleDiff('VIEWER', proposed, OWNER);
    const second = service.generateRoleDiff('VIEWER', proposed, OWNER);

    assert.equal(JSON.stringify(DEFAULT_ROLE_PERMISSIONS), before, 'diffing must never mutate the role table');
    assert.notEqual(first.reportId, second.reportId, 'each report has its own id');
    assert.equal(first.overallRisk, second.overallRisk);
    assert.deepEqual(first.roleDiffs[0].addedPermissions, second.roleDiffs[0].addedPermissions);
    assert.deepEqual(first.reversalRecipe, second.reversalRecipe);
  });

  it('failure: a no-op proposal reports nothing to add or revoke and the lowest risk', () => {
    const { roleDiffs, overallRisk, requiresMaintainerQuorum } = service.generateRoleDiff(
      'ADMIN',
      [...DEFAULT_ROLE_PERMISSIONS.ADMIN],
      OWNER
    );
    assert.deepEqual(roleDiffs[0].addedPermissions, []);
    assert.deepEqual(roleDiffs[0].revokedPermissions, []);
    assert.equal(overallRisk, 'LOW');
    assert.equal(requiresMaintainerQuorum, false);
  });

  it('failure: an unknown permission string is reported as added, never silently dropped', () => {
    const bogus = 'invoice:teleport' as SystemPermission;
    const { roleDiffs } = service.generateRoleDiff('VIEWER', [...DEFAULT_ROLE_PERMISSIONS.VIEWER, bogus], OWNER);
    assert.ok(roleDiffs[0].addedPermissions.includes(bogus));
  });

  it('authorization: every high-privilege grant to a non-owner role is escalation, for every such role', () => {
    for (const role of ['ADMIN', 'COLLABORATOR', 'VIEWER'] as const) {
      for (const permission of HIGH_PRIVILEGE_PERMISSIONS) {
        if (DEFAULT_ROLE_PERMISSIONS[role].includes(permission)) continue;
        const report = service.generateRoleDiff(role, [...DEFAULT_ROLE_PERMISSIONS[role], permission], OWNER);
        assert.equal(report.privilegeEscalationDetected, true, `${role} + ${permission}`);
        assert.equal(report.overallRisk, 'CRITICAL', `${role} + ${permission}`);
        assert.equal(report.requiresMaintainerQuorum, true, `${role} + ${permission}`);
      }
    }
  });

  it('authorization: only ADMIN and OWNER may generate a diff', () => {
    for (const actorRole of ['COLLABORATOR', 'VIEWER'] as const) {
      assert.throws(
        () => service.generateRoleDiff('VIEWER', ['invoice:read'], { actorId: 'u', actorRole }),
        (err: unknown) => err instanceof UnauthorizedPermissionDiffError && err.httpStatus === 403
      );
    }
    assert.doesNotThrow(() => service.generateRoleDiff('VIEWER', ['invoice:read'], { actorId: 'a', actorRole: 'ADMIN' }));
  });

  it('authorization: a non-owner cannot assign a role at or above their own, but an owner can', () => {
    assert.throws(
      () => service.generateUserAssignmentDiff('u-1', 'VIEWER', 'ADMIN', { actorId: 'a', actorRole: 'ADMIN' }),
      (err: unknown) => err instanceof RoleEscalationForbiddenError && err.httpStatus === 403
    );
    const report = service.generateUserAssignmentDiff('u-1', 'VIEWER', 'ADMIN', OWNER);
    assert.equal(report.scope, 'USER_ROLE_ASSIGNMENT');
  });

  it('authorization: promoting to OWNER is always CRITICAL and needs a quorum', () => {
    const report = service.generateUserAssignmentDiff('u-1', 'ADMIN', 'OWNER', OWNER);
    assert.equal(report.overallRisk, 'CRITICAL');
    assert.equal(report.requiresMaintainerQuorum, true);
  });
});

// -- Session permission change: revocation takes effect on the next request ---

describe('permission change takes effect on the next request (session revocation)', () => {
  const env = { AUTH_SESSION_SECRET: TEST_SESSION_SECRET, MAINTAINER_API_TOKENS: MAINTAINER_TOKEN };
  const wallet = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
  const nowMs = 1_700_000_000_000;

  it('normal -> failure: a session works, is revoked, and is rejected on the very next request', () => {
    const store = new SessionRevocationStore();
    const { token, claims } = issueSessionToken(TEST_SESSION_SECRET, wallet, { nowMs, ttlSeconds: 300 });

    assert.ok('actor' in actorFromBearer(token, env, nowMs + 1_000, store));
    store.revokeToken(claims.jti, claims.exp * 1000, 'permissions changed', nowMs + 2_000);
    assert.deepEqual(actorFromBearer(token, env, nowMs + 3_000, store), { failure: 'token_revoked' });
  });

  it('retry: revoking twice does not un-revoke or throw', () => {
    const store = new SessionRevocationStore();
    const { token, claims } = issueSessionToken(TEST_SESSION_SECRET, wallet, { nowMs, ttlSeconds: 300 });
    store.revokeToken(claims.jti, claims.exp * 1000, 'first', nowMs);
    const again = store.revokeToken(claims.jti, claims.exp * 1000, 'retry', nowMs + 1);
    assert.equal(again.alreadyRevoked, true);
    assert.deepEqual(actorFromBearer(token, env, nowMs + 2, store), { failure: 'token_revoked' });
  });

  it('authorization: revoking one wallet\'s session does not affect another wallet', () => {
    const store = new SessionRevocationStore();
    const other = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    const a = issueSessionToken(TEST_SESSION_SECRET, wallet, { nowMs, ttlSeconds: 300 });
    const b = issueSessionToken(TEST_SESSION_SECRET, other, { nowMs, ttlSeconds: 300 });
    store.revokeToken(a.claims.jti, a.claims.exp * 1000, 'logout', nowMs);
    assert.ok('actor' in actorFromBearer(b.token, env, nowMs + 1, store));
  });
});

// -- Hidden records -----------------------------------------------------------

interface Row extends Pageable {
  owner: string;
}

const rows = (owner: string, count: number, offset = 0): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${owner}-${String(i + offset).padStart(3, '0')}`,
    sortKey: NOW.getTime() - (i + offset) * 1000,
    owner,
  }));

describe('hidden records contract (paginated reads)', () => {
  const data = [...rows('alice', 6), ...rows('bob', 6, 6)];

  it('normal: a viewer pages only through records they may see', () => {
    const page = paginateStable(data, {
      limit: 10,
      canView: (r) => r.owner === 'alice',
      scope: { viewer: 'alice' },
      secret: SECRET,
    });
    assert.equal(page.items.length, 6);
    assert.ok(page.items.every((r) => r.owner === 'alice'));
    assert.equal(page.hasMore, false);
  });

  it('hidden is indistinguishable from absent: page metadata is identical with or without hidden rows', () => {
    const view = (all: Row[]) =>
      paginateStable(all, { limit: 3, canView: (r) => r.owner === 'alice', scope: { viewer: 'alice' }, secret: SECRET });
    const withHidden = view(data);
    const without = view(data.filter((r) => r.owner === 'alice'));
    assert.deepEqual(withHidden.items, without.items);
    assert.equal(withHidden.hasMore, without.hasMore);
    assert.equal(withHidden.nextCursor, without.nextCursor);
  });

  it('retry: replaying the same cursor returns the same page', () => {
    const opts = { limit: 2, canView: (r: Row) => r.owner === 'alice', scope: { viewer: 'alice' }, secret: SECRET };
    const first = paginateStable(data, opts);
    const a = paginateStable(data, { ...opts, cursor: first.nextCursor });
    const b = paginateStable(data, { ...opts, cursor: first.nextCursor });
    assert.deepEqual(a.items, b.items);
  });

  it('permission change between pages: a record that becomes forbidden is never returned on a later page', () => {
    const revoked = new Set<string>();
    const opts = {
      limit: 2,
      canView: (r: Row) => r.owner === 'alice' && !revoked.has(r.id),
      scope: { viewer: 'alice' },
      secret: SECRET,
    };
    const first = paginateStable(data, opts);
    const nextTarget = rows('alice', 6)[2].id; // would be the first item of page 2
    revoked.add(nextTarget);
    const second = paginateStable(data, { ...opts, cursor: first.nextCursor });
    assert.ok(!second.items.some((r) => r.id === nextTarget));
    assert.equal(second.items.length, 2, 'the page is refilled from visible rows, so the gap does not leak');
  });

  it('failure: a throwing permission check fails closed', () => {
    const page = paginateStable(data, {
      limit: 10,
      canView: () => {
        throw new Error('policy store down');
      },
      scope: { viewer: 'alice' },
      secret: SECRET,
    });
    assert.deepEqual(page.items, []);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
  });

  it('authorization: a cursor minted for one viewer is refused for another', () => {
    const opts = (viewer: string) => ({
      limit: 2,
      canView: (r: Row) => r.owner === viewer,
      scope: { viewer },
      secret: SECRET,
    });
    const { nextCursor } = paginateStable(data, opts('alice'));
    assert.ok(nextCursor);
    assert.throws(
      () => paginateStable(data, { ...opts('bob'), cursor: nextCursor }),
      (err: unknown) => err instanceof InvalidStableCursorError && err.reason === 'scope'
    );
  });
});

describe('hidden records contract (private dispute evidence)', () => {
  const setup = () => {
    const service = new DisputeWorkflowService({ now: () => NOW });
    const dispute = service.open({
      settlementId: 's-1',
      openedBy: 'buyer',
      subject: 'seller',
      invoiceId: 'inv-1',
      reason: 'The settled amount does not match the invoice',
      evidence: [
        { label: 'Public proof', kind: 'transaction', reference: 'tx-public' },
        { label: 'Private doc', kind: 'document', reference: 'doc-private', visibility: 'private' },
      ],
    });
    return { service, id: dispute.id };
  };

  it('normal: the author and a maintainer see private evidence; a third party does not', () => {
    const { service, id } = setup();
    assert.equal(service.get(id, { subject: 'buyer' })!.evidence.length, 2);
    assert.equal(service.get(id, { role: 'maintainer' })!.evidence.length, 2);
    assert.equal(service.get(id, { subject: 'stranger' })!.evidence.length, 1);
    assert.equal(service.get(id, {})!.evidence.length, 1);
  });

  it('authorization: a hidden entry leaks neither its label nor its reference in the projection', () => {
    const { service, id } = setup();
    const json = JSON.stringify(service.get(id, { subject: 'stranger' }));
    assert.ok(!json.includes('Private doc'));
    assert.ok(!json.includes('doc-private'));
  });

  it('retry: projecting twice never mutates the stored record', () => {
    const { service, id } = setup();
    service.get(id, { subject: 'stranger' });
    service.get(id, { subject: 'stranger' });
    assert.equal(service.get(id, { role: 'maintainer' })!.evidence.length, 2);
  });

  it('failure: an unknown dispute id is null for every viewer, including a maintainer', () => {
    const { service } = setup();
    assert.equal(service.get('missing', { role: 'maintainer' }), null);
    assert.equal(service.get('missing', {}), null);
  });
});

describe('hidden records contract (archived invoices)', () => {
  const invoice = {
    id: 'inv-1',
    status: 'PAID',
    version: 3,
    paidAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
    updatedAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
  };
  const make = () =>
    new InvoiceArchiveService({
      storage: { getInvoiceById: async (id: string) => (id === 'inv-1' ? (invoice as never) : null) },
      now: () => NOW,
    });

  it('normal: archiving hides an invoice from the active set but keeps it resolvable', async () => {
    const archive = make();
    await archive.archive('inv-1', { actor: 'ops', reason: 'Quarterly archive of settled invoices' });
    assert.equal(archive.isArchived('inv-1'), true);
    assert.equal(archive.list({ state: 'ARCHIVED' }).length, 1);
    const view = await archive.historicalView('inv-1');
    assert.equal(view.lifecycleState, 'ARCHIVED');
    assert.equal(view.invoice.id, 'inv-1');
  });

  it('retry: a second archive is refused instead of duplicating the record or its history', async () => {
    const archive = make();
    await archive.archive('inv-1', { actor: 'ops', reason: 'Quarterly archive of settled invoices' });
    await assert.rejects(
      archive.archive('inv-1', { actor: 'ops', reason: 'Quarterly archive of settled invoices' }),
      (err: { code?: string }) => err.code === 'ALREADY_ARCHIVED'
    );
    assert.equal(archive.list().length, 1);
    assert.equal(archive.list()[0].history.length, 1);
  });

  it('failure: an unknown invoice is not found and leaves no archive record behind', async () => {
    const archive = make();
    await assert.rejects(
      archive.archive('nope', { actor: 'ops', reason: 'Quarterly archive of settled invoices' }),
      (err: { code?: string }) => err.code === 'INVOICE_NOT_FOUND'
    );
    assert.equal(archive.list().length, 0);
  });

  it('authorization: archive and restore both demand an attributable actor and a reason', async () => {
    const archive = make();
    await assert.rejects(archive.archive('inv-1', { actor: '', reason: 'Quarterly archive of settled invoices' }), (e: { code?: string }) => e.code === 'ACTOR_REQUIRED');
    await assert.rejects(archive.archive('inv-1', { actor: 'ops', reason: 'short' }), (e: { code?: string }) => e.code === 'REASON_REQUIRED');
    await archive.archive('inv-1', { actor: 'ops', reason: 'Quarterly archive of settled invoices' });
    await assert.rejects(archive.restore('inv-1', { actor: '', reason: 'Customer asked for the invoice back' }), (e: { code?: string }) => e.code === 'ACTOR_REQUIRED');
  });
});
