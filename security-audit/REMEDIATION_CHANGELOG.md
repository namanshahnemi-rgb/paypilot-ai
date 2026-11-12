# PayPilot AI: Remediation Changelog

Every change made during the security audit, in three rounds. Nothing was committed, pushed or deployed, and no Git commands were run.

**Unchanged in all rounds:**
- the fixed USD 5.00 Sandbox amount, the currency, the `CAPTURE` intent, and the PayPal order-creation request body;
- dependency versions: none added, upgraded or removed. Round 3 only moved `better-sqlite3` from `dependencies` to `devDependencies`, at the same version;
- live Render and Cloudflare settings.

No existing test was removed or weakened. Where a test's PayPal fake or request helper had to learn the new approval check or checkout token, its assertions stayed the same.

---

## Round 3 (11 November 2026)

A limited round after the owner's PP-18 actions. Copies of every file changed in this round were saved in the session scratchpad (`audit-backup/round3/`) before editing.

### Owner actions (owner-reported, 11 November 2026)

These are recorded as the owner reported them. I did not perform or observe them.
- Rotated the PayPal Sandbox client secret and disabled the old one.
- Updated the local `server/.env` and Render's environment variables.
- Redeployed the backend and completed a USD 5.00 Sandbox checkout.
- Ran `git gc --prune=now`.

### Verified independently (11 November 2026)

- **Git object store:** no loose objects; one packfile; 4 commits; 73 blobs, all referenced by a commit. No secret pattern, and no current `.env` value, appears in any object. No `.env` file is in any commit or in the index. PP-18 is therefore closed.
- **Render's Sandbox credentials:** `GET /api/payments/health` returned `authenticated: true`.
- **Production code:** still the pre-audit code (`X-Powered-By: Express`, no security headers). The redeploy carried only the new credentials.

### New files

| File | What it does | Finding |
| --- | --- | --- |
| `server/tsconfig.build.json` | Production build config: compiles only `src/index.ts` and its imports, so `dist/` has no tests and no SQLite modules | PP-27 |
| `server/src/providerErrors.test.ts` | 22 tests: Gemini-mode AI errors have no Ollama or local-model wording, status codes match in both modes, and Ollama mode keeps its instructions | PP-30 |
| `client/public/_headers` | Cloudflare static-asset headers: CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS | PP-17 |

### Modified files

- **`server/package.json`**
  - `better-sqlite3` moved to `devDependencies`, at the same `^13.0.3`.
  - `build` is now `tsc -p tsconfig.build.json`.
  - `test` also runs `providerErrors.test.ts`.
  - Finding: PP-27.
- **`server/package-lock.json`**
  - Regenerated with `npm install --package-lock-only --ignore-scripts`. 4 lines changed: the root manifest's entry moved, and `better-sqlite3` and `node-addon-api` gained `"dev": true`. No versions changed.
  - Finding: PP-27.
- **`server/src/localModel.ts`**
  - New `FailureResponse` type and `failureFor`, which picks the Ollama wording only in Ollama mode.
  - Finding: PP-30.
- **`server/src/analysis.ts`, `proposalGenerator.ts`, `riskReview.ts`**
  - The failure tables are now provider-neutral; a separate `OLLAMA_FAILURES` table keeps the previous local wording, used through `failureFor`.
  - Status codes and retries are unchanged.
  - Finding: PP-30.
- **`server/src/productionImports.test.ts`**
  - One new test: `better-sqlite3` is only a development dependency, the build compiles only from `src/index.ts`, and no test is reachable from it. The header comment was updated.
  - Finding: PP-27.
- **`server/Dockerfile`**
  - Comment only: `better-sqlite3` is a development dependency that the `prod-deps` stage removes.
  - Finding: PP-27.
- **`Jenkinsfile`**
  - New `IMAGE_CONTENTS_CHECK` binding, which the Image smoke test stage runs in the runtime image. It fails the build if `better-sqlite3` resolves, or if `dist/` holds a test or a SQLite module.
  - The header comment was updated.
  - Finding: PP-27.
- **`README.md`**
  - Build note: `tsconfig.build.json` versus the full type check.
  - Unit-test note: the SQLite registry is a development dependency.
  - `VITE_API_URL` note: keep `connect-src` in `client/public/_headers` in step.
  - Frontend security-headers bullet.
  - Findings: PP-17, PP-27.
