# TradePilot SaaS Foundation — Audit & Hardening Plan

Date: 2026-11-16
Scope: Phase 1 — security, tenant isolation, reliability
Repository baseline: `main`
Working branch: `feature/saas-foundation`

## Current architecture observed

- Cloudflare Worker entry point: `src/index.js`
- Cloudflare D1 binding: `DB`; KV binding: `TP_STATE`
- Supabase access tokens are verified against the project's JWKS before SaaS account provisioning.
- D1 provisions users, personal workspaces, owner memberships and a default Free subscription.
- Customer bot list/create/update/status/delete/analyze/signal-history handlers scope bot queries by both bot ID and workspace ID.
- Customer bot execution is explicitly marked read-only; generated bot drafts set `liveTrading: false`.
- Existing bot-engine tests use Node's built-in test runner; the deploy workflow runs them before deployment.

## Findings to resolve before a wider SaaS launch

### P1 — Confirm and enforce the public/private API boundary

The Worker serves shared market/dashboard/history routes without Supabase workspace authentication, including `/dashboard-data`, `/edge-stats`, `/signal-history`, `/x10`, `/gold`, `/calendar`, and `/analyze`. These are classified as public platform data. The standalone compute endpoints `POST /api/bot-analyze` and `POST /assistant-chat` have since been moved behind Supabase workspace authentication.

This may be intentional for public market data and pre-login previews. Before changing behavior, map each route to its frontend caller and decide whether it is:
- public market information,
- authenticated personal/workspace information, or
- an explicitly rate-limited public preview.

Any user-specific records must be moved behind verified workspace authentication and workspace-scoped storage. Do not expose global KV history as a substitute for a user's private trading journal.

### P1 — CORS and browser access policy

The original wildcard CORS policy has been removed. Same-origin requests are allowed by default; any separate frontend origin must be explicitly added to `CORS_ALLOWED_ORIGINS`. Verify the deployed allow-list before connecting a broker portal hosted on another domain.

### P1 — Request validation and abuse controls

AI chat and bot-analysis now enforce body-size limits and per-workspace rate limits; customer bot create/update/status handlers enforce bounded JSON parsing. Telegram test remains protected by its server-side secret. Add edge-level limits for public market-data endpoints before opening them to high-volume third-party use.

### P1 — Authentication and tenant-isolation regression tests

Current regression tests cover CORS allow-list behavior, workspace-specific rate-limit counters, body-size/JSON validation, authenticated route guards and existing workspace-scoped bot SQL. Still add integration tests with mocked Supabase JWKS and D1 to prove missing/expired/wrong-issuer tokens are rejected and workspace A cannot access workspace B's records.

### P2 — Reliability and operational readiness

- Add structured error categories and request correlation IDs without logging access tokens or secrets.
- Add health checks for required D1/KV/Supabase configuration, while avoiding secret disclosure.
- Document D1 migration and rollback/recovery procedures.
- Ensure CI runs all tests and static checks on pull requests, not only during the production deployment workflow.
- Keep production deployment restricted to the protected default branch and do not run production migrations from feature branches.

## Recommended implementation sequence

1. Inventory frontend callers and classify every Worker route as public, authenticated-user, or workspace-admin.
2. Implement the route policy and tenant-scope any personal data endpoints.
3. Add authentication, authorization, CORS and cross-workspace regression tests.
4. Add request limits/rate limiting and operational checks.
5. Expand CI to run on pull requests; retain production deploy only on `main`.

## Safety constraints

- No live order execution is introduced by this phase.
- Broker connections remain read-only.
- Do not change production D1 data or deploy the Worker from this feature branch.
- Do not convert existing global market/signal history into private user data without a migration and explicit product decision.

## Audit limitations

This is a source-level review of the Worker, D1 SaaS foundation, Wrangler configuration, existing bot-engine tests and deployment workflow. It is not a penetration test, a production configuration inspection, or proof that the deployed environment matches the repository.


## Implemented on `feature/saas-foundation`

- Removed wildcard CORS. Same-origin browser requests are allowed; additional origins must be listed exactly in the Worker environment variable `CORS_ALLOWED_ORIGINS` as comma-separated origins (scheme + host + optional port, no path).
- CORS preflight now validates origin, requested method and requested headers. Bearer-token requests do not use cookie credentials.
- `POST /assistant-chat` and `POST /api/bot-analyze` now require a valid Supabase access token and a provisioned workspace.
- AI chat is limited to 12 requests per workspace per 10-minute fixed window; standalone bot analysis is limited to 20 requests per workspace per 10-minute fixed window. Customer bot creation is limited to 10 per workspace per hour; updates and status changes to 30 per 10 minutes; stored-bot analysis to 20 per 10 minutes; and deletion to 10 per 10 minutes. If KV is unavailable, these paid/compute-intensive endpoints fail closed with HTTP 503.
- The dashboard assistant now uses the shared authenticated session helper.
- Added tests for exact-origin CORS behavior, per-workspace rate-limit separation, fail-closed behavior and authenticated route guards.

### Data classification (important)

Private customer strategy data remains in D1 tables `trading_bots` and `bot_signal_events`; customer bot handlers select or mutate rows with the authenticated `workspace_id`. The scheduled bot processor writes each signal with the originating bot's workspace ID.

The following routes remain public because they expose shared platform market/strategy information rather than customer records: `/dashboard-data`, `/gold`, `/calendar`, `/signal-history`, `/edge-stats`, and `/x10`. In particular, the current X10 virtual position and global signal history are platform-wide demonstration/market feeds, **not a personal user portfolio or private journal**. Do not place customer-specific records in those shared KV keys. If TradePilot should offer each customer a private X10 portfolio, implement it as a separate workspace-keyed D1 feature and process each workspace independently before exposing it as a customer account.

### Rate-limit limitation

The current limiter uses a per-workspace fixed-window counter in Cloudflare KV. KV counters are eventually consistent and are not atomic under high concurrency; they provide an abuse-control layer, not a strict financial quota. Before a public paid launch, add Cloudflare Rate Limiting or another atomic quota service at the edge. The application fails closed when KV is missing or errors.

### Deployment

These changes are on the feature branch only. They do not alter production secrets, D1 data, Worker deployment, broker permissions or order execution.
