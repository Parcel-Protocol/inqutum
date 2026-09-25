# Accessibility

The primary workflow (landing → create invoice → invoice detail → pay page →
dashboard) targets WCAG 2.1 AA for keyboard use, screen readers, visible focus
and form errors.

## Automated checks

`eslint-plugin-jsx-a11y` (recommended rules) runs as part of the frontend lint,
so CI fails on unlabelled form controls, invalid ARIA, click handlers on
non-interactive elements and similar static issues:

```bash
cd frontend
npm run lint
node --test tests/invoice-form-validation.test.js   # inline form error rules
```

Static linting cannot see focus order, contrast or live announcements, so run
the manual pass below for any change to these screens.

## Conventions

- **Landmarks:** every page renders one `<main id="main-content">` and one
  `<h1>`. The first Tab stop is the "Skip to main content" link from
  `app/layout.tsx`.
- **Labels:** every input has a `<label htmlFor>`. When there is no visible
  label, use `aria-label`. Icon buttons whose text is hidden on small screens
  use `sr-only sm:not-sr-only`, not `hidden sm:inline`, so they keep an
  accessible name.
- **Form errors:** validation lives in `lib/invoice-form-validation.js`. Invalid
  fields get `aria-invalid="true"` and `aria-describedby` pointing at a
  `.field-error` paragraph. On submit, focus moves to the first invalid field.
  Toasts are only for outcomes (created / failed), not field validation.
- **Focus:** `*:focus-visible` draws a solid `--teal` ring (≥3:1 against paper
  and white). Do not remove it with `outline: none` without a replacement.
- **Contrast:** white text sits on `--teal` (#0f766e, ~5.5:1), not on
  `cyan-500` (~2.4:1, fails AA).
- **Toggle buttons:** filter chips expose `aria-pressed`.

## Manual verification

Run `npm run dev` in `frontend/` (the MVP backend or mock API is fine) and check:

1. **Keyboard only:** from page load, Tab once. The skip link appears, and Enter
   moves focus into the main content. Tab through the create form, submit, open
   the invoice, and reach the pay page actions without a mouse. Every focused
   element shows the teal ring.
2. **Form errors:** submit the create form with an empty amount and
   `client@` as the client email. Focus lands on the amount field. The screen
   reader announces the field as invalid, followed by its error text. Fix the
   amount and resubmit. Focus moves to the client email field.
3. **Screen reader (VoiceOver: Ctrl+Opt+U, NVDA: Insert+F7):** the headings list
   starts with one h1 per page. The landmarks list includes `main`. Dashboard
   filter buttons are announced as "toggle button, pressed" / "not pressed".
4. **Zoom:** at 200% browser zoom, no content is clipped and nothing needs
   horizontal scrolling on the create form.
5. **Contrast spot check:** use DevTools' contrast picker on any new colour
   pairing. Text needs ≥4.5:1. Focus rings and borders need ≥3:1.
