-- Partner conversion postbacks. Store pseudonymous broker event IDs only; no client PII.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS partner_conversion_events (
 id TEXT PRIMARY KEY,
 provider TEXT NOT NULL CHECK (provider = 'vt_markets'),
 external_event_id TEXT NOT NULL,
 click_id TEXT,
 event_type TEXT NOT NULL CHECK (event_type IN ('registration','account_approved','first_deposit','first_trade','active_trader','commission')),
 occurred_at TEXT NOT NULL,
 received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 value_amount REAL CHECK (value_amount IS NULL OR value_amount >= 0),
 value_currency TEXT,
 country_code TEXT,
 campaign TEXT,
 UNIQUE(provider, external_event_id)
);
CREATE INDEX IF NOT EXISTS idx_partner_conversion_type_date ON partner_conversion_events(provider,event_type,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_conversion_click ON partner_conversion_events(provider,click_id);
CREATE INDEX IF NOT EXISTS idx_partner_conversion_date ON partner_conversion_events(provider,occurred_at DESC);
