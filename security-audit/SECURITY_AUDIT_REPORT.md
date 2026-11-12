# PayPilot AI: Security Audit Report

**Last updated:** 11 November 2026 (third, limited remediation round)
**Scope:** the whole repository (`server/`, `client/`, `Jenkinsfile`, `server/Dockerfile`, `.dockerignore`, `.gitignore`, environment examples, README), the local Git object store (read directly, loose objects and packfiles, with no Git commands), read-only `GET` requests to the production health endpoints, and, in round 3, one read-only `GET` of the production frontend's home page.
**Not done:** no production orders, captures, database writes, deployments, or configuration changes. No Git commands were run; nothing was committed or pushed.

**Round 3 (11 November 2026):** PP-18 is closed after the owner rotated the Sandbox secret and pruned the Git objects; PP-27, PP-30 and PP-17 are fixed in code. Owner actions are marked **owner-reported**, and what I checked myself is marked **verified**.

---

## 1. Executive summary

Three rounds of review found **29 issues**, and **21 are fixed**. 20 were fixed in code, all but two with a regression test (PP-06 and PP-24, explained below). PP-18 was fixed by owner action, which I verified where I could. **No Critical, High, Medium or Low finding remains open.** The 8 open items are informational recommendations.

What an attacker cannot do with this code:
- **Change the amount:** the server alone sets the amount (USD 5.00) and the currency.
- **Capture someone else's order:** an order can now only be captured or read by the browser tab that created it, which holds a random 256-bit checkout token that is never put in a URL.
- **Capture an unapproved order:** a capture is sent to PayPal only after PayPal reports the order as `APPROVED`. An early or repeated request leaves the order unchanged and can't block the real checkout.
- **Get a payment recorded falsely:** an order is paid only on a `COMPLETED` capture of exactly USD 5.00. Retries reuse one stable `PayPal-Request-Id`, and concurrent captures across instances make one PayPal call.

What the code still cannot prevent (sections 3 and 5):
- **Abuse within the limits:** the API has no user accounts, so anyone can still use the AI budget and start Sandbox checkouts, up to the rate limits.
- **Shared limits on Render:** limits are kept per process, and behind Render every client probably shares the per-client limit.
- **The configured AI limits must fit the Gemini key's actual quota,** which only Google AI Studio shows.

**Test results** (all actually run on 11 November 2026, after the round-3 changes):

| Suite | Result |
| --- | --- |
| Server unit | 219/219 locally, and 219/219 inside the Docker build image |
| PostgreSQL integration | 22/22 locally, and 22/22 inside the Docker image against a fresh database |
| Client | 84/84 |
| Type checks, lint and builds | pass (lint: 1 existing warning, 0 errors) |
| `npm audit` | 0 vulnerabilities in both packages |
| Docker image | builds; contents check passes; smoke test 11/11; SIGTERM exit code 0 |

Mutation checks confirmed that the tests fail when the ownership check, the approval check or the import boundary is removed (round 2), and when the old Ollama wording is put back in Gemini mode (round 3). Section 6 lists what could not be tested.

**Verdict: READY FOR REVIEW.** Deployment should wait for the owner's code review, the manual Sandbox checks, the configuration steps in `DEPLOYMENT_READINESS.md`, and a coordinated backend and frontend deploy.

**Production does not run any of these fixes yet.** On 11 November 2026 the API still answered with `X-Powered-By: Express` and without the round-1 security headers, and the frontend sent no security headers. The redeploy the owner reported put the rotated credentials on the pre-audit code.

| Severity | Found | Fixed | Open |
| --- | ---: | ---: | ---: |
| Critical | 0 | 0 | 0 |
| High | 1 | 1 | 0 |
| Medium | 5 | 5 | 0 |
| Low | 10 | 10 | 0 |
| Informational | 13 | 5 | 8 (recommendations) |
| **Total** | **29** | **21** | **8** |

### Review of the first round

The second round checked the first round's fixes against the code rather than trusting the earlier report. The implementation matched the earlier report, but the review found gaps that report missed:
- The health endpoints still called PayPal or Gemini on every request that the limiter allowed (PP-20).
- The default `AI_DAILY_REQUEST_LIMIT` of 200 was never checked against the Gemini free tier, and there was no per-minute limit (PP-19).
- Database queries had no timeout (PP-21).
- `.dockerignore` started with a UTF-8 byte-order mark that could disable its first rule (PP-26).
- The checkout button relied on React state alone, so a fast double click could send two requests (PP-24).
- The Jenkinsfile was Windows-only, so it could not run on Jenkins in Docker Desktop. This is tracked as CI readiness in `DEPLOYMENT_READINESS.md`, not as a vulnerability, so the ID PP-25 is unused.

