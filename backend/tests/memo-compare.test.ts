import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { memosMatch, horizonMemo, decodeMemoHash, parseMemoId, isMemoType } from '../src/utils/memo-compare';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '../../shared/memo-fixtures.json'), 'utf8'),
) as { cases: Array<{ name: string; expected: any; actual: any; match: boolean }> };

for (const c of fixture.cases) {
  test(`memo fixture: ${c.name}`, () => {
    assert.equal(memosMatch(c.expected, c.actual), c.match);
  });
}

test('fixture covers every memo type and type confusion', () => {
  const names = fixture.cases.map((c) => c.name).join('\n');
  for (const prefix of ['text:', 'id:', 'hash:', 'return:', 'none:', 'type confusion:']) {
    assert.match(names, new RegExp(prefix));
  }
});

test('horizonMemo maps memo_type/memo and never guesses a missing type', () => {
  assert.deepEqual(horizonMemo({ memo: 'INV-1', memo_type: 'text' }), { type: 'text', value: 'INV-1' });
  assert.deepEqual(horizonMemo({ memo: 'INV-1' }), { type: null, value: 'INV-1' });
  assert.deepEqual(horizonMemo(null), { type: null, value: null });
});

test('helpers reject malformed input', () => {
  assert.equal(isMemoType('TEXT'), false);
  assert.equal(parseMemoId(1.5), null);
  assert.equal(parseMemoId(-1), null);
  assert.equal(parseMemoId(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(parseMemoId({}), null);
  assert.equal(decodeMemoHash(42), null);
  // Non-zero padding bits are not a canonical encoding of 32 bytes.
  assert.equal(decodeMemoHash('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQF='), null);
});
