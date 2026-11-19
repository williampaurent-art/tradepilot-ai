# VT Markets partner conversion postbacks

This integration is prepared but is **not active until VT Markets agrees to send server-to-server postbacks** and the Cloudflare secrets are configured.

## Endpoint

`POST /api/partner/webhook`

Required header:

`x-vt-signature: sha256=<lowercase-hex-hmac>`

The signature is HMAC-SHA256 over the exact raw UTF-8 request body, using the shared `VT_PARTNER_WEBHOOK_SECRET`. Send JSON with `Content-Type: application/json` over HTTPS. The Worker rejects invalid signatures, oversized payloads, malformed events, events older than 180 days, and timestamps more than 10 minutes in the future.

## Event payload

```json
{
  "event_id": "broker-unique-event-id",
  "click_id": "clk_<uuid-from-tradepilot>",
  "event_type": "registration",
  "occurred_at": "2026-11-19T12:30:00Z",
  "country_code": "FR",
  "campaign": "tp_launch",
  "value_amount": null,
  "value_currency": null
}
```

Supported `event_type` values:
- `registration`
- `account_approved`
- `first_deposit`
- `first_trade`
- `active_trader`
- `commission`

`event_id` must be unique per broker event. Repeated event IDs are idempotent and return `duplicate: true`. If a click ID is supplied, it must match a click recorded by TradePilot. Do not send names, email addresses, phone numbers, account numbers, or MT5 credentials.

## Partner reporting

`GET /api/partner/dashboard`

Required header: `x-partner-dashboard-key: <PARTNER_DASHBOARD_KEY>`

Returns click totals, unique workspaces, a stage funnel (registration, first trade, active trader), daily click and conversion series, source/campaign breakdowns, commission totals grouped by currency, and the 50 most recent pseudonymous event summaries. The optional days query parameter accepts 7–365 days (default 30). Ratios are raw event-to-click ratios, not deduplicated customer cohort conversion rates. Unmatched postbacks are labelled unattributed. It does not estimate missing events and does not expose client PII.

## Cloudflare configuration

Configure both secrets in the Worker environment:

```bash
wrangler secret put VT_PARTNER_WEBHOOK_SECRET
wrangler secret put PARTNER_DASHBOARD_KEY
```

Use a long, random value for each secret. Never place either secret in frontend code or GitHub source files.

## Before enabling with the broker

1. Ask VT Markets' affiliate/IB team whether server-to-server conversion postbacks are supported for your partner account.
2. Confirm their exact click/sub-ID parameter name and whether the click ID can be returned unchanged.
3. Agree on event definitions, especially what qualifies as an approved account, first deposit, first trade, active trader, and commission.
4. Ask them to sign the raw payload with HMAC-SHA256 using the agreed shared secret and send the signature in `x-vt-signature`. If their platform supports a different signing format, adapt the verifier before activation.
5. Test duplicate events, unknown click IDs, invalid signatures, and each event type in a non-production environment.

Until the broker confirms and configures this contract, the dashboard will show only the events actually received (normally zero). A TradePilot click is not proof of account registration, deposit, trading activity, or commission.


## Attribution and reporting additions

TradePilot stores the portal's utm_source and utm_campaign values (or the fallback campaign value) with each authenticated broker click. The dashboard groups clicks by these values and attributes signed broker events to the matching click when the broker echoes its click ID.

Examples:
- Last 30 days: GET /api/partner/dashboard
- Last 90 days: GET /api/partner/dashboard?days=90

The dashboard reports event counts and raw click ratios. It cannot calculate unique registered clients or true customer-level conversion cohorts until VT Markets supplies a stable pseudonymous customer reference in the postback contract. Commission totals are kept separated by currency and are not combined.


## Internal dashboard UI

Open `/partner-dashboard.html` on the TradePilot deployment. The page asks for the dashboard key on each session and does not save it in browser storage. It shows campaign-level clicks and conversion events, funnel metrics, daily conversion counts and commission totals by currency. Access to the underlying API remains protected by the server-side dashboard key.
