import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const factorySource = workerSource.replace("export default {", "const __worker = {");
const engine = new Function(factorySource + "; return { evaluateConfiguredBot, validateBotConfig };")();

function config(overrides = {}) {
  return engine.validateBotConfig({
    name: "Test Gold",
    symbol: "XAUUSD",
    style: "scalping",
    timeframe: "M5",
    capital: 1000,
    riskPercent: 0.5,
    dailyLossPercent: 2,
    maxPositions: 1,
    indicators: ["EMA 9/21", "MACD", "Structure / liquidité", "ATR 14"],
    direction: "Achats et ventes",
    ...overrides
  });
}

function candles(direction = "up") {
  const now = Date.now();
  const interval = 300000;
  const end = Math.floor(now / interval) * interval;
  const rows = [];
  for (let i = 0; i < 240; i++) {
    const drift = direction === "up" ? i * 0.12 : direction === "down" ? -i * 0.12 : 0;
    const close = 4000 + drift;
    const open = close - (direction === "down" ? -0.04 : 0.04);
    rows.push({
      time: end - (240 - i) * interval,
      open,
      high: Math.max(open, close) + 0.16,
      low: Math.min(open, close) - 0.12,
      close,
      isOpen: false
    });
  }
  if (direction === "up") {
    rows.at(-1).close += 1.2;
    rows.at(-1).high = rows.at(-1).close + 0.1;
  }
  if (direction === "down") {
    rows.at(-1).close -= 1.2;
    rows.at(-1).low = rows.at(-1).close - 0.1;
  }
  return rows;
}

const quote = {
  bid: 4000,
  ask: 4000.2,
  mid: 4000.1,
  spread: 0.2,
  timestamp: new Date().toISOString(),
  quoteAgeSeconds: 1,
  source: "test"
};

test("rejects a strategy with fewer than two directional indicators", () => {
  assert.throws(() => config({ indicators: ["EMA 9/21", "ATR 14"] }), /deux indicateurs directionnels/);
});

test("produces a buy setup from aligned bullish indicators", () => {
  const result = engine.evaluateConfiguredBot(config(), candles("up"), quote);
  assert.equal(result.signal, "ACHAT");
  assert.ok(result.score >= result.threshold);
  assert.ok(result.stopLoss < result.entry);
  assert.ok(result.takeProfit > result.entry);
  assert.equal(result.riskReward, 1.8);
  assert.match(result.execution, /AUCUN ORDRE REEL/);
});

test("produces a sell setup from aligned bearish indicators", () => {
  const result = engine.evaluateConfiguredBot(config(), candles("down"), quote);
  assert.equal(result.signal, "VENTE");
  assert.ok(result.score >= result.threshold);
  assert.ok(result.stopLoss > result.entry);
  assert.ok(result.takeProfit < result.entry);
});

test("respects a buy-only strategy", () => {
  const result = engine.evaluateConfiguredBot(
    config({ direction: "Achats uniquement" }),
    candles("down"),
    quote
  );
  assert.notEqual(result.signal, "VENTE");
  assert.equal(result.side, null);
});

test("does not invent a direction in a flat market", () => {
  const result = engine.evaluateConfiguredBot(config(), candles("flat"), quote);
  assert.equal(result.signal, "ATTENDRE");
  assert.equal(result.stopLoss, null);
  assert.equal(result.takeProfit, null);
});


test("customer bot pages contain syntactically valid browser scripts", async () => {
  for (const path of ["../public/bots.html", "../public/builder.html"]) {
    const html = await readFile(new URL(path, import.meta.url), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0, `${path} should contain an inline application script`);
    for (const match of scripts) {
      assert.doesNotThrow(() => new Function(match[1]), `${path} inline script should parse`);
    }
  }
});
