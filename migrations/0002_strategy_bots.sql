-- TradePilot Strategy Builder: isolated, user-owned strategy drafts.
-- Apply after 0001_saas_core.sql.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS strategy_bots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  instrument TEXT NOT NULL CHECK (instrument IN ('XAUUSD','EURUSD','GBPUSD','BTCUSD')),
  timeframe TEXT NOT NULL CHECK (timeframe IN ('M1','M5','M15','H1','H4','D1')),
  config_json TEXT NOT NULL CHECK (length(config_json) <= 12000),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PAUSED')),
  execution_mode TEXT NOT NULL DEFAULT 'ALERTS_ONLY' CHECK (execution_mode = 'ALERTS_ONLY'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_strategy_bots_workspace_updated
  ON strategy_bots(workspace_id, updated_at DESC);
