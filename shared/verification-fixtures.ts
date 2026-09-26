/**
 * Versioned, comprehensive verification test fixtures covering every branch
 * of the payment verification contract in exact precedence order (Issue #39).
 *
 * Contract Precedence Order:
 * 1. Transaction Hash (`MISSING_TX_HASH`, `INVALID_TX_HASH`)
 * 2. Network (`NETWORK_MISMATCH`)
 * 3. Payment Operation (`NO_PAYMENT_OPERATION`)
 * 4. Memo (`MEMO_MISMATCH`)
 * 5. Destination (`DESTINATION_MISMATCH`)
 * 6. Amount (`AMOUNT_MISMATCH`)
 * 7. Asset (`ASSET_MISMATCH`)
 */

import type { VerificationCode } from './verification';

export const SELLER_PK = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const PAYER_PK = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
export const OTHER_PK = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
export const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const OTHER_ISSUER = 'GDMQUQ566DHP43EXMMN7HVOZ5TYZ5RUXPY7LBLFTH6DK3XW5E37T7PFR';

export const VALID_TX_HASH = '1111111111111111111111111111111111111111111111111111111111111111';
export const ALT_TX_HASH = '2222222222222222222222222222222222222222222222222222222222222222';

export interface VerificationFixture {
  name: string;
  description: string;
  expectedOutcome: 'pass' | 'fail';
  expectedCode?: VerificationCode;
  txHash: unknown;
  network?: string;
  expected: {
    memo: string;
    amount: string | number;
    destination: string;
    assetCode: string;
    assetIssuer?: string;
    network?: string;
  };
  transaction: {
    memo?: string | null;
    memo_type?: string | null;
    created_at?: string | null;
  };
  operations: Array<{
    type: string;
    from?: string;
    to?: string;
    amount?: string;
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
    dest_amount?: string;
    dest_asset_type?: string;
    dest_asset_code?: string;
    dest_asset_issuer?: string;
  }>;
}

