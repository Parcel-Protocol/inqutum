# Development Guide

## Prerequisites

- Node.js 20+
- npm

## Setup

```bash
# Backend
cd backend && npm ci

# Frontend
cd frontend && npm ci
```

## Running checks

```bash
# Backend
cd backend
npm run typecheck
npm test
npm run release:check

# Frontend
cd frontend
npm run lint
npm run typecheck
npm test
```

## Boundary contracts

The frontend has hardened contract modules for critical boundaries with defined
success, validation, retry, and degraded-dependency behavior:

- `frontend/lib/dashboard-history-contract.js` — Dashboard data scoping and
  ownership validation (issue #232). Uses stable error codes (INVALID_KEY,
  MALFORMED_DATA, OWNER_MISMATCH, DEGRADED) shared by MVP and persistent paths.

When modifying these contracts, update their corresponding test files to
preserve regression coverage.

## CI

CI runs on every push and pull request targeting `dev` or `main`.
Pull requests must target `dev`. See [CONTRIBUTING.md](CONTRIBUTING.md).