- **`security-audit/*.md`** (all five)
  - PP-18 recorded as remediated, with owner-reported and verified facts kept apart.
  - PP-27, PP-30 and PP-17 recorded as fixed.
  - Round-3 results.

### Consistency review

| File | Result |
| --- | --- |
| `server/.env.example` | Consistent; no change needed. The README environment block still matches it exactly (compared by script). |
| `Jenkinsfile` | The type check still uses `tsconfig.json`, so tests stay type-checked; `npm run build` picks up the new build config automatically. Only the image contents check was added. |
| `README.md` | Updated as listed above. |
| `DEPLOYMENT_READINESS.md` | Updated: the PP-18 gate item is removed, a production-state note and the frontend header check are added. |

### Round 3 verification

| Check | Result |
| --- | --- |
| Server type check, unit tests, build | pass, 219/219, pass (19 modules in `dist/`) |
| Integration tests (local database, and inside the image) | 22/22 and 22/22 |
| Server unit tests inside the image | 219/219 |
| Client type check, tests, lint, build | pass, 84/84, 1 existing warning and 0 errors, pass |
| `npm audit` (both packages) | 0 vulnerabilities |
| Docker build; runtime image contents check (`sh` and `bat`); smoke test; SIGTERM exit code | pass; pass (the build image correctly fails it); 11/11; 0 |
| Production import boundary tests | 3/3 (part of the unit run) |
| Frontend CSP in headless Chrome | no violations; a broken-policy control is detected |
| Jenkinsfile Groovy compile | pass |
| Mutation check (PP-30) | the old wording fails 2 tests |

---

## Round 2

### New files

| File | What it does | Why | Finding |
| --- | --- | --- | --- |
| `server/src/checkoutToken.ts` | Creates 256-bit checkout tokens, hashes them (SHA-256), validates their format and compares them in constant time | Binds an order to the tab that created it | PP-07 |
| `server/src/orderModel.ts` | Order types, `isValidOrderID`, `toOrderView` and a shared `captureUpdate` mapping (now with `NOT_APPROVED` and `VOIDED`), free of database code | Shared by both registries; keeps the SQLite driver out of production | PP-08, PP-16 |
| `server/src/config.ts` | `parseClientOrigins` (exact origins only) and `readPayPalBaseUrl` (Sandbox only) | Configuration mistakes could silently break CORS or point at live PayPal | PP-22, PP-23 |
| `server/src/healthCache.ts` | A 60-second, shared cache for health checks | Health checks called PayPal or Gemini on every request | PP-20 |
| `server/scripts/smoke-test.mjs` | Read-only API smoke test, with an opt-in check of the 415 rule | Jenkins image smoke test and post-deploy check | CI |
| `server/src/paymentOwnership.test.ts` | 16 tests: cross-session capture and read, token validation, no ID probing, legacy orders, no token leak, token randomness, capture before approval (each unapproved status, cancel, void, already captured, failed check), concurrency | Regression tests for PP-07 and PP-08 | PP-07, PP-08 |
| `server/src/config.test.ts` | 6 tests for origin and PayPal URL validation and the health cache | Regression tests | PP-20, PP-22, PP-23 |
| `server/src/databaseFailure.test.ts` | Database outage with no database: fast, generic JSON errors; no password in logs; no capture attempted | Database reliability | PP-03, PP-21 |
| `server/src/productionImports.test.ts` | Import-graph checks: production never loads SQLite; AI modules can't reach payment code | Regression tests | PP-16, AI isolation |
| `security-audit/DEPLOYMENT_READINESS.md` | Deployment status, configuration, Jenkins setup, manual checks, verdict | Required deliverable | |

### Modified files

#### Server

- **`server/src/paypalCapture.ts`**
  - `CaptureResult` gains `NOT_APPROVED` and `VOIDED`.
  - `capturePayPalOrder` first `GET`s the order and sends the capture only when PayPal reports `APPROVED`. An order that is already `COMPLETED` is evaluated without capturing again, and a failed check returns `STATUS_UNKNOWN`.
  - New `lookupTimeoutMs` (default 10 s) for the order lookups.
  - The capture request, its stable request ID and the amount checks are unchanged.
  - Finding: PP-08.
