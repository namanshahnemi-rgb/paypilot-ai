# PayPilot AI: Security Test Plan and Results

All automated tests mock PayPal and the AI model. They use no credentials and create no Sandbox orders.

The PostgreSQL integration tests ran in two places:
- against the local Docker database (`127.0.0.1`, checked before running). They only write rows with their own `ITEST-<random>` prefix, plus one private schema that they drop, and delete only those rows;
- inside the built Docker image, against a throwaway `postgres:17-alpine` container on a private Docker network, which was removed afterwards.

Every result below was actually run: rounds 1 and 2 on 10 November 2026, round 3 on 11 November 2026 after its changes.

## 1. Results

| Suite | Command | Round 1 final | Round 2 final | **Round 3 final** |
| --- | --- | --- | --- | --- |
| Server type check (every file, tests included) | `cd server && npx tsc --noEmit -p .` | pass | pass | **pass** |
| Server unit | `cd server && npm test` | 169 / 169 | 196 / 196 | **219 / 219** |
| Server unit inside the Docker build image (Linux) | `docker run … npm test` | not run | 196 / 196 | **219 / 219** |
| PostgreSQL integration (local database) | `cd server && npm run test:integration` | 17 / 17 | 22 / 22 | **22 / 22** |
| PostgreSQL integration inside the image (fresh database) | see section 3 | not run | 22 / 22 | **22 / 22** |
| Server production build | `cd server && npm run build` (now `tsc -p tsconfig.build.json`) | pass | pass | **pass**: 19 modules, no tests, no SQLite modules |
| Client type check | `cd client && npx tsc -b` | pass | pass | **pass** |
| Client unit | `cd client && npm test` | 79 / 79 | 84 / 84 | **84 / 84** |
| Client lint | `cd client && npm run lint` | 1 existing warning | same | **same 1 warning** (`set-state-in-effect`, existing; no errors) |
| Client production build | `cd client && npm run build` | pass | pass | **pass**, and `dist/` contains `_headers` |
| Dependency audit | `npm audit` (both packages) | not run | 0 vulnerabilities | **0 vulnerabilities** |
| Docker build (build and runtime stages) | `docker build` | not run | pass | **pass** |
| Runtime image contents (Jenkins check, `sh` and `bat` quoting) | `docker run … node -e "<IMAGE_CONTENTS_CHECK>"` | not run | not run | **pass**; the build image correctly fails it |
| Image smoke test | `node scripts/smoke-test.mjs` (in a container) | not run | 11 / 11 checks | **11 / 11 checks** |
| Container stops cleanly on SIGTERM | `docker stop` + exit code | not run | exit code 0 | **exit code 0** |
| Frontend CSP in headless Chrome | section 3b | not run | not run | **0 violations**; the broken-policy control is detected |
| Git object secret scan (loose and packed) | section 4 | working tree only | loose objects | **no findings** |
| Jenkinsfile syntax | `groovyc` in `groovy:4.0-jdk17` (with the Jenkins-only class `hudson.AbortException` replaced) | not run | compiles | **compiles** |

**Round 3 totals:** 325 automated tests (219 + 22 + 84), all passed. None failed and none were skipped. Round 3 added 23 server unit tests: 22 in `providerErrors.test.ts` and 1 in `productionImports.test.ts`. Round 2 had added 37.

**Mutation checks** (each protection removed temporarily, then the file restored and checked):

| Mutation | Result |
| --- | --- |
| Capture route skips the ownership check (round 2) | 2 tests fail |
| Capture skips the approval check (round 2) | 6 tests fail |
| Payment routes import the SQLite module again (round 2) | the import-boundary test fails |
| Server approval-URL validation removed (round 1) | the test fails |
| Analysis puts the old "Check that Ollama is running" wording back in the shared messages (round 3) | 2 tests fail |
| Contents check run on the build image, which has `better-sqlite3` (round 3) | the check fails with "better-sqlite3 is installed" |
| CSP without Google Fonts and the API origin (round 3) | Chrome reports the font stylesheet and the API call as blocked |

## 2. Coverage by requirement

"R3" means added in round 3; "new" means added in round 2; "R1" means added in round 1; "existing" means it was already in the repository. Every listed test passes.

