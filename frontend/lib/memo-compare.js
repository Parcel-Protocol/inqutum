/**
 * Memo comparison spec (issue #7).
 *
 * Stellar memos have five types and Horizon reports the type next to the value
 * (`memo_type` + `memo`). A memo is only equal when the TYPE and the VALUE
 * agree, so a `MEMO_ID` or `MEMO_HASH` whose string form looks like an expected
 * `MEMO_TEXT` value never matches.
 *
 * | type     | value form (Horizon JSON)     | comparison rule                                        |
 * |----------|-------------------------------|--------------------------------------------------------|
 * | `none`   | absent / null                 | matches only another `none`                            |
 * | `text`   | UTF-8 string                  | exact string equality: no trim, no case folding, no    |
 * |          |                               | Unicode normalization. An empty expected text never    |
 * |          |                               | matches.                                               |
 * | `id`     | unsigned 64-bit decimal       | numeric equality (`"5"`, `"05"`, `5` are equal); must  |
 * |          | string (or safe integer)      | be digits only and <= 2^64-1; anything else is invalid |
 * | `hash`   | 32 bytes, base64 (Horizon)    | byte equality after decoding; the expected side may    |
 * | `return` | or 64 hex chars               | also be hex; must decode to exactly 32 bytes           |
 *
 * Anything else (unknown or missing type, invalid value) does not match. The
 * comparison is deliberately strict: it decides whether money settles an invoice.
 *
 * `backend/src/utils/memo-compare.ts` is the authority; this file mirrors it line for line and both are
 * tested against `shared/memo-fixtures.json`, so drift fails a test.
 */

const MEMO_TYPES = ['none', 'text', 'id', 'hash', 'return'];
const UINT64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** True when `type` is one of the five Horizon memo types (case-sensitive). */
function isMemoType(type) {
  return typeof type === 'string' && MEMO_TYPES.includes(type);
}

/** Parse a `MEMO_ID` value to a bigint, or null when it is not a valid uint64. */
function parseMemoId(value) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return null;
  }
  if (!/^[0-9]+$/.test(text)) return null;
  const id = BigInt(text);
  return id <= UINT64_MAX ? id : null;
}

/** Decode a 32-byte `MEMO_HASH`/`MEMO_RETURN` value (base64 or hex) to lowercase hex. */
function decodeMemoHash(value) {
  if (typeof value !== 'string') return null;
  if (HEX_32_BYTES.test(value)) return value.toLowerCase();
  if (!BASE64_32_BYTES.test(value)) return null;
  let bits = '';
  for (const char of value.slice(0, 43)) {
    bits += BASE64_ALPHABET.indexOf(char).toString(2).padStart(6, '0');
  }
  // 43 chars = 258 bits: the trailing 2 bits are padding and must be zero.
  if (bits.slice(256) !== '00') return null;
  let hex = '';
  for (let i = 0; i < 256; i += 8) {
    hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Whether an observed memo satisfies the memo an invoice requires. */
function memosMatch(expected, actual) {
  if (!isMemoType(expected && expected.type) || !isMemoType(actual && actual.type)) return false;
  if (expected.type !== actual.type) return false;

  switch (expected.type) {
    case 'none':
      return true;
    case 'text':
      return (
        typeof expected.value === 'string' &&
        expected.value !== '' &&
        typeof actual.value === 'string' &&
        expected.value === actual.value
      );
    case 'id': {
      const want = parseMemoId(expected.value);
      const got = parseMemoId(actual.value);
      return want !== null && got !== null && want === got;
    }
    case 'hash':
    case 'return': {
      const want = decodeMemoHash(expected.value);
      const got = decodeMemoHash(actual.value);
      return want !== null && got !== null && want === got;
    }
    default:
      return false;
  }
}

/**
 * Shape a Horizon transaction's memo for `memosMatch`. Horizon always sends
 * `memo_type`; a memo without one is treated as unknown rather than guessed.
 */
function horizonMemo(transaction) {
  return {
    type: (transaction && transaction.memo_type) || null,
    value: transaction && transaction.memo != null ? transaction.memo : null,
  };
}

module.exports = { isMemoType, parseMemoId, decodeMemoHash, memosMatch, horizonMemo };
