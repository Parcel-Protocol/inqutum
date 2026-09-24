const test = require('node:test');
const assert = require('node:assert/strict');
const { LANDING_BULLETS, renderLandingBullets } = require('../lib/landing-feature-bullets.js');
const { landingFeatureBulletsFixture } = require('./fixtures/landing-feature-bullets.fixture.js');

test('landing feature bullets keeps the canonical bullet order and copy', () => {
  assert.deepEqual(renderLandingBullets(), LANDING_BULLETS);
  assert.deepEqual(
    renderLandingBullets().map(({ n, title }) => ({ n, title })),
    landingFeatureBulletsFixture
  );
});
