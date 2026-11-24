import test from "node:test";
import assert from "node:assert/strict";
import { getMarketAsset, getMarketTimeframe, listMarketAssets } from "../src/market-data/catalog.mjs";
import { normalizeBiQuoteCandles, fetchBiQuoteCandles } from "../src/market-data/biquote.mjs";

test("catalog exposes the ten initial instruments without claiming provider verification", () => {
  const markets = listMarketAssets();
  assert.equal(markets.length, 10);
  assert.equal(getMarketAsset("xauusd").symbol, "XAUUSD");
  assert.equal(getMarketAsset("UNKNOWN"), null);
  assert.equal(getMarketAsset("EURUSD").providerStatus, "not-yet-verified");
});

test("timeframe catalog is explicit and rejects unknown intervals", () => {
  assert.equal(getMarketTimeframe("M15").milliseconds, 900_000);
  assert.equal(getMarketTimeframe("W1"), null);
});

test("normalizer sorts, deduplicates, validates and removes unfinished candles", () => {
  const now = Date.UTC(2026, 0, 1, 0, 20);
  const payload = { data: [
    { time: now - 900_000, open: 100, high: 103, low: 99, close: 102, volume: 12 },
    { time: now - 1_800_000, open: 98, high: 101, low: 97, close: 100, volume: 10 },
    { time: now - 900_000, open: 100, high: 104, low: 99, close: 103, volume: 14 },
    { time: now, open: 103, high: 105, low: 102, close: 104 },
    { time: now - 2_700_000, open: 100, high: 99, low: 98, close: 99 }
  ] };
  const candles = normalizeBiQuoteCandles(payload, "M15", now);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].open, 98);
  assert.equal(candles[1].close, 103);
});

test("normalizer accepts array candles and second-based timestamps", () => {
  const now = Date.UTC(2026, 0, 1, 0, 20);
  const candles = normalizeBiQuoteCandles([[now / 1000 - 1_800, 100, 102, 99, 101, 5]], "M15", now);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].volume, 5);
});

test("provider fetch uses allowlisted symbols and normalized candle output", async () => {
  const now = Date.now();
  const rows = [];
  for (let i = 8; i >= 1; i--) {
    const time = now - i * 900_000;
    rows.push({ time, open: 100, high: 102, low: 99, close: 101, volume: 20 });
  }
  let requestedUrl = "";
  const result = await fetchBiQuoteCandles("XAUUSD", "M15", 30, {
    fetchImpl: async url => {
      requestedUrl = url;
      return new Response(JSON.stringify({ candles: rows }), { status: 200 });
    }
  });
  assert.match(requestedUrl, /XAUUSD\/ohlc/);
  assert.equal(result.symbol, "XAUUSD");
  assert.equal(result.count, 8);
  await assert.rejects(() => fetchBiQuoteCandles("NOTREAL", "M15", 30, {
    fetchImpl: async () => { throw new Error("must not fetch"); }
  }), /non autorisé/);
});

test("provider errors are surfaced rather than converted into market data", async () => {
  await assert.rejects(() => fetchBiQuoteCandles("XAUUSD", "M15", 30, {
    fetchImpl: async () => new Response("upstream down", { status: 503 })
  }), /HTTP 503/);
});
