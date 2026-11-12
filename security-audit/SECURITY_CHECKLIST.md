# PayPilot AI: Security Checklist

**[x]** means verified during the audit (rounds 1 and 2 on 10 November 2026, round 3 on 11 November 2026). **[ ]** means it needs the owner to act or check. Items done by the owner are marked **owner-reported** when I could not verify them myself.

## 1. Submission

- [x] All suites pass (11 November 2026): server unit 219/219 (locally and inside the image), integration 22/22 (local database and inside the image), client 84/84.
- [x] Server and client type checks pass; both production builds succeed; lint shows no errors (1 existing warning).
- [x] `npm audit`: 0 vulnerabilities in both packages.
- [x] No secret in the working tree or in any Git object, loose or packed; `.env` is not tracked and was never committed (rescanned 11 November 2026).
- [x] PP-18: the PayPal Sandbox client secret was rotated and the old one disabled (**owner-reported**, 11 November 2026), and `git gc --prune=now` was run (owner-reported; its result **verified**: no unreferenced objects and no credentials left in `.git/objects`).
- [ ] Optional: run Gitleaks over the repository (`gitleaks detect --source .`).
- [ ] Review the audit diff, then commit and push it yourself.
- [ ] Decide whether to delete the stale tracked files `server/src/index.js` and `server/src/index.d.ts` (PP-15).
- [ ] State in the submission:
  - payments are PayPal Sandbox only, with a fixed USD 5.00 test amount, and are not a client invoice;
  - AI output is a suggestion the freelancer confirms;
  - demo data is synthetic.

## 2. Deployment

- [ ] **Production still runs the pre-audit code** (verified 11 November 2026: `X-Powered-By: Express`, no security headers). The owner-reported redeploy carried only the new credentials.
- [ ] Deploy the **backend and the frontend together**: the new frontend needs the new backend's checkout token, and the old frontend can't capture on the new backend. Checkouts open at deploy time need a new checkout.
- [ ] Render: set `CLIENT_ORIGINS=https://rapid-fire-08f4.namanshahnemi.workers.dev` (exact, no trailing slash).
- [ ] Render: set `AI_REQUESTS_PER_MINUTE` and `AI_DAILY_REQUEST_LIMIT` to at most half of the Gemini key's per-minute and per-day limits shown in Google AI Studio (defaults 5 and 100).
- [ ] Render: leave `PAYPAL_BASE_URL` unset or set it to `https://api-m.sandbox.paypal.com`; any other value stops the server.
- [ ] Render: leave `TRUST_PROXY` unset.
- [ ] Cloudflare: build with `VITE_API_URL=https://paypilot-api-latest.onrender.com`. `client/.env.production` is git-ignored, so a build from Git needs the value in Cloudflare's build settings.
- [ ] Cloudflare: after the frontend deploy, check that the headers from `client/public/_headers` are sent and the browser console shows no CSP errors (M-9). If the API URL ever changes, change `connect-src` in that file too.
- [x] The frontend CSP loads the app with no violations in headless Chrome (local build, 11 November 2026).
- [ ] After deploying, check that the Render log's `Configuration:` line shows the right origins, `payPal: 'Sandbox'` and the AI limits (M-2).
- [ ] Run `node server/scripts/smoke-test.mjs <API> <frontend origin>` against production; it is read-only (M-1).
- [x] The container runs as non-root `node`, contains no `.env` file, and stops cleanly on SIGTERM (exit code 0).
- [x] The runtime image contains no `better-sqlite3`, no compiled tests and no SQLite modules (Jenkins contents check, run 11 November 2026).
- [x] The schema upgrade only adds a nullable column, so rolling back to the previous image is safe.

## 3. Secrets

- [x] PayPal credentials, the Gemini key and `DATABASE_URL` are read only by the server; the frontend uses only `VITE_API_URL` (public).
- [x] `.env` and `.env.*` are git-ignored (except `.env.example`) and excluded from the Docker build context.
- [x] The Gemini key is sent only in the `x-goog-api-key` header; the PayPal token and the connection string are never logged (tested).
- [x] Checkout tokens are never logged, never put in URLs, and stored only as SHA-256 hashes (tested).
- [x] The Jenkinsfile contains no credentials; it uses the Jenkins credentials `ghcr-publish` and `render-deploy-hook`, which Jenkins masks in logs.
- [x] PP-18: Sandbox secret rotated (owner-reported); Git objects pruned and rescanned clean (verified). See section 1.
- [x] Render's current Sandbox credentials authenticate: `GET /api/payments/health` returned `authenticated: true` (verified 11 November 2026).
- [ ] Neon: a dedicated application role and `sslmode=require` in `DATABASE_URL`.
- [ ] Confirm that no billing is attached to the Gemini key or the Google Cloud project.

## 4. Payment verification

- [x] The server alone sets the amount and currency (USD 5.00); the `CAPTURE` intent and the return URLs are fixed (tested).
- [x] `PAYPAL_BASE_URL` can only be PayPal Sandbox (tested).
- [x] Each order is registered before its approval URL is returned, and the approval URL must be HTTPS `*.paypal.com` (tested).
- [x] An order can only be captured or read with its checkout token; a wrong token is indistinguishable from an unknown order (tested).
- [x] A capture is sent only for an order PayPal reports as `APPROVED`; early or repeated requests never fail the order (tested).
- [x] A stable `PayPal-Request-Id` per order; concurrent captures make one PayPal call, across instances too (tested).
- [x] Paid only on a `COMPLETED` capture of exactly USD 5.00 (tested, including currency and amount tampering).
- [x] `PAID` and `NEEDS_REVIEW` are final; unclear results become `UNKNOWN` and are safe to retry (tested).
- [x] Status survives restarts; a database outage fails fast without a false result (tested).
- [x] The UI shows success only for a verified completed capture; duplicate clicks are blocked.
- [x] AI output has no code path to payments (import-graph test).
- [x] Gemini-mode AI errors never tell users to check Ollama; Ollama mode keeps its instructions (`providerErrors.test.ts`, PP-30).
- [ ] Run the manual Sandbox checks M-3 to M-6 with a Sandbox buyer account only.
- [ ] Never use live PayPal credentials or a live `PAYPAL_BASE_URL` for this project.