| Requirement | Tests |
| --- | --- |
| Repeated checkout requests | each checkout gets its own order and request ID (`checkoutRoute.test.ts`, R1); client double-click guard (code review, PP-24) |
| Duplicate capture or replay | repeat checks never call PayPal again (`orderRegistry.test.ts`, existing); repeats after payment make no PayPal request (`paymentOwnership.test.ts`, new) |
| Concurrent capture | simultaneous requests share one call (existing); three simultaneous captures of an approved order make one capture (new); two instances (integration, existing) |
| Invalid order IDs | malformed IDs and objects get `400` (existing) |
| Amount and currency manipulation | the server fixes USD 5.00 (R1); 9 tampered capture amounts and currencies are never paid (R1); a mismatch → `NEEDS_REVIEW` (existing) |
| **Cross-session order access** | another session's token can't capture or read; a missing or malformed token, an object or the hash itself → `400`; a wrong token and an unknown order answer identically; legacy orders are refused; responses never contain the token or hash (`paymentOwnership.test.ts`, new) |
| **Capture before approval** | an unapproved order, captured 3 times, sends no capture request and stays `CREATED`, then captures with the stable ID once approved; `CREATED`, `SAVED` and `PAYER_ACTION_REQUIRED` are each refused; `VOIDED` → `FAILED`; already `COMPLETED` → paid without recapturing; a failed status check sends nothing (new); across two instances (integration, new) |
| Cancelled checkout | the client never captures on `?payment=cancel` (R1); a cancelled order (still `CREATED` at PayPal) is never captured (new) |
| Forged return URL | a mismatched token or missing saved order → no capture (R1); a saved checkout needs both a valid order ID and a valid token (new, client) |
| AI prompt injection | the brief stays user content; no secrets reach the model; invented values and extra fields such as `paid` are dropped; HTML stays text (`aiSecurity.test.ts`, R1); no AI module can reach payment, checkout or database code (`productionImports.test.ts`, new) |
| Rate-limit exhaustion | 8 limiter tests (R1); `429` with `Retry-After` from the real server (R1 local run); health checks cached, so at most one upstream call per minute (new) |
| CORS rejection | foreign origins `403`; a preflight from a foreign origin gets no permission (R1); only `GET`/`POST` and two headers are allowed, with no credentials; look-alike origins are never reflected (new); a foreign origin is refused in the image smoke test (new) |
| CLIENT_ORIGINS and PAYPAL_BASE_URL validation | `config.test.ts` (new) |
| Database connection failures | outage → fast, generic JSON errors on status, capture and create-order, and the password is never logged (`databaseFailure.test.ts`, new); pool exhaustion fails fast (integration, R1) |
| Query timeouts and transaction safety | a query past `query_timeout` fails and the pool recovers; a lock wait longer than the query timeout still succeeds (integration, new); a lost connection mid-capture rolls back and releases the lock; the lock-hold limit is enforced (integration, existing) |
| Schema migration | upgrading a version-1 table adds `checkout_token_hash` and keeps its rows, in a private schema (integration, new); a fresh database (in-image run) |
| Restart persistence | integration (existing); the token hash persists and is never replaced (new) |
| Graceful shutdown | 13 unit tests (existing); container `SIGTERM` exit code 0 (new) |
| Image contents | no `.env` file or `data/` folder; non-root `node` user (manual inspection, round 2); no `better-sqlite3`, no compiled tests and no SQLite modules in the runtime image (Jenkins contents check, R3) |
| Production dependencies and build | `better-sqlite3` is only a development dependency; the build compiles only from `src/index.ts` (`productionImports.test.ts`, R3) |
| AI error wording per provider (PP-30) | Gemini-mode errors for analysis, drafting and review never mention Ollama or a local model; status codes are the same in both modes; Ollama mode keeps its local instructions; Gemini without a key → `503` (`providerErrors.test.ts`, R3) |
| Frontend security headers (PP-17) | the CSP in `client/public/_headers` loads the real app with no violations in headless Chrome; a broken policy is detected (R3, section 3b) |

## 3. Container rehearsal of the Jenkins stages

