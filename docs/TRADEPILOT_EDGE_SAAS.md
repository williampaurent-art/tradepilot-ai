# TradePilot Edge & SaaS foundation

## TradePilot Edge — active in the Worker code

- Only Telegram alerts marked as sent and fully confirmed are eligible for outcome measurement.
- The evaluator runs on the existing three-minute Cron and reads closed M1 candles.
- The first complete M1 candle after the alert timestamp is the first eligible candle.
- First TP/SL touch determines WIN or LOSS. If TP and SL are both touched in one candle, the result is AMBIGUOUS and excluded from win-rate/expectancy calculations.
- Alerts with neither level touched after 60 minutes become EXPIRED and are not counted as wins or losses.
- MFE and MAE are retained per tracked alert.
- `GET /edge-stats` returns sample size, observed win rate, average R/expectancy, buy/sell breakdown, pending, ambiguous and expired counts.
- History retention is capped at 3,500 records / seven days. This is an operational rolling sample, not a permanent research database.
- Important limitations: OHLC candle evaluation cannot determine the intrabar order when both levels are touched; spread, slippage, commissions, broker execution and user-specific fills are not simulated. A displayed win rate is descriptive, not a forecast.

## SaaS foundation — schema staged, not yet activated

`migrations/0001_saas_core.sql` defines the D1 data model for:
- external identity mapping (no password storage in this Worker);
- workspaces and roles;
- subscription records and server-side entitlements;
- read-only broker connection metadata with secret references, never raw credentials;
- workspace-scoped signal events and audit events.

The current production app still uses a shared Cloudflare KV journal and does not yet authenticate individual users. **Do not open public multi-user registration or sell subscriptions against this version yet.** The schema alone does not provide tenant isolation or access control.

## Activation sequence

1. Create a Cloudflare D1 database: `npx wrangler d1 create tradepilot-ai-db`.
2. Add its returned database ID to `wrangler.toml` under a `[[d1_databases]]` binding named `DB`.
3. Apply the migration: `npx wrangler d1 migrations apply tradepilot-ai-db --remote`.
4. Integrate an identity provider and verify signed sessions/JWTs server-side on every private API route.
5. Migrate the shared KV signal journal into `workspace_signal_events`; every query and write must be scoped by the authenticated workspace ID.
6. Add verified billing webhooks and enforce entitlements in the Worker, never only in the browser.
7. Keep broker credentials in a secrets service and store only references in D1. Maintain READ_ONLY until a separately reviewed execution-safety design exists.

No D1 database ID, identity provider, billing provider, or broker secret has been fabricated or configured by this change.
