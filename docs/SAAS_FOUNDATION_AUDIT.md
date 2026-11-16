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

The Worker currently serves several market/dashboard/history routes without Supabase workspace authentication, including `/dashboard-data`, `/edge-stats`, `/signal-history`, `/x10`, `/gold`, `/calendar`, and `/analyze`. The bot analysis preview route `POST /api/bot-analyze` is also unauthenticated.

This may be intentional for public market data and pre-login previews. Before changing behavior, map each route to its frontend caller and decide whether it is:
- public market information,
- authenticated personal/workspace information, or
- an explicitly rate-limited public preview.

Any user-specific records must be moved behind verified workspace authentication and workspace-scoped storage. Do not expose global KV history as a substitute for a user's private trading journal.

### P1 — CORS and browser access policy

The Worker currently returns `access-control-allow-origin: *` and allows generic browser origins. Define the supported production origins and make credentialed/session-bearing routes enforce an explicit origin policy. Keep public read-only market endpoints separate where wildcard CORS is an intentional product decision.

### P1 — Request validation and abuse controls

Review body-size limits, JSON parsing, rate limiting, and per-workspace quotas on public preview, assistant, Telegram-test and bot-analysis routes. Apply limits server-side; client-side limits are not security controls.

### P1 — Authentication and tenant-isolation regression tests

Add tests for:
- missing, malformed, expired, wrong-issuer and wrong-audience Supabase tokens;
- a user from workspace A cannot read, update, analyze, change status or delete a bot from workspace B;
- private endpoints reject unauthenticated requests;
- public endpoints return only intentionally public data;
- CORS headers match the configured route policy.

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