Run by hand with the same commands the Jenkinsfile uses:
Last run on 11 November 2026 (round 3):
1. `docker build --target build` and `docker build` (the runtime image).
2. `npm test` inside the build image: **219/219**.
3. A private network and `postgres:17-alpine` with `POSTGRES_HOST_AUTH_METHOD=trust` and no published ports.
4. `npm run test:integration` inside the build image, with `DATABASE_URL` pointing at that container: **22/22**.
5. The Jenkinsfile's `IMAGE_CONTENTS_CHECK`, extracted from the file and run in the runtime image with `sh` quoting and through a Windows `.cmd` file (`bat` quoting): both print "Runtime image contents OK: 19 modules, no SQLite driver, no tests." The same check on the build image fails, as it should.
6. The runtime image started with placeholder PayPal values; `SMOKE_ALLOW_POST=1 node scripts/smoke-test.mjs`: **11/11** checks:
   - health `200`, security headers, no `X-Powered-By`;
   - CORS allows the configured origin;
   - a foreign origin gets `403` and no CORS header;
   - an order lookup without a token gets `400`;
   - a JSON `404`;
   - a non-JSON POST gets `415`.
7. `docker stop -t 15`: the exit code is **0**.
8. All containers, the network and the images created for the rehearsal were removed afterwards. The owner's own containers were not touched.

The startup log showed the effective configuration (origins, Sandbox, provider, AI limits, trust proxy) and no secrets.

## 3b. Frontend CSP check (round 3)

1. Built the client into the scratchpad with `VITE_API_URL=http://127.0.0.1:4598`.
2. Served it from `127.0.0.1:4597` with exactly the headers in `client/public/_headers`. Only the API origin in `connect-src` was replaced with the stub's.
3. A stub API on `127.0.0.1:4598` answered `GET /api/health`. Nothing was sent to production.
4. Loaded the page in headless Chrome with console logging.
   - **Result:** the app rendered with the "CLOUD AI · GEMINI" badge (so the API call was allowed), and Chrome logged no CSP violation.
5. Control: the same run with `fonts.googleapis.com` and the API origin removed from the policy.
   - **Result:** Chrome logged both as blocked, so violations are detected.

This covers the page load, the API connection and the fonts. The click-through of analyze, draft, review and checkout on the deployed site is in M-9.

## 4. Secret scan (Git object store)

Gitleaks and TruffleHog were not installed, so a scanner was written for this audit.
- **How it ran (round 2):** it read every loose object in `.git/objects` with zlib (2,184 objects; no packfiles at the time) and mapped blobs to file paths through the tree objects. It ran no Git commands.
- **What it checks:**
  - Gitleaks-style patterns: Google API keys, PayPal client IDs, secrets and tokens, Postgres URLs with passwords, assignments to secret variables, GitHub tokens, AWS keys, private keys and JWTs;
  - whether any `.env` file was ever committed;
  - whether the current `server/.env` values appear anywhere. Those values were compared in memory only; only key names and object IDs were printed.

**Round 2 results:**
- No `.env` file was ever committed, and none of the 4 commits contains a secret.
- Four unreferenced blobs contained the then-current Sandbox `PAYPAL_CLIENT_ID`, and one also the then-current `PAYPAL_CLIENT_SECRET` (PP-18).
- The other matches were false positives: a Windows `.exe`, the dotenv README's samples, and a vitest fixture.

**Round 3 rescan (11 November 2026)**, after the owner reported rotating the secret and running `git gc --prune=now`:
- **Method:** a new read-only scanner also parses packfiles and resolves deltas. Same rules as round 2, plus the Git index, and the current `.env` values compared in memory.
- **Store state:** no loose objects remain. The one packfile holds 92 objects, all resolved, with the parse ending exactly at the pack checksum.
- **References:** 4 commits and 73 blobs, every blob referenced by a commit. No unreferenced blob is left.
- **Secrets:** no pattern findings. None of the current `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `GEMINI_API_KEY` or `DATABASE_URL` values is in any object.
- **Old blobs gone:** the client ID, which a secret rotation does not change and which all four old blobs held, appears nowhere.
- **No `.env` tracked:** no `.env` file is in any commit or in the index.

The working-tree scan (round 1) found only clearly fake test keys.

**Limitation:** this is not Gitleaks' full rule set. Run Gitleaks yourself (M-10).

## 5. Not executed, and why

| Test | Reason |
| --- | --- |
| Any production order, capture or database write | Forbidden |
| The fixes against production | Not deployed (deployment is forbidden for me). On 11 November 2026, production still ran the pre-audit code: read-only health `GET`s showed `X-Powered-By: Express` and no security headers, and `/api/payments/health` reported `authenticated: true` |
| A live PayPal Sandbox checkout (approval, cancel, capture before approval) | Mocks only by rule; procedures M-3 to M-6 below. The owner reports one completed USD 5.00 checkout on 11 November, on the pre-audit code, so it does not cover the new checks |
| That the old PayPal secret is disabled | I never stored the old secret; owner-reported only |
| A Jenkins run | No Jenkins instance; syntax compiled and Docker stages rehearsed instead |
| GHCR push and Render deploy hook | Need credentials and are outward-facing actions |
| Rate limits behind Render and Cloudflare; the `TRUST_PROXY` hop count | Needs the deployed build |
| Browser, mobile and accessibility; DOM double-click test | Only the headless Chrome page load for the CSP (section 3b) was run; React Testing Library would be a new dependency |
| Gitleaks | Not installed |

## 6. Manual procedures (after deploying both backend and frontend)

Use only a **PayPal Sandbox personal (buyer) account**. Never use a real card or a real PayPal login. `$API` = `https://paypilot-api-latest.onrender.com`, `$WEB` = `https://rapid-fire-08f4.namanshahnemi.workers.dev`.