---

## 2. Architecture and data flow

```
Browser (Cloudflare: rapid-fire-08f4.namanshahnemi.workers.dev)
   │  JSON over HTTPS. sessionStorage: brief, proposal, order ID, checkout token
   ▼
Express API (Render: paypilot-api-latest.onrender.com)
   securityHeaders → cors(corsOptions) → shutdown drain (503) → rejectDisallowedOrigins (403)
   → requireJsonBody (415) → express.json (100 kB) → per-route limiter (429) → handler
   ├─ /api/proposals/{analyze,draft,review}  aiLimiter → Zod → Gemini → grounding checks
   ├─ /api/payments/create-order             createOrderLimiter → PayPal create → register(hash) → token
   ├─ /api/payments/capture-order            paymentStatusLimiter → token check → lock → PayPal GET → capture if APPROVED
   ├─ /api/payments/orders/:id               paymentStatusLimiter → token check (X-Checkout-Token)
   ├─ /api/payments/health, /api/ai/health   upstreamHealthLimiter → 60 s cached check
   └─ notFoundHandler (JSON 404) → jsonErrorHandler (no stack traces)
   ▼
PostgreSQL (Neon in production; Docker locally)
   paypal_orders: order ID, expected amount and currency, status, PayPal capture fields,
   checkout_token_hash (SHA-256). No buyer data. Schema version 2.
```

**Payment flow:**
1. The browser POSTs `{}` to create-order.
2. The server creates the USD 5.00 order at PayPal and checks the approval link.
3. The server generates a checkout token and stores the order with the token's hash. It returns the order ID, the approval URL and the token.
4. The browser saves the order ID and token in `sessionStorage`, checks the URL again and redirects to PayPal.
5. On return, the browser captures only if PayPal's `token` parameter matches the saved order ID. It sends the checkout token in the request body.
6. The server checks the token. It takes the order's advisory lock, then skips the order if it is already `PAID` or `NEEDS_REVIEW`.
7. The server asks PayPal for the order and sends the capture, with a stable request ID, only if PayPal reports `APPROVED`.
8. The server checks the captured amount and currency, and records the result.

---

## 3. Findings

### Fixed

#### PP-01: Public endpoints had no rate limits

| | |
| --- | --- |
| **Severity** | High |
| **Status** | Fixed (round 1), tuned (round 2) |
| **Code** | `server/src/rateLimit.ts`, used in `server/src/index.ts` |

**Problem:** the AI routes, create-order and the health checks could be called without limit. That allowed the Gemini quota to be used up, unlimited Sandbox orders and database rows, and repeated PayPal OAuth calls.

**Fix:** in-memory fixed-window limits, with per-client and global rules and a memory cap. A refused request gets `429` with a JSON error and `Retry-After`. The route limiter runs before validation, so invalid bodies still count; requests refused earlier with `403`, `415` or `400` do no work.

| Route group | Per client | Total |
| --- | --- | --- |
| AI routes (shared) | 30 per 10 minutes | `AI_REQUESTS_PER_MINUTE` (default 5) and `AI_DAILY_REQUEST_LIMIT` per 24 hours (default 100) |
| create-order | 20 per 10 minutes | 100 per hour |
| capture and status (shared) | 60 per minute | none |
| health checks | 10 per minute | 60 per minute |

**Tests:** `rateLimit.test.ts` (8 tests), and a local run of the real server (`429` after the limit).

#### PP-02: Cross-site requests could start checkouts; requests from disallowed origins still ran

| | |
| --- | --- |
| **Severity** | Medium |
| **Status** | Fixed (round 1), CORS made explicit (round 2) |
| **Code** | `server/src/securityMiddleware.ts` |

**Fix:**
- `requireJsonBody` returns `415` for any non-JSON write, which forces browsers to send a preflight first.
- `rejectDisallowedOrigins` returns `403` for a foreign `Origin` header.
- `corsOptions` allows only `GET` and `POST`, only the `Content-Type` and `X-Checkout-Token` headers, and no credentials.

