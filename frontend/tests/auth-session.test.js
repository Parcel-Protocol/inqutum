const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, Networks, TransactionBuilder } = require('@stellar/stellar-sdk');
const { AuthRequiredError, createSessionManager, installWalletAuth } = require('../lib/auth-session.ts');

const wallet = Keypair.random();
const WALLET = wallet.publicKey();
const NOW = 1_800_000_000_000;

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    map,
  };
}

function harness(overrides = {}) {
  const state = { wallet: WALLET, now: NOW, signs: 0, exchanges: 0, storage: memoryStorage() };
  const manager = createSessionManager({
    getWallet: () => state.wallet,
    networkPassphrase: Networks.TESTNET,
    now: () => state.now,
    storage: state.storage,
    signChallenge: async (xdr) => {
      state.signs += 1;
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      tx.sign(wallet);
      return tx.toXDR();
    },
    exchange: async () => {
      state.exchanges += 1;
      return {
        token: `token-${state.exchanges}`,
        wallet: state.wallet,
        expiresAt: new Date(state.now + 3_600_000).toISOString(),
      };
    },
    ...overrides,
  });
  return { state, manager };
}

test('signs in once and reuses the session', async () => {
  const { state, manager } = harness();
  const first = await manager.ensure();
  const second = await manager.ensure();
  assert.equal(first.token, 'token-1');
  assert.equal(second.token, 'token-1');
  assert.equal(state.signs, 1);
});

test('concurrent callers share a single wallet prompt', async () => {
  const { state, manager } = harness();
  const [a, b, c] = await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()]);
  assert.equal(state.signs, 1);
  assert.equal(state.exchanges, 1);
  assert.equal(a.token, b.token);
  assert.equal(b.token, c.token);
});

test('asks the wallet to sign a real challenge for the connected account', async () => {
  let seen;
  const { manager } = harness({
    signChallenge: async (xdr) => {
      seen = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      return xdr;
    },
  });
  await manager.ensure();
  assert.equal(seen.source, WALLET);
  assert.equal(seen.sequence, '0');
});

test('signs in again once the session is about to expire', async () => {
  const { state, manager } = harness();
  await manager.ensure();
  state.now += 3_600_000 - 10_000; // inside the 30s safety margin
  assert.equal(manager.current(), null);
  assert.equal((await manager.ensure()).token, 'token-2');
});

test('drops the session when the connected wallet changes', async () => {
  const { state, manager } = harness();
  await manager.ensure();
  state.wallet = Keypair.random().publicKey();
  assert.equal(manager.current(), null);
});

test('refuses to sign in with no wallet connected, without prompting', async () => {
  const { state, manager } = harness();
  state.wallet = null;
  await assert.rejects(() => manager.ensure(), AuthRequiredError);
  assert.equal(state.signs, 0);
});

test('a declined signature leaves no session and allows a retry', async () => {
  let decline = true;
  const { manager } = harness({
    signChallenge: async (xdr) => {
      if (decline) throw new Error('User declined');
      return xdr;
    },
  });
  await assert.rejects(() => manager.ensure(), /declined/);
  assert.equal(manager.current(), null);
  decline = false;
  assert.ok(await manager.ensure());
});

test('restores a stored session across a page reload and forgets it on clear', async () => {
  const { state, manager } = harness();
  await manager.ensure();
  const reloaded = createSessionManager({
    getWallet: () => WALLET,
    networkPassphrase: Networks.TESTNET,
    now: () => state.now,
    storage: state.storage,
    signChallenge: async () => assert.fail('must not prompt'),
    exchange: async () => assert.fail('must not exchange'),
  });
  assert.equal(reloaded.current().token, 'token-1');
  reloaded.clear();
  assert.equal(state.storage.map.size, 0);
  assert.equal(reloaded.current(), null);
});

test('survives unavailable storage', async () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  const { manager } = harness({ storage: broken });
  assert.equal((await manager.ensure()).token, 'token-1');
  assert.equal(manager.current().token, 'token-1');
});

// --- axios wiring ----------------------------------------------------------

function fakeClient(handlers) {
  let onRequest;
  let onResponse;
  let onError;
  const client = {
    interceptors: {
      request: { use: (fn) => { onRequest = fn; } },
      response: { use: (ok, err) => { onResponse = ok; onError = err; } },
    },
    calls: [],
    async request(config) {
      return client.send(config);
    },
    async send(config) {
      const prepared = onRequest({ ...config, headers: { ...config.headers } });
      client.calls.push(prepared);
      const outcome = handlers(prepared);
      if (outcome.status >= 400) {
        return onError({ config: prepared, response: { status: outcome.status, data: outcome.data } });
      }
      return onResponse({ status: outcome.status, data: outcome.data, config: prepared });
    },
  };
  return client;
}

const unauthenticated = { status: 401, data: { code: 'UNAUTHENTICATED' } };

test('attaches the bearer token once a session exists', async () => {
  const { manager } = harness();
  await manager.ensure();
  const client = fakeClient(() => ({ status: 200, data: {} }));
  installWalletAuth(client, manager);
  await client.send({ url: '/invoices', headers: {} });
  assert.equal(client.calls[0].headers.Authorization, 'Bearer token-1');
});

test('sends no credentials before sign-in, so public pages never prompt the wallet', async () => {
  const { state, manager } = harness();
  const client = fakeClient(() => ({ status: 200, data: {} }));
  installWalletAuth(client, manager);
  await client.send({ url: '/invoices/abc', headers: {} });
  assert.equal(client.calls[0].headers.Authorization, undefined);
  assert.equal(state.signs, 0);
});

test('on 401 UNAUTHENTICATED it signs in once and replays the request with the new token', async () => {
  const { state, manager } = harness();
  const client = fakeClient((call) =>
    call.headers.Authorization === 'Bearer token-1' ? { status: 200, data: { ok: true } } : unauthenticated
  );
  installWalletAuth(client, manager);
  const response = await client.send({ url: '/invoices', headers: {} });
  assert.deepEqual(response.data, { ok: true });
  assert.equal(client.calls.length, 2);
  assert.equal(state.signs, 1);
});

test('does not loop: a second 401 after signing in is returned to the caller', async () => {
  const { state, manager } = harness();
  const client = fakeClient(() => unauthenticated);
  installWalletAuth(client, manager);
  await assert.rejects(() => client.send({ url: '/invoices', headers: {} }), (error) => error.response.status === 401);
  assert.equal(client.calls.length, 2);
  assert.equal(state.signs, 1);
});

test('a 403 is not retried and never triggers a wallet prompt', async () => {
  const { state, manager } = harness();
  const client = fakeClient(() => ({ status: 403, data: { code: 'FORBIDDEN' } }));
  installWalletAuth(client, manager);
  await assert.rejects(() => client.send({ url: '/invoices', headers: {} }), (error) => error.response.status === 403);
  assert.equal(client.calls.length, 1);
  assert.equal(state.signs, 0);
});

test('with no wallet connected a 401 is passed through untouched', async () => {
  const { state, manager } = harness();
  state.wallet = null;
  const client = fakeClient(() => unauthenticated);
  installWalletAuth(client, manager);
  await assert.rejects(() => client.send({ url: '/invoices', headers: {} }), (error) => error.response.data.code === 'UNAUTHENTICATED');
  assert.equal(client.calls.length, 1);
});
