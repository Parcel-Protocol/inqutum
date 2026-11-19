/**
 * Accessibility coverage for async error recovery (#371).
 *
 * Exercises the rendered live regions (`PayStatusRegion`) and async retry UI
 * (`ApiErrorState`) in a real JSDOM + axe-core environment across:
 *  - Normal path: silent baseline on load, polite progress updates, focus handoff on settle
 *  - Failure path: assertive alert announcement, synchronous/async retry rejection recovery
 *  - Retry path: busy state with aria-disabled (preserving focus), repeat-click guard,
 *    "Attempt N." re-announcement on repeated failure, and full recovery to paid/resolved
 *  - Authorization path: Freighter wallet authorization denial & missing-wallet guidance
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundle, installDom, getDom, render, runAxe, formatViolations } = require('./support/a11y-harness');

installDom();

const React = require('react');
const { act } = React;
const bundle = loadBundle();
const { PAY_STATES } = require('../lib/payment-page-state');
const { WALLET_ERRORS } = require('../lib/payment-button-contract');
const { PAY_STATUS_REGION_IDS, PAY_FOCUS_IDS } = require('../lib/pay-status-a11y');

const SAMPLE_INVOICE = {
  id: 'inv_a11y_async_1',
  amount: 25,
  assetCode: 'USDC',
  status: 'PENDING',
  memo: 'QT-A11Y-1',
  sellerPublicKey: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
};

function assertNoViolations(violations, label) {
  assert.equal(violations.length, 0, `${label} has axe violation(s):\n${formatViolations(violations)}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function PayRegionHarness({ state }) {
  return React.createElement(
    'main',
    { id: 'main-content' },
    React.createElement('h1', null, 'Pay Invoice'),
    React.createElement(bundle.PayStatusRegion, { state }),
    state.status === PAY_STATES.PAID
      ? React.createElement('section', { id: PAY_FOCUS_IDS.proof, tabIndex: -1 }, 'Payment Proof Ready')
      : React.createElement('button', { type: 'button', id: 'pay-btn' }, 'Pay')
  );
}

test('normal path: PayStatusRegion is silent on initial load, announces polite transitions, and moves focus on settle', async () => {
  const initialState = { status: PAY_STATES.IDLE, invoice: SAMPLE_INVOICE };
  const { container, rerender, unmount } = await render(
    React.createElement(PayRegionHarness, { state: initialState })
  );

  try {
    const polite = container.querySelector(`#${PAY_STATUS_REGION_IDS.polite}`);
    const assertive = container.querySelector(`#${PAY_STATUS_REGION_IDS.assertive}`);

    assert.equal(polite.getAttribute('role'), 'status');
    assert.equal(polite.getAttribute('aria-live'), 'polite');
    assert.equal(polite.hasAttribute('aria-busy'), false);
    assert.equal(assertive.getAttribute('role'), 'alert');
    assert.equal(assertive.hasAttribute('aria-busy'), false);
    assert.equal(polite.textContent, '', 'initial load must be a silent baseline');
    assert.equal(assertive.textContent, '');

    await rerender(React.createElement(PayRegionHarness, { state: { status: PAY_STATES.VERIFYING, invoice: SAMPLE_INVOICE } }));
    assert.match(polite.textContent, /Verifying the transaction/);
    assert.equal(assertive.textContent, '');

    await rerender(React.createElement(PayRegionHarness, { state: { status: PAY_STATES.PAID, invoice: SAMPLE_INVOICE } }));
    assert.match(polite.textContent, /Payment verified/);
    assert.equal(assertive.textContent, '');
    assert.equal(getDom().window.document.activeElement?.id, PAY_FOCUS_IDS.proof);
    assertNoViolations(await runAxe(container), 'PayStatusRegion normal settled state');
  } finally {
    unmount();
  }
});

test('failure and retry path: PayStatusRegion announces Attempt N on repeated failure and clears on recovery', async () => {
  const { container, rerender, unmount } = await render(
    React.createElement(PayRegionHarness, { state: { status: PAY_STATES.IDLE, invoice: SAMPLE_INVOICE } })
  );

  try {
    const polite = container.querySelector(`#${PAY_STATUS_REGION_IDS.polite}`);
    const assertive = container.querySelector(`#${PAY_STATUS_REGION_IDS.assertive}`);

    await rerender(
      React.createElement(PayRegionHarness, {
        state: { status: PAY_STATES.ERROR, invoice: SAMPLE_INVOICE, error: 'Horizon timeout' },
      })
    );
    assert.equal(polite.textContent, '');
    assert.equal(assertive.textContent, 'Horizon timeout.');
    assertNoViolations(await runAxe(container), 'PayStatusRegion initial error');

    await rerender(
      React.createElement(PayRegionHarness, {
        state: { status: PAY_STATES.ERROR, invoice: SAMPLE_INVOICE, error: 'Horizon timeout' },
      })
    );
    assert.equal(assertive.textContent, 'Horizon timeout. Attempt 2.');

    await rerender(
      React.createElement(PayRegionHarness, { state: { status: PAY_STATES.VERIFYING, invoice: SAMPLE_INVOICE } })
    );
    assert.equal(assertive.textContent, '');
    assert.match(polite.textContent, /Verifying the transaction/);

    await rerender(
      React.createElement(PayRegionHarness, { state: { status: PAY_STATES.PAID, invoice: SAMPLE_INVOICE } })
    );
    assert.equal(assertive.textContent, '');
    assert.match(polite.textContent, /Payment verified/);
    assert.equal(getDom().window.document.activeElement?.id, PAY_FOCUS_IDS.proof);
  } finally {
    unmount();
  }
});

test('authorization path: PayStatusRegion announces wallet denial with recovery guidance and recovers on retry', async () => {
  const { container, rerender, unmount } = await render(
    React.createElement(PayRegionHarness, { state: { status: PAY_STATES.IDLE, invoice: SAMPLE_INVOICE } })
  );

  try {
    const polite = container.querySelector(`#${PAY_STATUS_REGION_IDS.polite}`);
    const assertive = container.querySelector(`#${PAY_STATUS_REGION_IDS.assertive}`);

    await rerender(
      React.createElement(PayRegionHarness, {
        state: { status: PAY_STATES.ERROR, invoice: SAMPLE_INVOICE, error: WALLET_ERRORS.ACCESS_DENIED },
      })
    );
    assert.match(assertive.textContent, /Freighter access was denied/);
    assert.match(assertive.textContent, /Approve Quittance in Freighter/);
    assertNoViolations(await runAxe(container), 'PayStatusRegion wallet authorization error');

    await rerender(
      React.createElement(PayRegionHarness, { state: { status: PAY_STATES.PAYING, invoice: SAMPLE_INVOICE } })
    );
    assert.equal(assertive.textContent, '');
    assert.match(polite.textContent, /Waiting for you to confirm/);
  } finally {
    unmount();
  }
});

test('ApiErrorState recovers cleanly when onRetry throws synchronously or resolves after async retry', async () => {
  let shouldThrow = true;
  const pending = deferred();
  const onRetry = () => {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error('Sync failure');
    }
    return pending.promise;
  };

  const { container, unmount } = await render(
    React.createElement(
      'main',
      { id: 'main-content' },
      React.createElement('h1', null, 'Invoice'),
      React.createElement(bundle.ApiErrorState, { message: 'API down', onRetry })
    )
  );

  try {
    const button = container.querySelector('button');
    button.focus();

    await act(async () => button.click());
    assert.equal(button.getAttribute('aria-busy'), 'false', 'sync throw must reset busy state');
    assert.equal(button.getAttribute('aria-disabled'), 'false');
    assert.equal(getDom().window.document.activeElement, button);

    await act(async () => button.click());
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(getDom().window.document.activeElement, button);

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    assert.equal(button.getAttribute('aria-busy'), 'false');
    assertNoViolations(await runAxe(container), 'ApiErrorState after async retry recovery');
  } finally {
    unmount();
  }
});