export const VERIFICATION_FIXTURES: VerificationFixture[] = [
  // 0. Happy Path (Native XLM)
  {
    name: 'happy_path_native_xlm',
    description: 'Valid transaction with matching hash, network, payment op, memo, destination, amount, and native XLM asset',
    expectedOutcome: 'pass',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: {
      memo: 'QUIT-1001',
      memo_type: 'text',
      created_at: '2026-09-20T12:00:00Z',
    },
    operations: [
      {
        type: 'payment',
        from: PAYER_PK,
        to: SELLER_PK,
        amount: '100.0000000',
        asset_type: 'native',
      },
    ],
  },

  // 0b. Happy Path (Credit Asset USDC)
  {
    name: 'happy_path_credit_usdc',
    description: 'Valid transaction with matching credit asset (USDC) and issuer',
    expectedOutcome: 'pass',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1002',
      amount: '50.0000000',
      destination: SELLER_PK,
      assetCode: 'USDC',
      assetIssuer: USDC_ISSUER,
      network: 'TESTNET',
    },
    transaction: {
      memo: 'QUIT-1002',
      memo_type: 'text',
      created_at: '2026-09-20T12:00:00Z',
    },
    operations: [
      {
        type: 'payment',
        from: PAYER_PK,
        to: SELLER_PK,
        amount: '50.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUER,
      },
    ],
  },

  // Stage 1a: Missing Transaction Hash
  {
    name: 'stage_1a_missing_tx_hash',
    description: 'Empty or missing transaction hash is rejected at stage 1',
    expectedOutcome: 'fail',
    expectedCode: 'MISSING_TX_HASH',
    txHash: '   ',
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [{ type: 'payment', from: PAYER_PK, to: SELLER_PK, amount: '100.0000000', asset_type: 'native' }],
  },

  // Stage 1b: Invalid Transaction Hash Format
  {
    name: 'stage_1b_invalid_tx_hash',
    description: 'Malformed transaction hash (non-hex or wrong length) is rejected at stage 1',
    expectedOutcome: 'fail',
    expectedCode: 'INVALID_TX_HASH',
    txHash: '1111not-a-valid-hex-hash1111',
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [{ type: 'payment', from: PAYER_PK, to: SELLER_PK, amount: '100.0000000', asset_type: 'native' }],
  },

  // Stage 2: Network Mismatch
  {
    name: 'stage_2_network_mismatch',
    description: 'Observed network differs from expected invoice network',
    expectedOutcome: 'fail',
    expectedCode: 'NETWORK_MISMATCH',
    txHash: VALID_TX_HASH,
    network: 'PUBLIC',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [{ type: 'payment', from: PAYER_PK, to: SELLER_PK, amount: '100.0000000', asset_type: 'native' }],
  },

  // Stage 3: No Payment Operation
  {
    name: 'stage_3_no_payment_operation',
    description: 'Transaction contains non-payment operations only',
    expectedOutcome: 'fail',
    expectedCode: 'NO_PAYMENT_OPERATION',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [
      { type: 'manage_data', from: PAYER_PK },
      { type: 'change_trust', from: PAYER_PK },
    ],
  },

  // Stage 4: Memo Mismatch
  {
    name: 'stage_4_memo_mismatch',
    description: 'Transaction memo differs from expected invoice memo',
    expectedOutcome: 'fail',
    expectedCode: 'MEMO_MISMATCH',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-WRONG-MEMO' },
    operations: [{ type: 'payment', from: PAYER_PK, to: SELLER_PK, amount: '100.0000000', asset_type: 'native' }],
  },

  // Stage 5: Destination Mismatch
  {
    name: 'stage_5_destination_mismatch',
    description: 'Payment delivered to an unexpected account instead of the seller wallet',
    expectedOutcome: 'fail',
    expectedCode: 'DESTINATION_MISMATCH',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [{ type: 'payment', from: PAYER_PK, to: OTHER_PK, amount: '100.0000000', asset_type: 'native' }],
  },

  // Stage 6: Amount Mismatch
  {
    name: 'stage_6_amount_mismatch',
    description: 'Paid amount does not match expected invoice amount',
    expectedOutcome: 'fail',
    expectedCode: 'AMOUNT_MISMATCH',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [{ type: 'payment', from: PAYER_PK, to: SELLER_PK, amount: '99.0000000', asset_type: 'native' }],
  },

  // Stage 7: Asset Mismatch (Code or Issuer)
  {
    name: 'stage_7_asset_mismatch_code',
    description: 'Paid in native XLM when credit asset USDC was expected',
    expectedOutcome: 'fail',
    expectedCode: 'ASSET_MISMATCH',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'USDC',
      assetIssuer: USDC_ISSUER,
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [{ type: 'payment', from: PAYER_PK, to: SELLER_PK, amount: '100.0000000', asset_type: 'native' }],
  },
  {
    name: 'stage_7_asset_mismatch_issuer',
    description: 'Paid with USDC from a rogue/unexpected issuer',
    expectedOutcome: 'fail',
    expectedCode: 'ASSET_MISMATCH',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'USDC',
      assetIssuer: USDC_ISSUER,
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [
      {
        type: 'payment',
        from: PAYER_PK,
        to: SELLER_PK,
        amount: '100.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: OTHER_ISSUER,
      },
    ],
  },

  // --- Strict Ordering Proof Fixtures (Multiple Errors) ---

  // Order Proof 1: Invalid Hash (Check 1) shadows Wrong Network (Check 2)
  {
    name: 'order_proof_invalid_hash_shadows_wrong_network',
    description: 'When tx hash is invalid AND network is wrong, MUST fail with INVALID_TX_HASH first',
    expectedOutcome: 'fail',
    expectedCode: 'INVALID_TX_HASH',
    txHash: 'invalid-hash-123',
    network: 'PUBLIC',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [{ type: 'payment', from: PAYER_PK, to: SELLER_PK, amount: '100.0000000', asset_type: 'native' }],
  },

  // Order Proof 2: Wrong Network (Check 2) shadows No Payment Op (Check 3)
  {
    name: 'order_proof_wrong_network_shadows_no_payment_op',
    description: 'When network is wrong AND no payment op exists, MUST fail with NETWORK_MISMATCH first',
    expectedOutcome: 'fail',
    expectedCode: 'NETWORK_MISMATCH',
    txHash: VALID_TX_HASH,
    network: 'PUBLIC',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [{ type: 'manage_data', from: PAYER_PK }],
  },

  // Order Proof 3: No Payment Op (Check 3) shadows Wrong Memo (Check 4)
  {
    name: 'order_proof_no_payment_op_shadows_wrong_memo',
    description: 'When no payment op exists AND memo is wrong, MUST fail with NO_PAYMENT_OPERATION first',
    expectedOutcome: 'fail',
    expectedCode: 'NO_PAYMENT_OPERATION',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-WRONG' },
    operations: [{ type: 'manage_data', from: PAYER_PK }],
  },

  // Order Proof 4: Wrong Memo (Check 4) shadows Wrong Destination (Check 5)
  {
    name: 'order_proof_wrong_memo_shadows_wrong_destination',
    description: 'When memo is wrong AND destination is wrong, MUST fail with MEMO_MISMATCH first',
    expectedOutcome: 'fail',
    expectedCode: 'MEMO_MISMATCH',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-WRONG' },
    operations: [{ type: 'payment', from: PAYER_PK, to: OTHER_PK, amount: '100.0000000', asset_type: 'native' }],
  },

  // Order Proof 5: Wrong Destination (Check 5) shadows Wrong Amount (Check 6)
  {
    name: 'order_proof_wrong_destination_shadows_wrong_amount',
    description: 'When destination is wrong AND amount is wrong, MUST fail with DESTINATION_MISMATCH first',
    expectedOutcome: 'fail',
    expectedCode: 'DESTINATION_MISMATCH',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [{ type: 'payment', from: PAYER_PK, to: OTHER_PK, amount: '1.0000000', asset_type: 'native' }],
  },

  // Order Proof 6: Wrong Amount (Check 6) shadows Wrong Asset (Check 7)
  {
    name: 'order_proof_wrong_amount_shadows_wrong_asset',
    description: 'When amount is wrong AND asset is wrong, MUST fail with AMOUNT_MISMATCH first',
    expectedOutcome: 'fail',
    expectedCode: 'AMOUNT_MISMATCH',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'USDC',
      assetIssuer: USDC_ISSUER,
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001' },
    operations: [{ type: 'payment', from: PAYER_PK, to: SELLER_PK, amount: '1.0000000', asset_type: 'native' }],
  },

  // --- Real-world Edge Cases ---

  // Edge Case 1: Multi-operation transaction with leading non-payment ops followed by valid payment
  {
    name: 'edge_case_multi_op_with_leading_data_op',
    description: 'Finds payment operation even when preceded by manage_data and bump_sequence ops',
    expectedOutcome: 'pass',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001', created_at: '2026-09-20T12:00:00Z' },
    operations: [
      { type: 'manage_data', from: PAYER_PK },
      { type: 'payment', from: PAYER_PK, to: SELLER_PK, amount: '100.0000000', asset_type: 'native' },
    ],
  },

  // Edge Case 2: Path payment strict receive delivering exact expected amount and asset
  {
    name: 'edge_case_path_payment_strict_receive',
    description: 'Path payment strict receive successfully satisfies invoice payment requirements',
    expectedOutcome: 'pass',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001', created_at: '2026-09-20T12:00:00Z' },
    operations: [
      {
        type: 'path_payment_strict_receive',
        from: PAYER_PK,
        to: SELLER_PK,
        amount: '100.0000000',
        asset_type: 'native',
      },
    ],
  },

  // Edge Case 3: Path payment strict send delivering exact destination amount
  {
    name: 'edge_case_path_payment_strict_send',
    description: 'Path payment strict send delivering exact dest_amount satisfies invoice',
    expectedOutcome: 'pass',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100.0000000',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001', created_at: '2026-09-20T12:00:00Z' },
    operations: [
      {
        type: 'path_payment_strict_send',
        from: PAYER_PK,
        to: SELLER_PK,
        amount: '150.0000000', // source amount
        dest_amount: '100.0000000', // destination amount received
        dest_asset_type: 'native',
      },
    ],
  },

  // Edge Case 4: Stroop precision equivalence (100 vs 100.0000000)
  {
    name: 'edge_case_precision_integer_vs_seven_decimals',
    description: 'Numeric or unpadded string amount is matched with 7-decimal stroop precision',
    expectedOutcome: 'pass',
    txHash: VALID_TX_HASH,
    network: 'TESTNET',
    expected: {
      memo: 'QUIT-1001',
      amount: '100',
      destination: SELLER_PK,
      assetCode: 'XLM',
      network: 'TESTNET',
    },
    transaction: { memo: 'QUIT-1001', created_at: '2026-09-20T12:00:00Z' },
    operations: [
      {
        type: 'payment',
        from: PAYER_PK,
        to: SELLER_PK,
        amount: '100.0000000',
        asset_type: 'native',
      },
    ],
  },
];
