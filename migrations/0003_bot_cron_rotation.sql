-- Rotate active customer bot analysis fairly across Cron invocations.
-- Keeps each invocation bounded while ensuring every active bot gets a turn.
ALTER TABLE trading_bots ADD COLUMN last_evaluated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_trading_bots_active_rotation
  ON trading_bots(status, last_evaluated_at, created_at);
