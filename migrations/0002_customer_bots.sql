-- Per-workspace strategy storage. No client data is stored in shared KV.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS trading_bots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  instrument TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  style TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  strategy_json TEXT NOT NULL,
  market_validation_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_trading_bots_workspace_created
  ON trading_bots(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_signal_events (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES trading_bots(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  instrument TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('ACHAT','VENTE')),
  timeframe TEXT NOT NULL,
  entry REAL NOT NULL,
  stop_price REAL,
  target_price REAL,
  score INTEGER,
  rationale_json TEXT,
  market_timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(bot_id, market_timestamp, side)
);

CREATE INDEX IF NOT EXISTS idx_bot_signals_workspace_time
  ON bot_signal_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_signals_bot_time
  ON bot_signal_events(bot_id, created_at DESC);