Requests without `Origin` (curl) are allowed on purpose: CORS is not authentication. Orders are protected by checkout tokens (PP-07), and everything else by the rate limits.

**Tests:** `securityMiddleware.test.ts` (12 tests: forged and look-alike origins, preflights, non-JSON bodies), and the image smoke test.

#### PP-03: The database pool waited forever for a connection

| | |
| --- | --- |
| **Severity** | Medium |
| **Status** | Fixed (round 1) |
| **Code** | `createPostgresPool` in `server/src/postgresOrderRegistry.ts` |

**Fix:** `connectionTimeoutMillis` of 15,000 ms by default.

**Tests:** integration tests for the default value and for failing fast when the pool is exhausted; `databaseFailure.test.ts` covers a database outage without needing a database.

#### PP-04: The checkout redirect URL was not validated

| | |
| --- | --- |
| **Severity** | Low |
| **Status** | Fixed (round 1) |
| **Code** | `isPayPalApprovalUrl` in `server/src/checkoutRoute.ts` and `client/src/paymentFlow.ts` |

**Fix:** the browser is sent only to an HTTPS `*.paypal.com` address with no credentials or port in the URL. This is checked on both the server and the client.

**Tests:** `checkoutRoute.test.ts`, `paymentFlow.test.ts`, and a mutation check.

#### PP-05: Missing security headers, Express fingerprint, HTML 404 page

| | |
| --- | --- |
| **Severity** | Low |
| **Status** | Fixed (round 1) |
| **Code** | `securityHeaders` and `notFoundHandler`; `x-powered-by` disabled |

**Tests:** `securityMiddleware.test.ts` and the image smoke test.

#### PP-06: The Ollama health check had no timeout

| | |
| --- | --- |
| **Severity** | Low |
| **Status** | Fixed (round 1) |
| **Code** | `checkOllamaHealth` in `server/src/index.ts` |

**Fix:** a 5-second timeout.

**Tests:** none for this one-line change. The Ollama model calls' timeout handling is already tested.

#### PP-07: Orders were not bound to the browser that created them

| | |
| --- | --- |
| **Severity** | Low |
| **Status** | Fixed (round 2) |
| **Code** | `server/src/checkoutToken.ts` (new), `checkoutRoute.ts`, `paymentRoutes.ts`, `orderModel.ts`, both registries, `client/src/App.tsx`, `client/src/paymentFlow.ts` |

**Could it be exploited?** A PayPal order ID is not secret. It is the `token` parameter in the PayPal checkout URL and in the return URL, so it ends up in browser history and can appear in screenshots or shared links. Before this fix, anyone who had the ID could:
- **Read the order's status:** amounts, timestamps and PayPal statuses. No buyer data is stored, so no personal information leaked.
- **Trigger its capture:** this completes a payment the buyer had already approved, for the server-fixed amount, to the merchant's own account. Nobody else could receive the money.
- **Capture before the buyer approved:** this recorded the order as `FAILED` and possibly used up the stable request ID (PP-08).

In short, the realistic impact was a privacy leak of order metadata and interference with someone else's checkout, not theft.

**Fix:**
- create-order generates `randomBytes(32)` (256 bits, base64url), returns it once and stores only its SHA-256 hash in `checkout_token_hash`.
- Capture requires `checkoutToken` in the request body; a status lookup requires the `X-Checkout-Token` header.
- The token is compared with `timingSafeEqual` on the hashes.
- A missing or malformed token gets `400`. A wrong token gets the same `404` and body as an unknown order, so order IDs can't be probed.
- Orders created before this change (no hash) can't be read or captured.
- The token is never logged, never returned again and never put in a URL. Responses never contain the token or its hash.

**Limitation:** this is a bearer secret held in the tab's `sessionStorage`, not user authentication. Anyone who can run script in the app's origin could read it, but there are no HTML-rendering sinks (static test). It grants access only to that one Sandbox order.

**Tests:** `paymentOwnership.test.ts` covers:
- another session's token cannot capture or read the order;
- a missing or malformed token, including a NoSQL-style object or the hash itself, gets `400`;
- a wrong token and an unknown order get identical answers;
- legacy orders are refused;
- responses never contain the token or its hash;
- token randomness and matching.

Also `orderRegistry.test.ts` (only the hash is stored), the integration tests (the hash persists and is never replaced; a legacy table upgrade adds the column) and client tests (storage helpers; no token in URLs). A mutation check that removes the ownership check fails 2 tests.

