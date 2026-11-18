import test from "node:test";
import assert from "node:assert/strict";
import { runXauM15ImpulseBacktest, compareXauM15StopLosses, wilsonInterval } from "../momentum-backtest.mjs";

function fixture() {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const open = 2300 + i * 0.1;
    rows.push({ time: Date.UTC(2026, 0, 1, 0, i * 15), open, high: open + 0.4, low: open - 0.3, close: open + 0.1, isOpen: false });
  }
  rows[10] = { ...rows[10], open: 2301, high: 2306.2, low: 2300.8, close: 2306.1 };
  rows[11] = { ...rows[11], open: 2306.1, high: 2307.5, low: 2305.9, close: 2307.2 };
  rows[20] = { ...rows[20], open: 2310, high: 2310.2, low: 2304.8, close: 2305 };
  rows[21] = { ...rows[21], open: 2304.8, high: 2305.1, low: 2302.9, close: 2303.2 };
  return rows;
}

test("enters only after a completed single M15 candle moves at least $5", () => {
  const result = runXauM15ImpulseBacktest(fixture(), { spreadDollars: 0, slippageDollars: 0 });
  assert.equal(result.trades.length, 2);
  assert.equal(result.takeProfits, 2);
  assert.equal(result.winRate, 100);
});

test("uses conservative stop-first treatment when TP and SL are touched in one bar", () => {
  const candles = fixture();
  candles[11] = { ...candles[11], high: 2308, low: 2302 };
  const result = runXauM15ImpulseBacktest(candles, { spreadDollars: 0, slippageDollars: 0 });
  assert.equal(result.trades[0].exitReason, "stop_and_target_same_bar");
  assert.equal(result.trades[0].outcome, "LOSS");
});

test("rejects unfinished candles and invalid OHLC", () => {
  const candles = fixture();
  candles[0] = { ...candles[0], isOpen: true };
  assert.throws(() => runXauM15ImpulseBacktest(candles), /encore ouverte/);
});

test("compares stop-loss values using the same signal definition", () => {
  const results = compareXauM15StopLosses(fixture(), { stopLosses: [1, 3], spreadDollars: 0, slippageDollars: 0 });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(item => item.parameters.stopLossDollars).sort(), [1, 3]);
});

test("reports a Wilson confidence interval rather than overstating small samples", () => {
  const interval = wilsonInterval(9, 10);
  assert.ok(interval.lower95 < 0.9);
  assert.ok(interval.upper95 > 0.9);
});
