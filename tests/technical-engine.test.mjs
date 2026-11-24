import test from "node:test";
import assert from "node:assert/strict";
import { ema, rsi, macd, bollinger, atr, adx, analyzeTechnical } from "../src/engines/technical/index.mjs";

const candles = Array.from({ length: 100 }, (_, i) => {
  const close = 100 + i * 0.25 + Math.sin(i / 3);
  return { time: i, open: close - 0.1, high: close + 0.5, low: close - 0.5, close, volume: 10 };
});

test("EMA aligns warm-up values and calculates a rising series", () => {
  const result = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(result.slice(0, 2), [null, null]);
  assert.equal(result[2], 2);
  assert.ok(result[4] > result[3]);
});

test("RSI stays within 0..100 and handles a no-loss series", () => {
  const result = rsi([1,2,3,4,5,6], 3);
  assert.equal(result[3], 100);
  assert.ok(result.every(v => v === null || (v >= 0 && v <= 100)));
});

test("MACD and Bollinger expose aligned arrays", () => {
  const m = macd(Array.from({length: 60}, (_,i)=>100+i));
  const b = bollinger(Array.from({length: 30}, (_,i)=>100+i));
  assert.equal(m.histogram.length, 60);
  assert.ok(m.histogram.at(-1) > 0);
  assert.ok(b.upper.at(-1) > b.middle.at(-1));
  assert.ok(b.lower.at(-1) < b.middle.at(-1));
});

test("ATR and ADX return finite values after warm-up", () => {
  assert.ok(Number.isFinite(atr(candles, 14).at(-1)));
  assert.ok(Number.isFinite(adx(candles, 14).at(-1)));
});

test("technical analysis is transparent and refuses insufficient history", () => {
  assert.equal(analyzeTechnical(candles.slice(0, 30)).eligible, false);
  const result = analyzeTechnical(candles);
  assert.equal(result.eligible, true);
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(["bullish", "bearish", "neutral"].includes(result.bias));
  assert.ok(result.levels.support <= result.price);
  assert.ok(result.levels.resistance >= result.price);
});