#### PP-08: A capture before buyer approval could block the order

| | |
| --- | --- |
| **Severity** | Low |
| **Status** | Fixed (round 2) |
| **Code** | `capturePayPalOrder` in `server/src/paypalCapture.ts`; `captureUpdate` in `server/src/orderModel.ts` |

**Before:** a capture was sent straight away. For an unapproved order PayPal answers `422 ORDER_NOT_APPROVED`, which the code recorded as `FAILED`. Whether PayPal stores that failure under the order's stable `PayPal-Request-Id` and replays it later is not documented. The published Orders v2 schema describes the header only as "for idempotency purposes".

**Fix:** the code no longer depends on that undocumented behaviour. Every capture first `GET`s the order. The statuses come from the published `order_status` enum: CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED.

| PayPal reports | What happens |
| --- | --- |
| `APPROVED` | The capture is sent, with the stable request ID. |
| `COMPLETED`, or captures present | The result is evaluated from that response, without capturing again. This also recovers a capture whose result wasn't recorded. |
| `VOIDED` | Recorded as `FAILED` with an explanation. |
| `CREATED`, `SAVED`, `PAYER_ACTION_REQUIRED` | Reported as not approved. The order keeps its status and gets the message "The buyer has not approved this payment at PayPal yet, so no capture was attempted." |
| The check itself fails | `UNKNOWN`, safe to retry; nothing is sent. |

An early or repeated request therefore never reaches the capture endpoint, never uses up the request ID, and never moves the order to `FAILED`.

**Timeouts:** the order check and the fallback lookup each have a 10-second timeout, and the capture 15 seconds. With the 15-second token request, a capture holds its lock for at most about 50 seconds, under the 60-second hold limit.

**Tests:** `paymentOwnership.test.ts`:
- unapproved, then approved: the first capture request carries the stable ID;
- each of CREATED, SAVED and PAYER_ACTION_REQUIRED;
- a cancelled checkout; a voided order; an already-captured order;
- a failed status check sends nothing;
- three simultaneous requests make one capture.

All existing capture tests were adapted to answer the status check and still pass with unchanged assertions. There is also an integration test across two instances. A mutation check that removes the approval check fails 6 tests.

**Remaining uncertainty:** the behaviour is based on the documented statuses and is tested against mocks. The live Sandbox flow still needs the manual check M-6.

#### PP-09: The container ran npm as PID 1, so SIGTERM might not reach Node

| | |
| --- | --- |
| **Severity** | Informational |
| **Status** | Fixed (round 2) |
| **Code** | `server/Dockerfile` |

**Fix:** `CMD ["node", "dist/index.js"]`.

**Verified:** `docker stop` on the built image logged "SIGTERM received: refusing new requests…" and exited with code 0. The image smoke test in the Jenkinsfile now asserts the exit code.

#### PP-16: Production loaded the SQLite native module it doesn't use

| | |
| --- | --- |
| **Severity** | Informational |
| **Status** | Fixed (round 2) |
| **Code** | `server/src/orderModel.ts` (new) |

**Fix:** the types, `isValidOrderID`, `toOrderView` and the shared `captureUpdate` moved into `orderModel.ts`. `orderRegistry.ts` (SQLite, for tests) re-exports them, so test imports didn't change.

**Tests:** `productionImports.test.ts` follows the imports from `index.ts` and fails if `orderRegistry.ts`, `database.ts` or `better-sqlite3` is reachable (mutation-checked). Round 3 also removed the driver from the image (PP-27).

#### PP-19: The AI quota defaults were not checked against the Gemini free tier

| | |
| --- | --- |
| **Severity** | Medium |
| **Status** | Fixed (round 2); the owner must configure the real values |
| **Code** | `server/src/index.ts` (`aiLimiter`) |

**Problem:**
- Google no longer publishes one free-tier table; each project's limits are shown in Google AI Studio.
- Third-party 2026 sources contradict each other for Gemini 2.5 Flash, reporting from about 20 to 1,500 requests per day and about 10 per minute.
- A default of 200 requests per day could therefore have been above the real quota. With no per-minute limit, bursts would get `429` errors from Google rather than a clear message from the server.
- One analysis can make two model calls.

