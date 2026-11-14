# PayPilot AI

**A project workspace for freelancers: scope each client brief with AI, draft and review the proposal, and track it, with Pro features billed through PayPal Subscriptions (Sandbox).**

Freelancers lose money between "the client said yes" and "I got paid": scope that was never pinned down, terms that were assumed, and extra work that was never priced. PayPilot AI keeps one client's brief, scope analysis, proposal and risk review together in a saved project, and its AI never fills gaps with invented budgets, deadlines or quotes.

## What the product does

Each saved project follows five steps:

1. **Client brief:** paste the client's request. It is saved with the project and kept as the baseline.
2. **Scope analysis (AI):** deliverables, timeline, budget and revision terms, kept only when the brief actually states them. Otherwise they show as "Not specified" and appear in the missing terms and the questions to ask the client.
3. **Proposal (AI, Pro):** a structured draft with deliverables, acceptance criteria, exclusions, milestones, budget breakdown and payment schedule. Amounts and deadlines are quoted from the brief, never invented. Edit it and save it to the project.
4. **Risk review (AI, Pro):** automatic checks that update as you edit, plus an AI review that compares the proposal with the brief it was drafted from. Findings that don't quote the brief or the proposal are discarded.
5. **Project status:** the project (Lead, Active, Completed, Archived) and its proposal (Draft, Sent, Accepted, Rejected).

The **dashboard** shows total, active and completed projects, pending proposals (Draft or Sent), and the recent projects with their status. Open any project to continue where you left off. Everything is saved in PostgreSQL and survives a reload or a new session.

## Plans

| | Free | Pro |
|---|---|---|
| Price | USD 0 | 7-day free trial, then USD 5.00 per month (PayPal Sandbox subscription) |
| AI brief analyses | 2 per calendar month (UTC) | 30 per calendar month (UTC) |
| Saved projects, briefs and analyses, dashboard | Yes | Yes |
| AI proposal drafting | No | Yes |
| AI risk review | No | Yes |
| Saving proposals and risk reviews, proposal status tracking | No | Yes |

How plans are enforced:

