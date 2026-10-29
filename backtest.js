
const CONFIG = {
  instrument: "XAUUSD",
  timeframe: "M15",
  strategies: ["trend", "breakout", "reversal", "custom"]
};

function sma(values, period, end) {
  if (end < period - 1) return null;
  return values.slice(end - period + 1, end + 1)
    .reduce((sum, value) => sum + value, 0) / period;
}

function calcRsi(closes, period, end) {
  if (end < period) return null;
  let gains = 0, losses = 0;

  for (let i = end - period + 1; i <= end; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

function signalFor(strategy, candles, i, customRules) {
  const closes = candles.map(c => c.close);
  const fast = sma(closes, 10, i);
  const slow = sma(closes, 20, i);
  const rsi = calcRsi(closes, 14, i);

  if (fast === null || slow === null || rsi === null) return "HOLD";

  if (strategy === "trend") {
    if (fast > slow && rsi > 50) return "BUY";
    if (fast < slow && rsi < 50) return "SELL";
  }

  if (strategy === "breakout") {
    const prior = candles.slice(i - 20, i);
    const high = Math.max(...prior.map(c => c.high));
    const low = Math.min(...prior.map(c => c.low));
    if (candles[i].close > high) return "BUY";
    if (candles[i].close < low) return "SELL";
  }

  if (strategy === "reversal") {
    if (rsi < 30) return "BUY";
    if (rsi > 70) return "SELL";
  }

  if (strategy === "custom" && typeof customRules === "function") {
    const result = customRules({ candles, index: i, fast, slow, rsi });
    return ["BUY", "SELL"].includes(result) ? result : "HOLD";
  }

  return "HOLD";
}

function backtest(candles, strategy, options = {}) {
  if (!Array.isArray(candles) || candles.length < 100) {
    throw new Error("Fournis au moins 100 bougies historiques.");
  }

  for (const c of candles) {
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite) ||
        c.low > Math.min(c.open, c.close) ||
        c.high < Math.max(c.open, c.close) ||
        c.high < c.low) {
      throw new Error("Bougie OHLC invalide.");
    }
  }

  const initialCapital = options.initialCapital ?? 300;
  const riskPct = options.riskPercent ?? 1;
  const stopPct = options.stopDistancePercent ?? 0.5;
  const costPerUnit = options.costPerUnit ?? 0;

  if (initialCapital <= 0 || riskPct <= 0 || riskPct > 50 ||
      stopPct <= 0 || costPerUnit < 0) {
    throw new Error("Paramètres de risque ou de coûts invalides.");
  }

  let equity = initialCapital;
  let peak = equity;
  let maxDrawdown = 0;
  let position = null;
  const trades = [];

  function closePosition(price, reason) {
    const direction = position.side === "BUY" ? 1 : -1;
    const pnl = (price - position.entry) *
      position.units * direction - position.units * costPerUnit;

    equity += pnl;
    trades.push({ side: position.side, entry: position.entry,
      exit: price, pnl, reason });
    position = null;
  }

  for (let i = 20; i < candles.length - 1; i++) {
    const c = candles[i];

    if (position) {
      const stopHit = position.side === "BUY"
        ? c.low <= position.stop : c.high >= position.stop;
      const targetHit = position.side === "BUY"
        ? c.high >= position.target : c.low <= position.target;

      // Hypothèse prudente si stop et cible touchés dans la même bougie.
      if (stopHit) closePosition(position.stop, "STOP");
      else if (targetHit) closePosition(position.target, "TARGET");
    }

    if (!position && equity > 0) {
      const side = signalFor(strategy, candles, i, options.customRules);
      if (side === "BUY" || side === "SELL") {
        const entry = candles[i + 1].open;
        const distance = entry * stopPct / 100;
        const riskCash = equity * riskPct / 100;

        position = {
          side, entry,
          units: riskCash / distance,
          stop: side === "BUY" ? entry - distance : entry + distance,
          target: side === "BUY" ? entry + 2 * distance : entry - 2 * distance
        };
      }
    }

    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
    }
  }

  if (position) closePosition(candles[candles.length - 1].close, "END_OF_TEST");

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const grossWins = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  return {
    strategy,
    instrument: CONFIG.instrument,
    timeframe: CONFIG.timeframe,
    initialCapital,
    finalEquity: equity,
    netProfit: equity - initialCapital,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    maxDrawdownPercent: maxDrawdown,
    profitFactor: grossLosses ? grossWins / grossLosses : null,
    note: "Simulation uniquement ; pas d'ordres réels."
  };
}

function compareStrategies(candles, options = {}) {
  return CONFIG.strategies.map(strategy =>
    backtest(candles, strategy, options)
  );
}

export { CONFIG, backtest, compareStrategies };