**Fix:**
- a global per-minute rule, `AI_REQUESTS_PER_MINUTE` (default 5, which means at most 10 model calls per minute);
- a lower daily default, `AI_DAILY_REQUEST_LIMIT` = 100;
- both configurable and validated, and both logged at startup.
- The README and `.env.example` tell the owner to set each to at most half of the key's limits in AI Studio.

**Residual risk:** a daily cap set at or below the real quota still lets one abuser use it up (R-1). It protects the key, not availability.

#### PP-20: The health checks still called PayPal or Gemini on every allowed request

| | |
| --- | --- |
| **Severity** | Low |
| **Status** | Fixed (round 2) |
| **Code** | `server/src/healthCache.ts` (new) |

**Fix:** the results of `/api/payments/health` and `/api/ai/health` are cached for 60 seconds. Concurrent requests share one check, and failures are cached too. The two checks therefore call PayPal's token endpoint or the Gemini API at most once per minute.

**Tests:** `config.test.ts` (TTL, sharing, cached failures, no error detail leaked).

#### PP-21: Database queries had no time limit, and the new migration could queue behind captures

| | |
| --- | --- |
| **Severity** | Medium |
| **Status** | Fixed (round 2) |
| **Code** | `server/src/postgresOrderRegistry.ts` |

**Problem:**
- A query on a silently dropped connection could wait for minutes.
- Round 2's schema upgrade needs `ALTER TABLE`, which waits for an exclusive lock. While it waits, it blocks every later query on the table. It would wait behind captures, which can hold row locks for up to about 50 seconds.

**Fix:**
- The pool's `query_timeout` defaults to 20 s. A query that times out has its connection discarded, never reused, and is not rolled back on that same connection.
- The advisory-lock wait gets its own limit (`lockTimeoutMs` + 5 s), because it may legitimately take longer.
- TCP keep-alive is enabled.
- `initialize()` now runs in an explicit transaction with `lock_timeout` 10 s and `statement_timeout` 30 s, and runs `ALTER TABLE` only if the column is actually missing. An instance that can't get the lock fails its startup, and the platform retries it, instead of stalling payments.

**Tests:** integration tests:
- a 3-second query fails at the 300 ms timeout and the pool keeps working;
- a lock wait longer than the pool's query timeout still succeeds;
- the legacy-table upgrade, run in a private schema that is then dropped;
- a fresh-database run inside the Docker image.

#### PP-22: CLIENT_ORIGINS entries were not validated

| | |
| --- | --- |
| **Severity** | Low |
| **Status** | Fixed (round 2) |
| **Code** | `parseClientOrigins` in `server/src/config.ts` |

**Problem:** a trailing slash, a path or `*` would silently never match the browser's `Origin`.

**Fix:** only exact `http(s)` origins are kept. Invalid entries are logged and dropped, so the list is never widened. An empty result allows no browser origin at all, and the effective list is logged at startup.

**Tests:** `config.test.ts`.

#### PP-23: PAYPAL_BASE_URL could point at live PayPal

| | |
| --- | --- |
| **Severity** | Low |
| **Status** | Fixed (round 2) |
| **Code** | `readPayPalBaseUrl` in `server/src/config.ts` |

**Fix:** only `https://api-m.sandbox.paypal.com` (or `api.sandbox.paypal.com`) is accepted. Any other value stops the server at startup.

**Tests:** `config.test.ts` (live hosts, `http:`, look-alike hosts and paths are refused).

#### PP-24: A fast double click could send two checkout or capture requests

| | |
| --- | --- |
| **Severity** | Low |
| **Status** | Fixed (round 2) |
| **Code** | `client/src/App.tsx` |

**Problem:** the button was disabled through React state, which takes effect only on the next render.

**Fix:** a `useRef` guard blocks a second `create-order` or `capture-order` call while one is running. The server already deduplicated captures, so the worst case before was a second unpaid order.

**Tests:** verified by code review and build. There is no DOM test, because that would need a new dependency (React Testing Library).

#### PP-26: `.dockerignore` began with a UTF-8 byte-order mark

| | |
| --- | --- |
| **Severity** | Low |
| **Status** | Fixed (round 2) |
| **Code** | `server/.dockerignore`, `server/Dockerfile` |

**Problem:** depending on how Docker parses the file, the BOM can make the first rule (`node_modules`) ineffective, so the host's Windows `node_modules` would be copied into the Linux image.

