/**
 * User-facing service status (#381).
 *
 * The API publishes `GET /status`, a sanitized view of which features are
 * degraded or unavailable. This module is the only place the browser interprets
 * it. The payload crosses a trust boundary, so it is re-validated here rather
 * than rendered as received: unknown states are dropped, text is length-capped
 * and always rendered as text, never as markup.
 *
 * Pure and dependency-free so the contract is testable without React.
 */

const STATES = ['operational', 'degraded', 'unavailable', 'unknown'];
const MAX_TEXT = 300;
const MAX_FEATURES = 20;
const MAX_RETRY_SECONDS = 3600;

const asText = (value) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT) : '';

/**
 * @param {unknown} payload the `data` member of the `/status` response
 * @returns {{overall: string, summary: string, stale: boolean, features: Array<{capability: string, label: string, state: string, message: string, retryAfterSeconds: number|null}>} | null}
 *   null when the payload is not a usable status (callers show nothing)
 */
function parseServiceStatus(payload) {
  if (!payload || typeof payload !== 'object' || !STATES.includes(payload.overall) || !Array.isArray(payload.features)) {
    return null;
  }
  const features = [];
  for (const raw of payload.features.slice(0, MAX_FEATURES)) {
    if (!raw || typeof raw !== 'object' || !STATES.includes(raw.state)) continue;
    const label = asText(raw.label);
    const capability = asText(raw.capability);
    if (!label || !capability) continue;
    const retry = Number.isFinite(raw.retryAfterSeconds) && raw.retryAfterSeconds > 0
      ? Math.min(Math.floor(raw.retryAfterSeconds), MAX_RETRY_SECONDS)
      : null;
    features.push({ capability, label, state: raw.state, message: asText(raw.message), retryAfterSeconds: retry });
  }
  return {
    overall: payload.overall,
    summary: asText(payload.summary),
    stale: payload.stale === true,
    features,
  };
}

/**
 * What to show the user, or null when nothing is wrong (or we do not know).
 * `unavailable` outranks `degraded`; the banner severity follows the worst item.
 */
function describeServiceStatus(status) {
  if (!status) return null;
  const issues = status.features.filter((f) => f.state === 'degraded' || f.state === 'unavailable');
  if (issues.length === 0) return null;
  const severity = issues.some((f) => f.state === 'unavailable') ? 'unavailable' : 'degraded';
  const retries = issues.map((f) => f.retryAfterSeconds).filter((n) => n !== null);
  return {
    severity,
    title: severity === 'unavailable' ? 'Some features are temporarily unavailable' : 'Some features are running slowly',
    summary: status.summary,
    stale: status.stale,
    retryAfterSeconds: retries.length > 0 ? Math.max(...retries) : null,
    issues: issues
      .slice()
      .sort((a, b) => (a.state === b.state ? 0 : a.state === 'unavailable' ? -1 : 1))
      .map((f) => ({ capability: f.capability, label: f.label, state: f.state, message: f.message })),
  };
}

/** Is this one capability unavailable right now? Used to disable a button with a reason. */
function capabilityBlocked(status, capability) {
  const found = status?.features.find((f) => f.capability === capability);
  return found && found.state === 'unavailable' ? { blocked: true, message: found.message } : { blocked: false, message: '' };
}

/** "about 30 seconds" / "about 2 minutes" for a retry hint. */
function formatRetryAfter(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `about ${Math.ceil(seconds)} second${Math.ceil(seconds) === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

module.exports = { parseServiceStatus, describeServiceStatus, capabilityBlocked, formatRetryAfter };
