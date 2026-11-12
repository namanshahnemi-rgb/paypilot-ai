# PayPilot AI: Deployment Readiness

**Date:** 11 November 2026 (updated after round 3)
**Verdict: READY FOR REVIEW.** The code is ready for the owner's review. Deploying is safe once the four gate items below are done, in order. I have not committed, pushed or deployed anything.

**Production today** (verified 11 November 2026 with read-only `GET` requests):
- **Backend:** still runs the code from before the audit (`X-Powered-By: Express`, no security headers). It now has the rotated Sandbox credentials, which authenticate.
- **Frontend:** sends no security headers.

None of the fixes below are live until the owner deploys them.

## 1. Gate before deploying

1. **Review and commit** the changes (`REMEDIATION_CHANGELOG.md` lists every file).
2. **Configure Render and Cloudflare** as in section 5 below. Especially check `CLIENT_ORIGINS` and the two AI limits.
3. **Deploy the backend and the frontend together** (section 6). They depend on each other through the new checkout token.
4. **Run the manual checks** M-1 to M-6 and M-9 in `SECURITY_TEST_PLAN.md`, with a PayPal Sandbox buyer account.

PP-18 is no longer a gate item. The owner reports rotating the Sandbox secret and running `git gc --prune=now` on 11 November 2026, and my rescan of `.git/objects` found no credentials left.

## 2. What has been fixed

| Area | Fix | Finding |
| --- | --- | --- |
| Payment ownership | Each order is bound to the tab that created it by a 256-bit checkout token (only its hash is stored). Capture and status lookups require the token, and a wrong token looks like an unknown order. | PP-07 |
| Capture before approval | The order is checked with PayPal first, and the capture is sent only for `APPROVED` orders. Early or repeated requests change nothing. | PP-08 |
| Rate limits | Limits on AI, checkout, capture and status, and health routes; a global per-minute and per-day AI budget that you configure; health checks cached for 60 s. | PP-01, PP-19, PP-20 |
| CORS and requests | Exact-origin `CLIENT_ORIGINS`; 403 for foreign origins; 415 for non-JSON writes; explicit CORS methods and headers; security headers; JSON 404. | PP-02, PP-05, PP-22 |
| PayPal environment | `PAYPAL_BASE_URL` must be Sandbox, or the server won't start. | PP-23 |
| Redirects | The browser is sent only to HTTPS `*.paypal.com` (server and client). | PP-04 |
| Database | Connection-wait (15 s) and query (20 s) timeouts; keep-alive; lock waits with their own limit; schema migration with bounded lock waits; additive, rollback-safe migration. | PP-03, PP-21 |
| Frontend | A double-click guard; the token is stored per tab and cleared on cancel or for an unknown order. | PP-24 |
| Container | Node as PID 1 (verified clean SIGTERM exit); healthcheck; no `.env` file; non-root user; BOM removed from `.dockerignore`. | PP-09, PP-26 |
| Production footprint | The server never loads the SQLite driver, and the runtime image no longer contains it or any compiled test: it is a development dependency, the build is limited to `src/index.ts`, and a Jenkins check enforces both. | PP-16, PP-27 |
| Frontend headers | `client/public/_headers`: a CSP checked in headless Chrome, plus anti-framing, `nosniff`, referrer, permissions and HSTS headers. | PP-17 |
| AI error wording | Gemini-mode errors no longer tell users to check Ollama. | PP-30 |
| Leaked Sandbox secret | Rotated and the old one disabled (owner-reported); Git objects pruned and rescanned clean (verified). | PP-18 |
| CI | Jenkinsfile for Linux or Windows agents, with type checks, image build, integration tests in the image, smoke test, and gated GHCR publish and Render deploy. | CI readiness |

## 3. What remains unresolved

| Item | Why it remains | What to do |
| --- | --- | --- |
| Abuse within the limits (R-1) | No user accounts | Accepted for the demo; raise or lower the limits as needed |
| Per-client limits shared behind Render (R-2, PP-28) | Render's proxy hop count and `X-Forwarded-For` handling are not documented | Leave `TRUST_PROXY` unset |
| PayPal behaviour tested only with mocks (R-6) | Live Sandbox use is manual by rule | M-3 to M-6 |
| Jenkins never run (R-8) | No Jenkins instance yet | First build per section 8 |
| PP-10, PP-11, PP-12, PP-13, PP-14, PP-15, PP-28, PP-29 | Informational recommendations, or changes to the payment path beyond what's needed | See `SECURITY_AUDIT_REPORT.md` |
| Old PayPal secret disabled | Owner-reported; I never stored the old secret, so I can't test it | If in doubt, check the app's credentials in the PayPal Developer Dashboard |

