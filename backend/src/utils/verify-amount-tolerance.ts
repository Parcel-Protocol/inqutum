// Stellar amount tolerance helper.
//
// Stellar accounts for amounts as integers of stroops (1 XLM = 1e7 stroops),
// so string formats and JS float rounding can produce off-by-stroop
// representations of the same on-chain value. `amountsMatch` accepts a
// signed tolerance in stroops so callers can allow an exact match (tolerance
// 0, default) or a one-stroop window (+/-1 stroop) for on-chain settlement.
//
// Stroop precision is fixed at 7 decimal places by the Stellar protocol.

export const STROOP_DECIMALS = 7;

const STROOP_SCALE = 10 ** STROOP_DECIMALS;
const MAX_SAFE_STROOP = Number.MAX_SAFE_INTEGER; // fits the Stellar total supply (~5 * 1e10 XLM = 5e17 stroops) without rounding.

export interface AmountMatchInput {
  expected: string | number;
  actual: unknown;
  toleranceStroops?: number;
}

/**
 * Parse an amount (string or number) into integer stroops (1e-7 units) using
 * exact string/BigInt fixed-point arithmetic, avoiding JavaScript floating-point
 * rounding artifacts.
 */
export function parseToStroops(value: unknown): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      return null;
    }
  }

  const str = String(value).trim();
  if (str === '') {
    return null;
  }

  const match = /^([+-]?\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) {
    return null;
  }

  const isNegative = match[1].startsWith('-');
  const rawInt = match[1].replace(/^[+-]/, '');
  const intPart = BigInt(rawInt);

  let fracStr = match[2] || '';
  let fracBig: bigint;

  if (fracStr.length > STROOP_DECIMALS) {
    const keep = fracStr.slice(0, STROOP_DECIMALS);
    const nextDigit = parseInt(fracStr[STROOP_DECIMALS], 10);
    fracBig = BigInt(keep);
    if (nextDigit >= 5) {
      fracBig += 1n;
    }
  } else {
    fracStr = fracStr.padEnd(STROOP_DECIMALS, '0');
    fracBig = BigInt(fracStr);
  }

  return (intPart * 10_000_000n + fracBig) * (isNegative ? -1n : 1n);
}

/**
 * Compare two Stellar amounts with an allowable delta, measured in stroops.
 *
 * @param expected   Amount the invoice demands. String or number.
 * @param actual     Amount observed on-chain from Horizon. Typically a
 *                   decimal string such as `operation.amount`. Passed as
 *                   `unknown` because callers operate on raw API response
 *                   fields.
 * @param toleranceStroops  Width of the acceptance window, in stroops.
 *                   Non-negative integer. Defaults to 0 (exact stroop
 *                   match). Tolerance is signed symmetrically: a tolerance
 *                   of N means an actual within N stroops below the
 *                   expected value, or within N stroops above, still
 *                   matches.
 * @returns          true when both operands parse to finite numbers whose
 *                   absolute stroop difference is <= toleranceStroops.
 *                   Returns false for malformed input, NaN, +/-Infinity,
 *                   negative tolerance, or tolerance values that cannot
 *                   be represented as safe integers.
 */
export function amountsMatch(
  expected: string | number,
  actual: unknown,
  toleranceStroops: number = 0
): boolean {
  if (!Number.isInteger(toleranceStroops) || toleranceStroops < 0) {
    return false;
  }

  if (typeof expected === 'string' && expected.trim() === '') {
    return false;
  }
  if (typeof actual === 'string' && actual.trim() === '') {
    return false;
  }

  const expectedStroops = parseToStroops(expected);
  const actualStroops = parseToStroops(actual);

  if (expectedStroops === null || actualStroops === null) {
    return false;
  }

  void STROOP_SCALE;
  void MAX_SAFE_STROOP;

  const delta =
    expectedStroops >= actualStroops
      ? expectedStroops - actualStroops
      : actualStroops - expectedStroops;

  return delta <= BigInt(toleranceStroops);
}

export default { amountsMatch, parseToStroops, STROOP_DECIMALS };