- **The plan is decided on the server for every request.** Pro means the account has a subscription that PayPal reports as `ACTIVE`; the free trial counts. `APPROVAL_PENDING`, `SUSPENDED`, `CANCELLED` and `EXPIRED` are Free. Hiding a button in the browser is never the access control.
- **Analyses are counted in PostgreSQL** (`ai_usage`), one row per user, month and feature. Each count is taken by one atomic database statement, so repeated or concurrent requests can't exceed the limit. An analysis that fails is given back.
- **Over the limit:** Free gets `402` with `USAGE_LIMIT_REACHED` and an upgrade message; Pro gets `429` until the next month. Pro-only features return `402 SUBSCRIPTION_REQUIRED` to Free accounts.
- **After a subscription ends:** when PayPal reports the subscription as cancelled, suspended or expired, the account falls back to Free. Changes made outside the app may not be detected until the user checks the status manually or the backend refreshes the subscription during a Pro-feature request.
- `GET /api/usage` returns the plan, this month's usage and the features. The sidebar shows it.
- Drafting and reviews are not counted per user. They share the server-wide AI rate limits (see [Request limits](#request-limits)).

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite |
| Backend | Node.js, Express 5, TypeScript |
| AI | Google Gemini API (default model `gemini-2.5-flash`), or a local Ollama model |
| Database | PostgreSQL 17 (`pg` driver) |
| Payments | PayPal REST API, Sandbox only: Subscriptions v1, Orders v2, webhook signature verification |
| Testing | Node.js test runner |
| CI | Jenkins (`Jenkinsfile`) |

## Architecture

```text
 Browser (React + Vite)
   │  JSON over HTTPS; session in an HttpOnly cookie
   ▼
 Express API
   ├─ Accounts and sessions ......... /api/auth/*           (auth.ts)
   ├─ Projects ...................... /api/projects/*       (projects.ts)
   ├─ Plans and usage ............... /api/usage            (usage.ts)
   ├─ AI analysis / draft / review .. /api/proposals/*      (analysis.ts, proposalGenerator.ts, riskReview.ts)
   ├─ Subscriptions and webhooks .... /api/subscriptions/*, /api/paypal/webhooks   (subscriptions.ts)
   ├─ Admin (permission-gated) ...... /api/admin/*          (adminRoutes.ts)
   └─ One-time Sandbox orders ....... /api/payments/*       (checkoutRoute.ts, paymentRoutes.ts; no longer in the UI)
        │                 │                  │
        ▼                 ▼                  ▼
   Gemini API      PayPal Sandbox API    PostgreSQL
```

The browser never talks to PayPal's API, Gemini or the database directly. Every credential stays on the server.

Each AI route checks, in order: a signed-in session, then the permission (`proposal:create` or `proposal:review`), then the plan (the monthly analysis allowance, or Pro for drafting and review). Only then does the AI rate limit apply, so refused requests never use AI quota.

## PayPal integration

### Subscriptions: how Pro is verified

1. **Subscribe** (on the Account & billing page) asks the backend to create a subscription for the configured plan. The backend records it first, then creates it at PayPal, sending the record's ID as `custom_id`. It then sends the browser to PayPal's approval page.
2. The buyer approves in PayPal Sandbox, and PayPal returns the browser to `/?subscription=return`.
3. **The return proves nothing by itself.** The backend reads the subscription from PayPal with its own credentials (`GET /v1/billing/subscriptions/{id}`). It stores that status only if the PayPal subscription, the plan and `custom_id` all match this user's record.
4. Only `ACTIVE` unlocks Pro. When a Pro feature is used and the stored ACTIVE state was last read from PayPal more than 6 hours ago, it is read again first. **Check status** re-reads it on demand, and **Cancel subscription** cancels it at PayPal and then re-reads it.
5. Before selling anything, the backend checks the configured PayPal plan: ACTIVE, one free 7-day trial cycle, then USD 5.00 every month until cancelled, with no setup fee.

An older stored state never replaces a newer one, and a `CANCELLED` or `EXPIRED` subscription is never reopened.

**Verified so far:**
- creating a subscription, approving it with a Sandbox buyer account, and the status becoming ACTIVE through the server-side check (manual, in PayPal Sandbox);
- the plan check, against the real Sandbox plan;
- the lifecycle rules, with automated tests against a mocked PayPal.

### Webhooks: implemented but **not verified**

`POST /api/paypal/webhooks` accepts `BILLING.SUBSCRIPTION.*` events (including `CREATED`, `ACTIVATED`, `UPDATED`, `CANCELLED`, `SUSPENDED`, `EXPIRED` and `PAYMENT.FAILED`) and the subscription payment events `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED` and `PAYMENT.SALE.REVERSED`. Other event types are acknowledged and ignored.
- **Verification:** each delivery is confirmed with PayPal's signature-verification API, using the exact bytes received. Without `PAYPAL_WEBHOOK_ID` every delivery is refused (503).
- **Idempotency:** every event ID is stored, so a redelivered event is ignored. A delivery that fails (for example, the database is down) gets an error, so PayPal retries it.
- **Order:** a verified event only prompts the backend to re-read the subscription from PayPal, so events that arrive out of order can't restore an older state.
- **Payments:** a payment event is linked to its subscription through the sale's `billing_agreement_id`. A refund or reversal names only the sale, so the backend asks PayPal which subscription that sale paid. A payment event never grants, extends or removes Pro by itself; the subscription status PayPal reports decides.
- **Logs:** one line per delivery with the event ID, event type and outcome; never the payload, headers or payment details.

This behaviour is covered by automated tests with a mocked PayPal. **Real PayPal webhook delivery has not been tested.** PayPal can't reach `localhost`, and no `PAYPAL_WEBHOOK_ID` is configured. Locally, subscription changes made outside the app reach it through **Check status**, or the re-check when a Pro feature is used, not through webhooks.

### One-time Sandbox orders (backend only)

The earlier fixed USD 5.00 test checkout (Orders v2) has been removed from the interface, so the subscription is the product's only billing flow. The backend routes (`/api/payments/create-order`, `/capture-order`, `/orders/:id`) and their tests remain.
- **Checks:** the server fixes the amount and records the order before approval, and captures only after PayPal reports `APPROVED`. It marks an order paid only for a completed capture of exactly USD 5.00.
- **Idempotency:** each order uses a stable `PayPal-Request-Id`, and captures across backend instances are serialized with a PostgreSQL advisory lock.
- **Ownership:** each order is bound to the browser tab that started it by a 256-bit token stored only as a hash.

### Future, not implemented: client deposits and milestone payments

Turning an accepted proposal's payment schedule into a PayPal deposit or milestone payment request for the client is **planned, not built.** It would also need each freelancer's own PayPal account to receive the money, through PayPal's partner onboarding. Nothing in the current product moves money between a freelancer and their client.

`PAYPAL_BASE_URL` must be the PayPal Sandbox API. Any other value, such as the live API, stops the backend at startup. Use only Sandbox accounts; no real payment is made anywhere in this project.

## Accounts, sessions and permissions

- **Credentials:** register and sign in with an email and a password of 12 to 128 characters. Passwords are hashed with scrypt. There is **no email verification and no password reset.**
- **Sessions:** a session is a random 256-bit token in an HttpOnly cookie; the database stores only its SHA-256 hash.
  - Sessions expire after `SESSION_TTL_HOURS` (default 168), and logout revokes them on the server.
  - Signing in or registering always starts a new session.
- **Brute-force protection:** sign-in is rate-limited per address, and an email address is locked for 15 minutes after 5 failed attempts.
- **CSRF:** requests that change state and carry the session cookie must come from an origin in `CLIENT_ORIGINS`, and must be JSON.
- **Cookie mode:** in production (`NODE_ENV=production`) the cookie is `Secure; SameSite=None; Partitioned`, because the frontend and the API are on different sites. Locally it is `SameSite=Lax`.
  - Browsers that block third-party cookies, such as Safari by default, won't keep a production session.
  - An editor's embedded browser preview won't keep a local session either. Use a normal browser tab.
- **Roles:** every account has the `user` role. Code checks permissions, never role names.
  - Admins also get `admin:users:read`, `admin:users:update` and `admin:audit:read`.
  - Public registration never creates an admin. `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` create the first admin at startup, and never promote an existing account.
  - Admin endpoints: `GET /api/admin/users`, `POST /api/admin/users/:id/role` (never your own), `POST /api/admin/users/:id/sessions/revoke`, `GET /api/admin/audit-logs`.
- **Audit log:** security-relevant actions are written to `audit_logs`, without passwords, tokens or secrets.
- **Project privacy:** projects are private to their owner. Another user's project answers `404`, exactly like one that doesn't exist.

## Prerequisites

- Node.js 22.18 or newer (developed on Node.js 24) and npm. The frontend tests run TypeScript directly with `node --test`, which needs 22.18 or newer.
- Docker to run PostgreSQL locally, or another PostgreSQL 17 server.
- A PayPal Developer account with a **Sandbox** REST app (client ID and secret), plus a Sandbox **personal (buyer)** account for approving subscriptions.
- A Google Gemini API key, or Ollama with the `qwen2.5:3b` model.

## Local setup

```bash
git clone https://github.com/namanshahnemi-rgb/paypilot-ai.git
cd paypilot-ai
```

### 1. Start PostgreSQL

The repository has no Docker Compose file. Run PostgreSQL 17 with a named volume, so the data survives container restarts. Choose your own local password.

**Windows PowerShell:**

```powershell
docker run --name paypilot-postgres `
  -e POSTGRES_USER=paypilot `
  -e POSTGRES_PASSWORD=choose_a_local_password `
  -e POSTGRES_DB=paypilot `
  -p 127.0.0.1:5433:5432 `
  -v paypilot-postgres-data:/var/lib/postgresql/data `
  -d postgres:17-alpine
```

**macOS / Linux:**

```bash
docker run --name paypilot-postgres \
  -e POSTGRES_USER=paypilot \
  -e POSTGRES_PASSWORD=choose_a_local_password \
  -e POSTGRES_DB=paypilot \
  -p 127.0.0.1:5433:5432 \
  -v paypilot-postgres-data:/var/lib/postgresql/data \
  -d postgres:17-alpine
```

The database listens on `127.0.0.1:5433` only. Check that it's ready with `docker exec paypilot-postgres pg_isready -U paypilot -d paypilot`. Later, `docker stop paypilot-postgres` and `docker start paypilot-postgres` reuse the same container and data.

You don't create any tables: the backend applies its migrations at startup (see [Database](#database)).

### 2. Configure the backend

```bash
cd server
npm ci
```

Copy the example environment file (`Copy-Item .env.example .env` in PowerShell, `cp .env.example .env` elsewhere), then edit `server/.env`. The example contains only placeholders:

```env
PORT=4000
AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash

# PayPal Sandbox only. Any other URL (such as the live API) stops the server.
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
PAYPAL_CLIENT_ID=your_paypal_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_paypal_sandbox_client_secret

# Exact frontend origins, comma-separated: scheme and host (and port), no
# path, no trailing slash, no "*". Invalid entries are ignored and logged.
CLIENT_ORIGINS=http://localhost:5173,http://localhost:5174
# PostgreSQL connection string for the PayPal order registry (required).
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5433/paypilot

# Optional: how long shutdown waits for requests in progress (milliseconds).
# Set a few seconds below your host's shutdown grace period. Default 25000.
# SHUTDOWN_GRACE_MS=25000

# Optional: request limits (see "Request limits" in README.md).
# Number of proxies in front of the backend, so per-client limits use the
# real client address. Leave unset unless you know the hop count.
# TRUST_PROXY=1
# AI requests (analyze, draft, review together) allowed for all clients.
# One analysis can make two model calls, so set each to at most half of your
# Gemini key's limits shown in Google AI Studio. Defaults 5 and 100.
# AI_REQUESTS_PER_MINUTE=5
# AI_DAILY_REQUEST_LIMIT=100

# Accounts and sessions. The session cookie is HttpOnly; in production it is
# Secure, SameSite=None and Partitioned, because the frontend and the API are
# on different sites. Defaults: SameSite=Lax and not Secure locally, 168 hours.
# SESSION_COOKIE_SAMESITE=lax
# SESSION_COOKIE_SECURE=false
# SESSION_TTL_HOURS=168
# Optional: creates this admin account at startup if the email is not
# registered yet. An existing account is never promoted.
# BOOTSTRAP_ADMIN_EMAIL=admin@example.com
# BOOTSTRAP_ADMIN_PASSWORD=choose_a_long_random_password

# PayPal Sandbox subscription (7-day free trial, then USD 5.00 per month).
# Create the plan once with: npm run paypal:create-plan
PAYPAL_SUBSCRIPTION_PLAN_ID=your_sandbox_plan_id
# The webhook ID from the Sandbox app's Webhooks settings; without it every
# webhook is refused.
PAYPAL_WEBHOOK_ID=your_sandbox_webhook_id
```

Notes:

- **`DATABASE_URL`:** for the container above, use `postgresql://paypilot:<your local password>@127.0.0.1:5433/paypilot`, and URL-encode characters such as `@`, `:`, `/` or `#` in the password. The variable is required, and it is used for accounts, projects, subscriptions and orders. Without a reachable database the backend logs the reason and exits. The connection string is never logged.
- **`PAYPAL_SUBSCRIPTION_PLAN_ID`:** use the ID of an existing PayPal Sandbox subscription plan. If you do not have one, create it once with `npm run paypal:create-plan` from the `server` directory. The script creates a product and plan with a 7-day free trial followed by USD 5.00 per month, verifies the plan and prints its ID. Save that ID in `server/.env` and reuse it. Do not run the script again if you already have a configured plan.
- **`PAYPAL_WEBHOOK_ID`:** leave the placeholder, or remove the line, for local use. Webhooks need a public URL (see above).
- **Restart after editing `server/.env`.** The backend reads it only at startup, and `npm run dev` restarts on code changes but not on `.env` changes.
- Never commit `server/.env` or any credential.

### 3. Start the backend

```bash
cd server
npm run dev      # http://localhost:4000, restarts on code changes
```

The startup log ends with a `Configuration:` line, which contains no secrets. Check `subscriptionPlanConfigured: true` there before trying to subscribe.

To run the compiled backend instead: `npm run build`, then `npm start`. The build uses `tsconfig.build.json`, which compiles only what the server loads; `npx tsc --noEmit -p .` type-checks everything, tests included.

Health checks: `GET /api/health` (the backend and the configured AI provider), `GET /api/ai/health` (the Gemini key and model), `GET /api/payments/health` (whether the PayPal Sandbox credentials authenticate).

### 4. Start the frontend

```bash
cd client
npm ci
npm run dev      # http://localhost:5173 (or 5174 if 5173 is taken)
```

Open it in a **normal browser tab**. The frontend calls `http://localhost:4000` unless `VITE_API_URL` is set at build time. For a separately hosted backend:
- set `VITE_API_URL`;
- add the frontend's origin to `CLIENT_ORIGINS`;
- put the backend URL in `connect-src` in `client/public/_headers`.

### 5. Try it

1. **Account & billing:** create an account. The sidebar shows **Free plan · 0 of 2 analyses**.
2. **Dashboard → New project:** enter a name, a client and a brief, then **Create project and open it**.
3. **Analyze project scope.** The analysis is saved to the project.
4. To use Pro: **Account & billing → Start 7-day free trial with PayPal**, then approve with your **Sandbox buyer** account. Back in the app the status should read **Active**; if it doesn't yet, select **Check status**.
5. **Generate proposal draft**, edit it, **Save proposal**, set the proposal status, and **Run AI review**. Everything is saved to the project.

## AI configuration

`AI_PROVIDER=gemini` with `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`, default `gemini-2.5-flash`) uses the Gemini API, so briefs and proposals are sent to Google. With `AI_PROVIDER=ollama`, or when it's unset, the backend uses `qwen2.5:3b` on a local Ollama server at `http://localhost:11434` (`ollama pull qwen2.5:3b`).

Briefs are treated as untrusted input: they reach the model only as user content, never as instructions. AI output is validated field by field. Use synthetic data for demonstrations.

## Database

The backend applies versioned migrations at startup, each in a transaction under a PostgreSQL advisory lock, and records them in `schema_migrations`:

| Version | Adds |
|---|---|
| 1, 2 | `paypal_orders` (one-time Sandbox orders); its checkout-token hash |
| 3 | `users`, `user_roles`, `sessions` (token hashes only), `audit_logs` |
| 4 | `subscriptions`, `paypal_webhook_events` (idempotency) |
| 5 | `projects` (brief, analysis, proposal, risk review, budget, deadline, statuses), `ai_usage` (monthly counts) |

All migrations only add tables or columns. Every query has a time limit (20 seconds, longer only while a capture waits for another instance's lock), and waiting for a connection is limited to 15 seconds, so a database outage gives a JSON error instead of hanging. For deployment, use a managed, backed-up PostgreSQL database, and provide `DATABASE_URL` through the platform's secret settings.

## Graceful shutdown

On SIGINT (Ctrl+C) or SIGTERM, the backend:
1. stops accepting connections, and answers late requests with `503` and `Retry-After: 5`;
2. waits up to `SHUTDOWN_GRACE_MS` (default 25000) for requests in progress, including a payment capture;
3. closes the database pool.

An unfinished capture is rolled back and retried safely with the same `PayPal-Request-Id`. On Windows, test this with Ctrl+C.

## Running tests

Automated tests use mocked PayPal and AI responses. They make no payments and need no PayPal or AI credentials.

| Command | What it runs |
|---|---|
| `cd server && npx tsc --noEmit -p .` | Type check of every server file, tests included |
| `cd server && npm test` | Server unit tests. No database needed; an in-memory SQLite registry stands in for orders |
| `cd server && npm run test:integration` | PostgreSQL integration tests: orders, accounts, sessions, roles, subscriptions, webhooks, projects, usage |
| `cd server && npm run build` | Production build |
| `cd client && npx tsc -b` | Client type check |
| `cd client && npm test` | Client unit tests |
| `cd client && npm run lint` | Lint (oxlint) |
| `cd client && npm run build` | Production build |
| `npm audit` in `server` and `client` | Dependency vulnerability check |

The integration tests use the database in `DATABASE_URL`; a value set in the shell takes precedence over `server/.env`. They don't touch existing data:
- order tests add only rows with their own `ITEST-` prefix and delete only those;
- account, subscription and project tests run in a private schema that is dropped at the end.

If PostgreSQL isn't reachable, they fail with the reason; set `PG_INTEGRATION_ALLOW_SKIP=1` to skip them instead.

## Continuous integration

`Jenkinsfile` runs on a Linux or Windows Jenkins agent with Node.js 22.18 or newer, plus a Docker CLI for the image stages. Every build:
- installs both packages from their lockfiles;
- type-checks, tests, lints and builds both;
- audits the dependencies.

With `BUILD_IMAGE` (on by default) it also builds the backend Docker image, checks that the runtime image contains no test-only code, runs the integration tests inside the image against a throwaway PostgreSQL container, and smoke-tests the image.

Publishing to GHCR (`PUBLISH_IMAGE`) and the Render deploy hook (`DEPLOY_TO_RENDER`, after a manual approval) are off by default. They use the Jenkins credentials `ghcr-publish` and `render-deploy-hook`; no credential is stored in the repository. See `security-audit/DEPLOYMENT_READINESS.md`.

## Request limits

On top of the per-account plan limits, the backend limits how often public endpoints can be called, per client address and in total. This protects the Gemini quota and the database. Over a limit it answers `429` with `Retry-After`.

| Endpoints | Per client | Total |
| --- | --- | --- |
| `/api/proposals/analyze`, `/draft`, `/review` (shared) | 30 per 10 minutes | `AI_REQUESTS_PER_MINUTE` per minute (default 5) and `AI_DAILY_REQUEST_LIMIT` per 24 hours (default 100) |
| `/api/auth/login` | 20 per 10 minutes, plus a 15-minute lock per email after 5 failures | — |
| `/api/auth/register` | 10 per hour | — |
| `/api/subscriptions` (create, cancel) | 10 per 10 minutes | — |
| `/api/payments/create-order` | 20 per 10 minutes | 100 per hour |
| `/api/payments/capture-order`, `/api/payments/orders/:id` (shared) | 60 per minute | — |
| `/api/payments/health`, `/api/ai/health` | 10 per minute | 60 per minute (results cached for a minute) |

**About the AI limits:** Google shows each project's Gemini quota in AI Studio, and one analysis can make two model calls. So keep `AI_REQUESTS_PER_MINUTE` and `AI_DAILY_REQUEST_LIMIT` at no more than half of your key's limits.

**Where the limits are kept:** in memory, per backend process. Behind a proxy, every client shares the per-client limits unless `TRUST_PROXY` is set.

**Other request rules:**
- **Origins:** browser requests from an origin outside `CLIENT_ORIGINS` get `403`.
- **CORS** allows only `GET`, `POST`, `PUT` and `PATCH`, the `Content-Type` and `X-Checkout-Token` headers, and credentials for the listed origins only. CORS is not used as authentication.
- **JSON only:** `POST`, `PUT` and `PATCH` bodies must be JSON, otherwise `415`.
- **Security headers:** API responses carry them (CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS, `Cache-Control: no-store`), and unknown routes get a JSON `404`. The frontend's headers, including its Content Security Policy, are set in `client/public/_headers` for Cloudflare.

## Known limitations

- **PayPal Sandbox only.** No real payments, and no live PayPal configuration.
- **PayPal webhooks are unverified** with real PayPal deliveries (see above).
- **Client deposits and milestone payments are future work.** The only PayPal money flow in the product is the Pro subscription.
- No email verification or password reset.
- **No proposal version history, templates or project deletion.** Regenerating a proposal replaces the saved one, after a confirmation.
- **AI risk reviews can take up to about four minutes** when Gemini needs a second attempt.
- **Usage counting covers brief analyses only.** Pro drafting and reviews are bounded by the server-wide AI rate limits.
- **Session cookies:** Safari and other browsers that block third-party cookies won't keep a production session, and editor-embedded browsers won't keep a local one.
- **Stale reports:** the reports in `security-audit/` were written before accounts, subscriptions and projects were added. Treat this README as the current description.

## Security notes

- Never commit `.env` files, API keys, PayPal credentials, database connection strings or database files. `.gitignore` excludes `.env` and `.env.*` except `.env.example`.
- Keep backend credentials, including `DATABASE_URL`, on the server; never put them in `VITE_*` variables.
- Use only PayPal Sandbox accounts, and synthetic data for AI demonstrations.
- Set `CLIENT_ORIGINS` to exact origins before any public deployment.

## Project status

PayPilot AI is a hackathon project.

**Tested locally:**
- accounts and sessions;
- the Free and Pro plans, with PayPal Sandbox subscription approval and server-side verification;
- projects and the dashboard;
- AI analysis, drafting and risk review with Gemini;
- persistence across reloads and sessions.

**Untested:**
- real webhook delivery;
- production deployment of the current version.

## License

MIT. See [LICENSE](LICENSE).