## 4. Test results (all actually run on 11 November 2026, after round 3)

| Check | Result |
| --- | --- |
| Server type check / unit tests / build | pass / **219 of 219** / pass (19 modules, no tests) |
| PostgreSQL integration (local database) | **22 of 22** |
| PostgreSQL integration inside the Docker image (fresh throwaway database) | **22 of 22** |
| Server unit tests inside the Docker image (Linux) | **219 of 219** |
| Runtime image contents check (Jenkins command, `sh` and `bat` quoting) | pass; the build image correctly fails it |
| Frontend CSP in headless Chrome (local build) | no violations; a broken-policy control is detected |
| Git object secret rescan (loose and packed) | no findings |
| Client type check / tests / lint / build | pass / **84 of 84** / 1 existing warning, 0 errors / pass |
| `npm audit` server and client | 0 / 0 vulnerabilities |
| Docker build (build and runtime) | pass |
| Image smoke test | **11 of 11** checks |
| Container exit code on SIGTERM | 0 |
| Jenkinsfile Groovy compile | pass (Jenkins-provided classes aside) |
| Mutation checks (ownership, approval, import boundary, AI error wording) | all detected |

Nothing failed and nothing was skipped.

Not executed:
- live Sandbox payments by me (the owner reports one, on the pre-audit code);
- production checks after the fixes;
- a real Jenkins run, GHCR push or Render deploy;
- a browser click-through and mobile tests of the deployed site;
- Gitleaks.

## 5. Production configuration

### Render (backend environment variables)

| Variable | Required | Value | Secret |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | The Neon connection string (pooled endpoint), with `sslmode=require` | **yes** |
| `PAYPAL_CLIENT_ID` | yes | The Sandbox app's client ID | yes |
| `PAYPAL_CLIENT_SECRET` | yes | The Sandbox app's current (rotated) secret | **yes** |
| `PAYPAL_BASE_URL` | no | Unset, or `https://api-m.sandbox.paypal.com` | no |
| `AI_PROVIDER` | yes | `gemini` | no |
| `GEMINI_API_KEY` | yes | Free-tier key with no billing attached | **yes** |
| `GEMINI_MODEL` | no | Default `gemini-2.5-flash` | no |
| `CLIENT_ORIGINS` | yes | `https://rapid-fire-08f4.namanshahnemi.workers.dev` | no |
| `AI_REQUESTS_PER_MINUTE` | recommended | At most half of the key's per-minute limit in AI Studio (default 5) | no |
| `AI_DAILY_REQUEST_LIMIT` | recommended | At most half of the key's per-day limit in AI Studio (default 100) | no |
| `SHUTDOWN_GRACE_MS` | no | A few seconds below Render's shutdown grace period (default 25000) | no |
| `TRUST_PROXY` | no | Leave unset | no |
| `PORT` | set by Render | — | no |

Why the AI limits are halved: one analysis can make two model calls. Third-party reports of the Gemini 2.5 Flash free tier range from about 20 to 1,500 requests per day; only AI Studio shows your project's real limit.

### Cloudflare (frontend build)

| Variable | Value | Note |
| --- | --- | --- |
| `VITE_API_URL` | `https://paypilot-api-latest.onrender.com` | Build-time and public. `client/.env.production` is git-ignored, so a build from Git must set it in Cloudflare. |

**Frontend security headers** need no Cloudflare dashboard setting: `client/public/_headers` is copied into the build output, and Cloudflare Workers static assets apply it on deploy. Two caveats:
- **API origin:** the CSP's `connect-src` names `https://paypilot-api-latest.onrender.com`. If `VITE_API_URL` changes, change it there too, or every API call is blocked.
- **Worker script:** `_headers` applies only to responses served as static files. If the Worker is ever given its own script that answers requests, that script must set the headers instead.

## 6. Deployment order and rollback

