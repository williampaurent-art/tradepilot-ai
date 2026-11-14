const CONFIG = {
  SERVICE: "TradePilot AI",
  SYMBOL: "XAUUSD",
  SOURCE_URL: "https://biquote.io/api/XAUUSD/ohlc",

  CAPITAL: 1000,
  LOTS_PER_1000: 0.5,
  LEVERAGE: 500,

  TARGET: 5,
  STOP: 5,
  EARLY_SCORE: 45,
  MIN_SCORE: 55,

  MAX_CANDLES: 250,
  COOLDOWN_MS: 6 * 60 * 1000,

  FRESHNESS_GRACE_MS: 60_000,
  LIVE_QUOTE_MAX_AGE_SECONDS: 60,
  QUALITY_LOOKBACK_MS: 2 * 60 * 60 * 1000,
  GAP_TOLERANCE_MS: 30_000
};

// TEMPORARY RESTORE - full file will be restored in next commit. Contact for full content if needed.
// The previous placeholder has been removed. The full original logic is being restored.

export default {
  async fetch(request, env) {
    return new Response(JSON.stringify({ ok: true, message: "Restore in progress - full code will be pushed shortly", liveTrading: false }), {
      headers: { "content-type": "application/json" }
    });
  },
  async scheduled(event, env, ctx) {
    // Placeholder
  }
};
