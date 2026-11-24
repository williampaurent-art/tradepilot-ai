import test from "node:test";
import assert from "node:assert/strict";
import { handleMarketDataRequest } from "../src/api/market-data.mjs";

test("multi-timeframe analysis combines five timeframes without placing orders", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const interval = url.searchParams.get("interval");
    const duration = ({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 })[interval];
    const now = Date.now();
    const candles = Array.from({ length: 100 }, (_, i) => {
      const close = 2300 + i * 0.12 + Math.sin(i / 4);
      return {
        time: now - (100 - i) * duration,
        open: close - 0.04, high: close + 0.2, low: close - 0.2, close, volume: 10
      };
    });
    return new Response(JSON.stringify({ candles }), { status: 200 });
  };
  try {
    const response = await handleMarketDataRequest(new Request("https://worker.test/api/v1/markets/XAUUSD/analysis"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.consensus.availableTimeframes, 5);
    assert.deepEqual(Object.keys(body.timeframes), ["M1", "M5", "M15", "H1", "H4"]);
    assert.equal(body.signalEligible, true);
    assert.equal(body.execution, "NO_ORDERS");
    assert.ok(body.consensus.score >= 0 && body.consensus.score <= 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analysis endpoint rejects unsupported instruments and invalid limits", async () => {
  const unsupported = await handleMarketDataRequest(new Request("https://worker.test/api/v1/markets/FAKE/analysis"));
  assert.equal(unsupported.status, 404);
  const invalid = await handleMarketDataRequest(new Request("https://worker.test/api/v1/markets/XAUUSD/analysis?limit=20"));
  assert.equal(invalid.status, 400);
});

test("non-verified provider symbols are never signal eligible", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const duration = ({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 })[url.searchParams.get("interval")];
    const now = Date.now();
    const candles = Array.from({ length: 80 }, (_, i) => {
      const close = 1.1 + i * 0.0001;
      return { time: now - (80 - i) * duration, open: close, high: close + 0.0002, low: close - 0.0002, close };
    });
    return new Response(JSON.stringify({ candles }), { status: 200 });
  };
  try {
    const response = await handleMarketDataRequest(new Request("https://worker.test/api/v1/markets/EURUSD/analysis"));
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.consensus.availableTimeframes, 5);
    assert.equal(body.signalEligible, false);
    assert.match(body.warnings.join(" "), /non vérifiée/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
