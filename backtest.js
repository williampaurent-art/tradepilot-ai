
const CONFIG = {
  instrument: "XAUUSD",
  timeframe: "M15",
  initialCapital: 300,
  riskPercent: 1,
  strategies: ["trend", "breakout", "reversal", "custom"]
};

function sma(values, period, end) {
  if (end + 1 < period) return null;
  const slice = values.slice(end - period + 1, end + 1);
  return slice.reduce((sum, n) => sum + n, 0) / period;
}

function rsi(closes, period, end) {
  if (end < period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = end - period + 1; i <= end; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0) return gains === 0 ? 50 : 100;

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function getSignal(strategy, candles, i, customRules) {
  if (i < 20) return "HOLD";

  const closes = candles.map(c => c.close);
  const candle = candles[i];
  const fast = sma(closes, 10, i);
  const slow = sma(closes, 20, i);
  const momentum = rsi(closes, 14, i);

  if (strategy === "trend") {
    if (fast > slow && momentum > 50) return "BUY";
    if (fast < slow && momentum < 50) return "SELL";
  }

  if (strategy === "breakout") {
    const previous = candles.slice(i - 20, i);
    const high = Math.max(...previous.map(c => c.high));
    const low = Math.min(...previous.map(c => c.low));

    if (candle.close > high) return "BUY";
    if (candle.close < low) return "SELL";
  }

  if (strategy === "reversal") {
    if (momentum < 30) return "BUY";
    if (momentum > 70) return "SELL";
  }

  if (strategy === "custom" && customRules) {
    return customRules({ candles, index: i, smaFast: fast,
      smaSlow: slow, rsi: momentum }) || "HOLD";
  }

  return "HOLD";
}

function backtest(candles, strategy, options = {}) {
  if (!Array.isArray(candles) || candles.length < 100) {
    throw new Error("Il faut au moins 100 bougies historiques.");
  }

  for (const c of candles) {
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite)) {
      throw new Error("Bougie invalide : prix manquant ou non numérique.");
    }
    if (c.high < Math.max(c.open, c.close) ||
        c.low > Math.min(c.open, c.close) || c.high < c.low) {
      throw new Error("OHLC incohérents.");
    }
  }

  const initialCapital = options.initialCapital ?? CONFIG.initialCapital;
  const riskPercent = options.riskPercent ?? CONFIG.riskPercent;
  const stopDistancePercent = options.stopDistancePercent ?? 0.5;
  const spreadPerUnit = options.spreadPerUnit ?? 0;
  const feePerUnit = options.feePerUnit ?? 0;
  const customRules = options.customRules;

  if (initialCapital <= 0 || riskPercent <= 0 || riskPercent > 50) {
    throw new Error("Capital ou risque invalide (risque autorisé : 0–50 %).");
  }

  let equity = initialCapital;
  let peak = equity;
  let maxDrawdown = 0;
  let position = null;
  const trades = [];

  for (let i = 20; i < candles.length - 1; i++) {
    const current = candles[i];
    const next = candles[i + 1];

    if (position) {
      const stopHit = position.side === "BUY"
        ? current.low <= position.stop
        : current.high >= position.stop;

      const targetHit = position.side === "BUY"
        ? current.high >= position.target
        : current.low <= position.target;

      // Si stop et cible sont touchés dans la même bougie,
      // on suppose le stop touché en premier (hypothèse prudente).
      if (stopHit || targetHit) {
        const exit = stopHit ? position.stop : position.target;
        const gross = (exit - position.entry) *
          position.units * (position.side === "BUY" ? 1 : -1);
        const costs = position.units * (spreadPerUnit + feePerUnit);
        const pnl = gross - costs;

        equity += pnl;
        trades.push({ side: position.side, entry: position.entry,
          exit, pnl, reason: stopHit ? "STOP" : "TARGET" });
        position = null;
      }
    }

    if (!position) {
      const signal = getSignal(strategy, candles, i, customRules);
      if (signal !== "BUY" && signal !== "SELL") continue;

      // Entrée à l'ouverture de la bougie suivante, jamais à la clôture connue.
      const entry = next.open;
      const distance = entry * stopDistancePercent / 100;
      const riskCash = equity * riskPercent / 100;
      const units = riskCash / distance;

      position = {
        side: signal,
        entry,
        units,
        stop: signal === "BUY" ? entry - distance : entry + distance,
        target: signal === "BUY"
          ? entry + distance * 2
          : entry - distance * 2
      };
    }

    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
  }

  return {
    strategy,
    instrument: CONFIG.instrument,
    timeframe: CONFIG.timeframe,
    initialCapital,
    finalEquity: equity,
    netProfit: equity - initialCapital,
    trades: trades.length,
    wins: trades.filter(t => t.pnl > 0).length,
    losses: trades.filter(t => t.pnl <= 0).length,
    maxDrawdownPercent: maxDrawdown,
    profitFactor: profitFactor(trades),
    note: "Simulation pédagogique, pas un résultat de trading réel."
  };
}

function profitFactor(trades) {
  const gains = trades.filter(t => t.pnl > 0)
    .reduce((s, t) => s + t.pnl, 0);
  const losses = Math.abs(trades.filter(t => t.pnl < 0)
    .reduce((s, t) => s + t.pnl, 0));

  if (losses === 0) return gains > 0 ? null : 0;
  return gains / losses;
}

function compareStrategies(candles, options = {}) {
  return CONFIG.strategies.map(strategy =>
    backtest(candles, strategy, options)
  );
}

export { CONFIG, backtest, compareStrategies, getSignal };