- **`server/src/paymentRoutes.ts`**
  - Capture requires `checkoutToken` in the body, and a status lookup requires the `X-Checkout-Token` header.
  - A missing or malformed token gets `400`; a wrong token gets the same `404` as an unknown order.
  - Imports from `orderModel.ts`.
  - Findings: PP-07, PP-16.
- **`server/src/checkoutRoute.ts`**
  - Creates a checkout token, registers the order with the token's hash, and returns `checkoutToken`. The token is never logged.
  - Finding: PP-07.
- **`server/src/orderRegistry.ts`** (SQLite, tests)
  - Stores `checkout_token_hash` and uses the shared `captureUpdate`.
  - Re-exports the `orderModel.ts` helpers, so test imports didn't change.
  - Findings: PP-07, PP-16.
- **`server/src/database.ts`**
  - Adds the `checkout_token_hash` column, plus a version-2 migration for older SQLite files.
  - Finding: PP-07.
- **`server/src/postgresOrderRegistry.ts`**
  - **Token column:** stores `checkout_token_hash` and uses the shared `captureUpdate`.
  - **Timeouts and keep-alive:** the pool defaults to `query_timeout` 20 s and TCP keep-alive. The advisory-lock wait has its own limit (`lockTimeoutMs` + 5 s). A connection whose query timed out is discarded instead of rolled back on.
  - **Schema setup:** `initialize()` runs in an explicit transaction with `lock_timeout` 10 s and `statement_timeout` 30 s. It runs the version-2 `ALTER TABLE` only when the column is missing, and records migration 2.
  - Findings: PP-07, PP-21.
- **`server/src/securityMiddleware.ts`**
  - New `corsOptions`: only `GET` and `POST`, only `Content-Type` and `X-Checkout-Token`, a 10-minute preflight cache, no credentials.
  - Finding: PP-02.
- **`server/src/index.ts`**
  - **Configuration:** uses `parseClientOrigins` and `readPayPalBaseUrl` (exits if the URL is not Sandbox), and `corsOptions`.
  - **AI limits:** a new global per-minute rule (`AI_REQUESTS_PER_MINUTE`, default 5) and a daily default of 100; per-client create-order raised from 10 to 20 per 10 minutes, for judging.
  - **Health checks:** the PayPal, Gemini and Ollama checks now return results and are cached for 60 seconds.
  - **Startup:** logs the effective configuration, without secrets.
  - Findings: PP-19, PP-20, PP-22, PP-23.
- **`server/Dockerfile`**
  - Stages are now `build`, `prod-deps` and `runtime`. The `build` stage is used by CI for the tests.
  - `CMD ["node", "dist/index.js"]`.
  - A `HEALTHCHECK` on `/api/health`.
  - The UTF-8 byte-order mark was removed.
  - Findings: PP-09, PP-26.
- **`server/.dockerignore`**
  - The byte-order mark was removed; logs, `reports/` and `.vscode/` are excluded.
  - Finding: PP-26.
- **`server/.env.example`**
  - Documents the Sandbox-only `PAYPAL_BASE_URL`, the exact-origin `CLIENT_ORIGINS`, `AI_REQUESTS_PER_MINUTE` and `AI_DAILY_REQUEST_LIMIT` (placeholders only).
- **`server/package.json`**
  - The `test` script also runs the 4 new test files. No dependency changes.

#### Server tests (adapted; no assertion removed)

| File | Change |
| --- | --- |
| `server/src/paypalCapture.test.ts` | The helper answers the new status check (`APPROVED` by default) and asserts it happens exactly once, first, as a `GET`. |
| `server/src/orderRegistry.test.ts` | The fake answers the status check, counted separately so `requests()` keeps its meaning. Helpers register with a token hash and send the token. The record shape includes `checkoutTokenHash`; a new assertion checks that only the hash is stored. |
| `server/src/gracefulShutdown.test.ts` | The capture request sends a checkout token. |
| `server/src/checkoutRoute.test.ts` | The response includes `checkoutToken` (format checked); only the hash is stored; the token is not logged. |
| `server/src/securityMiddleware.test.ts` | Uses `corsOptions`. Two new tests: a preflight permits only `GET`/`POST` and two headers, with no credentials; look-alike origins are never reflected. |
| `server/src/postgresOrderRegistry.integration.test.ts` | The fake answers the status check. Expected columns and migrations updated. Five new tests: query timeout, a lock wait longer than the query timeout, token hash persistence, capture before approval across instances, legacy-table upgrade. |

