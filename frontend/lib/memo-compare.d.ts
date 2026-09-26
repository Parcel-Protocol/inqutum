export type MemoType = 'none' | 'text' | 'id' | 'hash' | 'return';

export interface MemoValue {
  type?: string | null;
  value?: string | number | null;
}

export function isMemoType(type: unknown): type is MemoType;
export function parseMemoId(value: unknown): bigint | null;
export function decodeMemoHash(value: unknown): string | null;
export function memosMatch(expected: MemoValue, actual: MemoValue): boolean;
export function horizonMemo(
  transaction: { memo?: string | null; memo_type?: string | null } | null | undefined,
): MemoValue;
