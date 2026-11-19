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

Returns 30-day click totals, conversion counts by event type, daily counts, and the 50 most recent event summaries. It does not estimate missing events and does not expose client PII.

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