#### Client

- **`client/src/paymentFlow.ts`**
  - Adds checkout-token storage helpers: `readSavedCheckout`, `saveCheckout` and `forgetCheckout`, plus a token-format check and the header name.
  - Finding: PP-07.
- **`client/src/App.tsx`**
  - **Checkout token:** stores the token with the order ID, sends it on capture (body) and on status lookups (header), and clears both when the checkout is cancelled or the order is unknown.
  - **Other tabs:** a tab without the token is told to start a new checkout.
  - **Double clicks:** a `useRef` guard blocks duplicate checkout or capture requests.
  - Findings: PP-07, PP-24.
- **`client/src/paymentFlow.test.ts`**
  - 5 new tests: token format; saved checkout requires both parts; forget; unavailable storage; the token never appears in a URL.

#### Root

- **`Jenkinsfile`**, rewritten:
  - **Agents:** Linux or Windows, through a `run` helper.
  - **CI stages:** a new type-check stage; unit tests, lint, builds and audit as before.
  - **Image stages** (`BUILD_IMAGE`): Docker image build; integration tests inside the image against a throwaway PostgreSQL; image smoke test, including the clean SIGTERM exit.
  - **Publish:** GHCR publishing (`PUBLISH_IMAGE`, `main` only, credential `ghcr-publish`).
  - **Deploy:** Render deploy after manual approval (`DEPLOY_TO_RENDER`, credential `render-deploy-hook`), then a read-only production smoke test.
  - **Cleanup:** after every build.
  - No credentials are in the file.
- **`README.md`**
  - The environment block matches `.env.example`.
  - Checkout-token and approval-check bullets in "PayPal Sandbox".
  - Migration and timeout notes in "Database".
  - "About 50 seconds" for a worst-case capture.
  - New limits table and Gemini quota guidance.
  - The CORS-is-not-authentication note.
  - The Continuous Integration section rewritten.
- **`security-audit/*.md`**: rewritten to match the code.

### Round 2 verification

| Check | Result |
| --- | --- |
| Server type check, unit tests, build | pass, 196/196, pass |
| Integration tests (local database and inside the image) | 22/22 and 22/22 |
| Client type check, tests, lint, build | pass, 84/84, 1 existing warning, pass |
| `npm audit` (both packages) | 0 vulnerabilities |
| Docker build, smoke test (11 checks), SIGTERM exit code | pass, 11/11, 0 |
| Jenkinsfile Groovy compile | pass (Jenkins class names aside) |
| Mutation checks | ownership (2 tests fail), approval (6), import boundary (1) |

Copies of every file changed in round 2 were saved in the session scratchpad (`audit-backup/`) before editing.

---

## Round 1 (summary)

| File | Change | Finding |
| --- | --- | --- |
| `server/src/rateLimit.ts` (new) + test | In-memory limiter: per-client and global rules, `429` with `Retry-After`, memory cap, `TRUST_PROXY` | PP-01 |
| `server/src/securityMiddleware.ts` (new) + test | Security headers; 403 for disallowed origins; 415 for non-JSON writes; JSON 404 | PP-02, PP-05 |
| `server/src/checkoutRoute.ts` (new) + test | create-order moved out of `index.ts` for testing; approval-URL check; fixed return origin | PP-04 |
| `server/src/aiSecurity.test.ts` (new) | Prompt injection, secret isolation, invented values dropped, HTML kept as text | AI checks |
| `client/src/paymentFlow.ts` (new) + test | Redirect allowlist; PayPal return decisions; success display rule | PP-04 |
| `server/src/index.ts` | Limiters, middleware order, `x-powered-by` off, Ollama health timeout, checkout router | PP-01, PP-02, PP-05, PP-06 |
| `server/src/postgresOrderRegistry.ts` + integration test | 15-second connection timeout | PP-03 |
| `server/src/paypalCapture.test.ts` | Currency and amount tampering test | |
| `client/src/App.tsx` | Approval-URL check; helpers from `paymentFlow.ts` | PP-04 |
| `server/package.json`, `server/.env.example`, `README.md` | New tests registered; `TRUST_PROXY` and AI limit documented | |