**M-1. Read-only smoke test of production**

```bash
cd server && node scripts/smoke-test.mjs $API $WEB
```
Expected: every check `PASS`. Without `SMOKE_ALLOW_POST` it sends `GET` requests only.

**M-2. Startup configuration**

Check that the Render log contains `Configuration: { clientOrigins: [ '$WEB' ], payPal: 'Sandbox', aiProvider: 'gemini', aiRequestsPerMinute: …, aiDailyRequestLimit: …, trustProxy: false }`.

**M-3. Happy path**
1. In `$WEB`, select the payment button once.
2. Approve with the Sandbox buyer.
3. Expected: "Sandbox payment completed successfully: USD 5.00."
4. The dashboard shows one capture.
5. Refresh the page. Expected: the same message and no second capture.

**M-4. Cancel**

Choose "Cancel and return" on PayPal. Expected: "PayPal checkout was cancelled…" and no capture.

**M-5. Forged return and cross-session access**
1. After M-3, open `$WEB/?payment=return&token=FAKEORDER123` in the same tab. Expected: "Could not verify the returned order…".
2. Copy the order ID from the PayPal URL into a new private window and run:
   ```bash
   curl -s -X POST -H "Content-Type: application/json" -d '{"orderID":"<id>","checkoutToken":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' $API/api/payments/capture-order
   ```
   Expected: `404` "not known to the server".

**M-6. Capture before approval**
1. Start a checkout, but don't approve it.
2. In the browser's developer tools, read `sessionStorage.paypilot_checkout_token` (your own tab's token) and the order ID.
3. POST them to `capture-order`. Expected: `paymentStatus: "CREATED"`, `orderStatus: "CREATED"`, and the message "The buyer has not approved this payment…". The Render log shows "PayPal order is not approved; no capture was sent".
4. Approve on PayPal. Expected: the payment completes normally.

**M-7. Rate limit**

Send 31 invalid analyze requests:
```bash
for i in $(seq 1 31); do curl -s -o /dev/null -w "%{http_code} " -X POST -H "Content-Type: application/json" -d '{}' $API/api/proposals/analyze; done
```
Expected: `400` × 5, then `429`. The global per-minute AI limit (default 5) is reached first, and no Gemini call is made. Run it outside judging time.

**M-8. Mobile and accessibility**

Check a 375 px width in developer tools, and run a Lighthouse accessibility audit.

**M-9. Frontend headers**

After the frontend deploy, run `curl -sI $WEB`.
- **Expected headers** (PP-17): the `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` and `Strict-Transport-Security` from `client/public/_headers`.
- **Before the deploy,** on 11 November 2026, none of these were sent.

Then open `$WEB` with the browser console open, and run an analysis, a draft, a review and a Sandbox checkout.
- **Expected:** no message that starts "Refused to" or mentions "Content Security Policy".
- **If an API call is blocked:** the `connect-src` origin does not match `VITE_API_URL`.

**M-10. Secrets in Git history**
1. Install Gitleaks, then run `gitleaks detect --source .` from the repository root.
2. ~~Rotate the PayPal Sandbox secret~~ and ~~run `git gc --prune=now`~~ (PP-18): done by the owner on 11 November 2026; the object store was rescanned (section 4).

**M-11. Graceful shutdown on Render**

Redeploy, then check the old instance's log for "SIGTERM received: refusing new requests…".
