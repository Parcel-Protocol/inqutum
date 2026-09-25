/**
 * Untrusted-content hardening (issue #54).
 *
 * Policy, applied consistently:
 *  - Plain-text fields (descriptions, names) are STRIPPED of HTML tags, control
 *    characters and bidirectional-override characters at the API boundary. They
 *    are still escaped again wherever they are rendered (defence in depth).
 *  - External URLs are REJECTED unless they are plain http(s) without embedded
 *    credentials. `javascript:`, `data:`, `vbscript:`, `file:` and
 *    `user:pass@host` (misleading-link) forms never pass.
 *  - API responses carry restrictive security headers.
 */

import type { NextFunction, Request, Response } from 'express';

// C0/C1 controls (keeping \t \n \r for multiline), zero-width chars and BOM.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‍⁠﻿]/g;
// Bidi embeddings/overrides/isolates can visually reorder text to mislead.
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;
// A tag start is `<` immediately followed by a letter, `/`, `!` or `?`.
// Bare comparisons such as "a < b" are left alone.
const HTML_TAG = /<[a-zA-Z\/!?][^>]*>?/g;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

export interface SanitizeOptions {
  /** Keep line breaks (descriptions). Otherwise all whitespace runs collapse to one space. */
  multiline?: boolean;
}

/** Removes markup, control and bidi characters. Returns '' for non-strings. */
export function sanitizePlainText(input: unknown, options: SanitizeOptions = {}): string {
  if (typeof input !== 'string') return '';

  let text = input.normalize('NFC').replace(CONTROL_CHARS, '').replace(BIDI_CONTROLS, '');

  // Repeat until stable so nested payloads like "<<b>script>" cannot re-form a tag.
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(HTML_COMMENT, '').replace(HTML_TAG, '');
  }

  text = options.multiline
    ? text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    : text.replace(/\s+/g, ' ');
  return text.trim();
}

export interface SafeUrlOptions {
  /** Permit plain http (local development). Defaults to https only. */
  allowHttp?: boolean;
}

/**
 * Returns the normalised URL if it is a safe external link, otherwise null.
 * Rejects non-http(s) schemes, embedded credentials, control characters and
 * empty hosts.
 */
export function safeHttpUrl(value: unknown, options: SafeUrlOptions = {}): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[\u0000-\u001F\u007F\s\\]/.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const allowed = options.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol)) return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.toString();
}

/**
 * Payment links are built from FRONTEND_URL. Only its validated origin is used,
 * so a malformed or hostile value can never inject a scheme, credentials or path.
 */
export function safeFrontendOrigin(value: unknown, fallback = 'http://localhost:3000'): string {
  const safe = safeHttpUrl(value, { allowHttp: true });
  return safe ? new URL(safe).origin : fallback;
}

/** Restrictive headers for a JSON API that never serves HTML. */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-site',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction) => {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) res.setHeader(name, value);
    res.removeHeader('X-Powered-By');
    next();
  };
}