**Fix:** the BOM was removed from both files, and patterns for logs, reports and editor files were added.

**Verified:** in the built image, `/app` contains no `.env` file or `data/` folder, the runtime image has no development dependencies, and it runs as `node`.

#### PP-18: Sandbox credentials were in the local Git object store

| | |
| --- | --- |
| **Severity** | Medium |
| **Status** | **Remediated on 11 November 2026 (round 3)** by credential rotation and Git object pruning |
| **Where** | `.git/objects` (local only) |

**Found in round 2:** a read-only scan of all 2,184 loose Git objects found four **unreferenced** 3-line blobs, the PayPal section of a `.env` file that was staged once and then removed from the index.
- All four held the then-current Sandbox client ID; one also held the then-current client secret.
- No commit contained a secret, and no `.env` file was ever committed.
- Unreferenced objects are not pushed, so the blobs should never have reached GitHub.

**Owner-reported actions (11 November 2026).** I could not observe these:
- rotated the Sandbox client secret in the PayPal Developer Dashboard, and disabled the old one;
- updated the local `server/.env` and Render's environment variables;
- redeployed the backend and completed a USD 5.00 Sandbox checkout;
- ran `git gc --prune=now`.

**Verified independently on 11 November 2026, without Git commands:**
- **No credentials are left in Git.** `.git/objects` now holds no loose objects and one packfile. A new read-only scanner parsed the whole pack: 92 objects, every delta resolved, and the parse ended exactly at the pack checksum. It found 4 commits and 73 blobs, and every blob is referenced by a commit, so no leftover `.env` blob remains.
- **No secret anywhere in the objects.** No object matches a secret pattern. None contains any current `server/.env` value (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `GEMINI_API_KEY`, `DATABASE_URL`), compared in memory and never printed.
- **The old blobs are gone.** A secret rotation keeps the client ID, and all four old blobs held it. It now appears in no object, so those blobs were deleted.
- **No `.env` tracked.** No `.env` file is in any commit or in the Git index.
- **Render's credentials work.** `GET /api/payments/health` on production returned `authenticated: true`.

**Not verifiable by me:**
- That the old secret is disabled at PayPal. I never stored it, so I can't test it.
- That no copy of the project folder from before 11 November still exists. If one does, it holds only the old secret, which the owner reports disabled.

Gitleaks was not installed, so the scan used my own scanner, without Gitleaks' full rule set.

#### PP-27: The SQLite driver and compiled tests were in the production image

| | |
| --- | --- |
| **Severity** | Informational |
| **Status** | Fixed (round 3) |
| **Code** | `server/package.json`, `server/package-lock.json`, `server/tsconfig.build.json` (new), `server/Dockerfile` (comment), `Jenkinsfile` |

**Investigation:**
- Only `database.ts` and `orderRegistry.ts` import `better-sqlite3`, and both are used only by tests.
- Nothing reachable from `index.ts` imports them (checked by `productionImports.test.ts`), and the code has no dynamic imports.
- The production build still compiled every file, tests and the SQLite registry included.

**Fix:**
- **Dependency moved:** `better-sqlite3` is now in `devDependencies`. The regenerated lockfile changes 4 lines and no versions: `better-sqlite3` and its only dependency, `node-addon-api`, are now marked `dev`. The Docker `prod-deps` stage (`npm prune --omit=dev`) therefore removes both.
- **Build narrowed:** `npm run build` now uses `tsconfig.build.json`, which compiles only `src/index.ts` and what it imports. `dist/` holds 19 modules: no test file, no `database.js`, no `orderRegistry.js`. Type checking (`tsc --noEmit -p .`) still covers every file, tests included.
- **CI check:** the Jenkins image smoke test now checks the runtime image's contents. It fails if `better-sqlite3` resolves, or if `dist/` contains a test or a SQLite module.

**Verified:**
- The runtime image passes the contents check under both `sh` and Windows `bat` quoting. The build image, which keeps the development dependencies, correctly fails it.
- The runtime image starts, passes the 11-check smoke test, and exits with code 0 on SIGTERM.
- All SQLite-based unit tests pass, locally and in the build image (219/219).

**Tests:** a new test in `productionImports.test.ts` checks that `better-sqlite3` is only a development dependency and that the build compiles only from `src/index.ts`.

#### PP-30: Gemini-mode AI errors told users to check Ollama

