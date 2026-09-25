const configured = process.env.DEPLOY_API_URL || process.argv[2];
if (!configured) {
  console.error('Usage: DEPLOY_API_URL=https://your-api.example/api node scripts/deploy-smoke.mjs');
  process.exit(1);
}

const baseUrl = configured.replace(/\/+$/, '');

// Creating an invoice needs a wallet session. The smoke check signs in with a
// throwaway keypair, so it exercises the real sign-in path on the deployment
// without any credentials being configured. The challenge transaction has
// sequence 0 and is never submitted, so the key needs no funds.
import { createRequire } from 'node:module';
const { Account, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder } = createRequire(
  new URL('../backend/package.json', import.meta.url)
)('@stellar/stellar-sdk');
const WALLET_CHALLENGE_OP_NAME = 'inqutum auth'; // keep in step with shared/wallet-auth.ts

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const health = await request('/health');
if (health.status !== 'ok') throw new Error('Health endpoint did not return status=ok');

const readiness = await request('/ready');
if (readiness.status !== 'ready' || readiness.ready !== true) {
  throw new Error('Readiness endpoint did not confirm ready=true');
}

const wallet = Keypair.random();
const sellerPublicKey = wallet.publicKey();
const networkPassphrase = health.network === 'PUBLIC' ? Networks.PUBLIC : Networks.TESTNET;
const now = Math.floor(Date.now() / 1000);
const challenge = new TransactionBuilder(new Account(sellerPublicKey, '-1'), {
  fee: BASE_FEE,
  networkPassphrase,
  timebounds: { minTime: now, maxTime: now + 120 },
})
  .addOperation(Operation.manageData({ name: WALLET_CHALLENGE_OP_NAME, value: Keypair.random().rawPublicKey() }))
  .build();
challenge.sign(wallet);

const session = await request('/auth/session', {
  method: 'POST',
  body: JSON.stringify({ transaction: challenge.toXDR() }),
});
const token = session?.data?.token;
if (!token || session.data.wallet !== sellerPublicKey) throw new Error('Wallet sign-in contract failed');

const anonymous = await fetch(`${baseUrl}/invoices?sellerPublicKey=${sellerPublicKey}`);
if (anonymous.status !== 401) {
  throw new Error(`Listing invoices without credentials returned ${anonymous.status}, expected 401`);
}

const created = await request('/invoices', {
  method: 'POST',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    amount: 0.01,
    assetCode: 'XLM',
    description: `Deploy smoke ${new Date().toISOString()}`,
    sellerPublicKey,
  }),
});
const invoice = created?.data?.invoice;
if (!invoice?.id || invoice.status !== 'PENDING') throw new Error('Create invoice contract failed');

const fetched = await request(`/invoices/${invoice.id}`);
if (fetched?.data?.id !== invoice.id) throw new Error('Created invoice could not be read back');

console.log(`Deploy smoke passed: ${baseUrl} (${invoice.id})`);