1. Deploy the backend. The schema upgrade (adding `checkout_token_hash`) runs automatically at startup; it is additive.
2. Deploy the frontend immediately afterwards. Between the two, checkout and capture fail with a clear error; nothing is charged.
3. Run M-1 (read-only smoke test) and M-2 (configuration log line), then M-3 to M-6, and M-9 (frontend headers and console).
4. **Rollback:** redeploy the previous backend image and frontend build. The old code ignores the new nullable column, so no database change is needed. Orders created by the new version keep working with the old code. If only the CSP causes a problem, correct or remove `client/public/_headers` and redeploy the frontend alone.

Orders created before the deploy have no checkout token, so the API won't return or capture them; buyers start a new checkout (PP-29).

## 7. Manual PayPal Sandbox verification

Use only a Sandbox buyer account. The full steps and expected results are in `SECURITY_TEST_PLAN.md`, section 6:

| Check | What it covers |
| --- | --- |
| M-3 | Happy path: USD 5.00 completed, and a refresh does not capture again |
| M-4 | Cancel: no capture |
| M-5 | A forged return URL, and capturing with another session's token: `404` |
| M-6 | Capture before approval: nothing is sent to PayPal's capture endpoint; the order completes after approval |
| M-7 | Rate limit (outside judging time) |
| M-9 | Frontend security headers are present, and the console shows no CSP errors during a full run |

## 8. Jenkins configuration (local, in Docker Desktop)

### Controller image

The pipeline needs Node.js 22.18 or newer and a Docker CLI on the agent. A minimal local controller image (not tested here):

```dockerfile
FROM jenkins/jenkins:lts-jdk21
USER root
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
USER jenkins
```

Run it with the Docker socket mounted, so the pipeline can build images and start the throwaway database:

```bash
docker build -t paypilot-jenkins .
docker run -d --name jenkins -p 127.0.0.1:8080:8080 \
  -v jenkins_home:/var/jenkins_home \
  -v /var/run/docker.sock:/var/run/docker.sock \
  paypilot-jenkins
```

Security notes:
- Mounting the socket gives Jenkins full control of Docker Desktop. Keep Jenkins on `127.0.0.1` and run only this repository's pipeline.
- If Docker commands fail with "permission denied", the socket's group is not the `jenkins` user's; for a local-only setup, add `--group-add 0` to `docker run`.
- The pipeline needs no published database port. It uses a private Docker network, so it works both with the socket mount and on a Windows agent.

### Plugins

From the suggested set: Pipeline, Git, Credentials, Credentials Binding, Timestamper (optional). No Docker plugin is needed, because the pipeline calls the Docker CLI.

### Job

A Pipeline job (or Multibranch Pipeline) using "Pipeline script from SCM" with this repository and the `Jenkinsfile` path.

The first build runs with the defaults: CI and image stages, with no publish or deploy. Check that the Integration tests and Image smoke test stages pass before enabling `PUBLISH_IMAGE`.

### Credentials (Manage Jenkins → Credentials)

| ID | Kind | Contents | Used by |
| --- | --- | --- | --- |
| `ghcr-publish` | Username with password | GitHub username and a personal access token with `write:packages` (and `read:packages`) | Publish image to GHCR |
| `render-deploy-hook` | Secret text | The Render service's deploy hook URL (Render dashboard → Settings → Deploy Hook) | Deploy to Render |

Both are read only inside `withCredentials`, so Jenkins masks them in the log. Neither is needed for the default CI build.

GHCR packages are private by default. Either make the package public, or add a registry credential with `read:packages` to the Render service, so Render can pull the image.

### Stages and gates

| Stage | Runs when |
| --- | --- |
| Checkout, toolchain, `npm ci`, type check, unit tests, lint, build, audit | always |
| Docker image, integration tests (throwaway PostgreSQL), image contents check, image smoke test | `BUILD_IMAGE` (default on) |
| Publish image to GHCR (`sha-<commit>`, `build-<n>`, `latest`) | `PUBLISH_IMAGE`, `main` branch, and every earlier stage `SUCCESS` (an unstable audit blocks it) |
| Deploy to Render, then a read-only smoke test of production | `DEPLOY_TO_RENDER` too, after a manual "Deploy" approval |

The post section removes this build's containers, network and build image, and archives the npm audit reports.

## 9. Is deployment safe to proceed?

**Not yet: complete section 1 first.** Once the changes are reviewed, Render and Cloudflare are configured as in section 5, both parts are deployed together, and M-1 to M-6 and M-9 pass, the deployment is safe for the hackathon demo. The remaining risks (section 3) are accepted limits of a demo without user accounts.