| | |
| --- | --- |
| **Severity** | Informational |
| **Status** | Fixed (round 3) |
| **Code** | `failureFor` in `server/src/localModel.ts`; `analysis.ts`, `proposalGenerator.ts`, `riskReview.ts` |

**Problem:** the "unreachable" and "error status" messages, and for drafting the "timeout" message, always said "the local AI model" or "Check that Ollama is running". They did so even in Gemini mode, where the user can do nothing about Ollama.

**Fix:**
- Each feature now has provider-neutral messages, such as "The AI service is not available right now. Try again later."
- A separate Ollama-only table keeps the existing local instructions.
- `failureFor` uses the Ollama wording only when Ollama handled the request.
- Unchanged: status codes (502, 503, 504), retry behaviour, and the server logs, which already named the provider.

**Tests:** `providerErrors.test.ts` (22 tests):
- **Coverage:** all three features in both modes, for the unavailable, error-status and timeout cases, plus Gemini with no API key.
- **Gemini mode:** messages contain no local-model or Ollama wording.
- **Both modes:** status codes match.
- **Ollama mode:** still says to check Ollama.

The existing Ollama tests pass unchanged. Mutation check: putting the old wording back fails 2 tests.

#### PP-17: The frontend sent no security headers

| | |
| --- | --- |
| **Severity** | Informational |
| **Status** | Fixed in code (round 3); takes effect on the next frontend deploy |
| **Code** | `client/public/_headers` (new) |

**Observed on 11 November 2026** (one read-only `GET` of the home page): the Cloudflare frontend sends none of `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` or `Strict-Transport-Security`. That means:
- the page could be framed by another site (clickjacking);
- nothing limits where scripts load from, should an injection bug ever appear.

**What the app loads** (from the source and the build):
- **From the site itself:** one bundled module script and one stylesheet. There are no inline scripts, no `eval` and no HTML-rendering sinks.
- **Google Fonts:** CSS from `fonts.googleapis.com`, font files from `fonts.gstatic.com`.
- **Network calls:** `fetch` only to the backend API.

PayPal checkout is a top-level redirect, which a CSP does not restrict.

