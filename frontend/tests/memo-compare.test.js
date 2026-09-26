const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { memosMatch, horizonMemo, decodeMemoHash, parseMemoId, isMemoType } = require('../lib/memo-compare');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../shared/memo-fixtures.json'), 'utf8'),
);

for (const c of fixture.cases) {
  test(`memo fixture: ${c.name}`, () => {
    assert.equal(memosMatch(c.expected, c.actual), c.match);
  });
}

test('horizonMemo maps memo_type/memo and never guesses a missing type', () => {
  assert.deepEqual(horizonMemo({ memo: 'INV-1', memo_type: 'text' }), { type: 'text', value: 'INV-1' });
  assert.deepEqual(horizonMemo({ memo: 'INV-1' }), { type: null, value: 'INV-1' });
  assert.deepEqual(horizonMemo(null), { type: null, value: null });
});

test('helpers reject malformed input', () => {
  assert.equal(isMemoType('TEXT'), false);
  assert.equal(parseMemoId(1.5), null);
  assert.equal(parseMemoId(-1), null);
  assert.equal(decodeMemoHash(42), null);
  assert.equal(decodeMemoHash('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQF='), null);
});