**Fix:** Cloudflare Workers static assets apply a `_headers` file in the assets directory, and Vite copies `client/public/` into `dist/`, so no Cloudflare dashboard setting is needed. The file sets:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://paypilot-api-latest.onrender.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Strict-Transport-Security: max-age=31536000
```

**Verified:**
- **Real policy:** I served a local production build with exactly these headers (`connect-src` pointed at a local stub API) and loaded it in headless Chrome. The app rendered, its API call succeeded, Google Fonts loaded, and Chrome reported **no CSP violations**.
- **Control:** a deliberately broken policy produced the expected violations, so the check can detect them.

**Owner checks:**
- If the backend URL (`VITE_API_URL`) changes, update `connect-src` in `_headers`; otherwise the browser blocks every API call.
- After the next frontend deploy:
  - check the headers with `curl -sI` (M-9);
  - with the browser console open, click through analyze, draft, review and the Sandbox checkout.
- Cloudflare's documentation does not say whether `_headers` applies to pages served by the single-page-application fallback. This app has only one page (`/`, a real file), so it is not affected.

#### Informational (open)

| ID | Observation | Recommendation |
| --- | --- | --- |
| PP-10 | A new PayPal OAuth token is requested for each create and capture. | Cache it until shortly before `expires_in`. Not changed, because it touches the payment path. |
| PP-11 | Abandoned `CREATED` orders are kept forever. | A retention job for old `CREATED` rows only. |
| PP-12 | A `PAID` record isn't re-checked after a refund or reversal in the Sandbox dashboard. | Acceptable for a test payment; verified webhooks if this is ever used for real. |
| PP-13 | Prompt injection is mitigated, not solved. A number written anywhere in the brief passes the budget check, and the analysis prompt sends the brief without delimiters. | Keep the "AI suggestion" labels; the freelancer confirms every term. |
| PP-14 | In Gemini mode, the brief and proposal text go to Google. | Synthetic demo data only. |
| PP-15 | `server/src/index.js` and `index.d.ts` are stale compiled SQLite-era files tracked in Git. Nothing imports them; `tsc` ignores `.js` (no `allowJs`); `start` runs `dist/index.js`. They contain no secrets (scanned). | Delete them after review; not deleted, as instructed. |
| PP-28 | Render reportedly appends to, rather than replaces, `X-Forwarded-For` (community reports; not in Render's docs), so the leftmost address can be forged. | Keep `TRUST_PROXY` unset; per-client limits are then shared (R-2). |
| PP-29 | Orders created before checkout tokens have no token and can no longer be read or captured through the API. | Intentional. Mention it when deploying: open checkouts at deploy time need a new checkout. |

---

## 4. Verified as secure

| Area | Evidence |
| --- | --- |
| Server-fixed amount and currency | A tampered body still produces a `CAPTURE` USD 5.00 order (`checkoutRoute.test.ts`). |
| The order is registered before the approval URL is returned; a failure returns no URL | `checkoutRoute.test.ts`, `databaseFailure.test.ts` |
| Ownership | `paymentOwnership.test.ts` (PP-07) |
| No capture before approval | `paymentOwnership.test.ts`, integration test (PP-08) |
| Duplicate and replayed captures | Final statuses are never re-sent; the stable request ID is reused. |
| Simultaneous captures, multiple instances | One PayPal capture per order (unit and integration tests). |
| Amount and currency checks | Exact cents and an exact currency code (9 tampering cases). |
| Invalid order IDs | `^[A-Z0-9-]{1,100}$`; objects get `400`. |
| Timeouts, PayPal errors, already captured | `UNKNOWN` or a lookup, never a false `PAID`. |
| Persistence and restarts | PostgreSQL integration tests. |
| Database outage | A fast, generic JSON error; the password is never logged (`databaseFailure.test.ts`). |
| SQL injection | All queries are parameterized; only internal millisecond settings and a test-only schema name are interpolated. |
| Prototype pollution, oversized and invalid bodies | `securityMiddleware.test.ts`, `httpErrors.test.ts` |
| Graceful shutdown | 13 unit tests, plus the container's `SIGTERM` exit code 0. |
| AI isolation | The brief is only user content; no secrets reach the model; invented values and extra fields are dropped (`aiSecurity.test.ts`). No AI module can reach payment, checkout or database code (`productionImports.test.ts`). |
| XSS | No HTML-rendering sinks in client code (static test). |
| Secrets and test code in the image | No `.env` file or `data/` folder; runs as non-root `node`; no `better-sqlite3` and no compiled tests (contents check, PP-27). |
| Secrets in the working tree and Git objects | None: no secret pattern and no current `.env` value in any loose or packed object (11 November 2026); no `.env` file in any commit or in the index. |
| Dependencies | `npm audit`: 0 vulnerabilities in both packages. |

---

## 5. Remaining risks

- **R-1. Abuse within the limits.** Without user accounts, anyone can use the shared AI budget and the checkout limits. The limits stop runaway use but not a determined outage of the demo.
- **R-2. Shared per-client limits on Render.** Busy judging could hit them. Raise the limits rather than setting `TRUST_PROXY` without confirming Render's proxy hops.
- **R-3. In-memory limits.** They are per instance and reset on restart; Render's free tier restarts after idling.
- **R-4. Checkout tokens are bearer secrets** in `sessionStorage`. They are as safe as the frontend origin, and there is no XSS sink today.
- **R-5. PP-18 (closed).** The owner reports the old Sandbox secret disabled. I verified that no Git object still holds credentials, but not the disabled status at PayPal.
- **R-6. PayPal behaviour is tested only against mocks.** The manual Sandbox checks M-3 to M-6 are still required.
- **R-7. Deploy compatibility.** The new backend and the new frontend must be deployed together. The old frontend sends no checkout token, and the new frontend requires one from create-order.
- **R-8. Nothing has run in Jenkins yet.** The pipeline compiles as Groovy, and its Docker commands were run by hand, but it has never run in a Jenkins instance.

---

## 6. Verification limits

- **Production:** only read-only `GET` requests: the health endpoints in round 1 and on 11 November 2026, and the frontend home page on 11 November. Production still ran the code from before the audit on 11 November (`X-Powered-By: Express`, no security headers), with working Sandbox credentials.
- **Not executed:**
  - live PayPal Sandbox flows by me (the owner reports one completed USD 5.00 checkout, on the pre-audit code);
  - Render and Cloudflare behaviour, including proxy hop counts;
  - a Jenkins run;
  - browser and mobile tests of the real app (only a headless Chrome load of a local build, for the CSP);
  - Gitleaks (not installed; a custom scanner was used).
