
const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"];

function sma(values, period) {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    const slice = values.slice(i + 1 - period, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function rsi(values, period = 14) {
  return values.map((_, i) => {
    if (i < period) return null;
    let gains = 0;
    let losses = 0;

    for (let j = i - period + 1; j <= i; j++) {
      const change = values[j] - values[j - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }

    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  });
}

function backtest(candles, strategy, options = {}) {
  const capitalInitial = Number(options.capital ?? 10000);
  const riskPercent = Number(options.riskPercent ?? 1);
  const feePercent = Number(options.feePercent ?? 0.02);

  if (!Array.isArray(candles) || candles.length < 50) {
    throw new Error("Il faut au moins 50 bougies historiques.");
  }

  if (!(capitalInitial > 0) || !(riskPercent > 0 && riskPercent <= 2)) {
    throw new Error("Capital invalide ou risque supérieur à 2 %.");
  }

  for (const c of candles) {
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite) ||
        c.high < c.low || c.high < c.open || c.high < c.close ||
        c.low > c.open || c.low > c.close) {
      throw new Error("Format OHLC invalide.");
    }
  }

  const closes = candles.map(c => c.close);
  const fast = sma(closes, 10);
  const slow = sma(closes, 20);
  const momentum = rsi(closes, 14);

  let capital = capitalInitial;
  let position = null;
  let trades = 0;
  let wins = 0;
  let equityPeak = capital;
  let maxDrawdown = 0;

  for (let i = 21; i < candles.length; i++) {
    const c = candles[i];
    let signal = 0;

    if (strategy === "trend") {
      if (fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]) signal = 1;
      if (fast[i] < slow[i] && fast[i - 1] >= slow[i - 1]) signal = -1;
    } else if (strategy === "breakout") {
      const previous = candles.slice(i - 20, i);
      const high = Math.max(...previous.map(x => x.high));
      const low = Math.min(...previous.map(x => x.low));
      if (c.close > high) signal = 1;
      if (c.close < low) signal = -1;
    } else if (strategy === "reversal") {
      if (momentum[i] !== null && momentum[i] < 30) signal = 1;
      if (momentum[i] !== null && momentum[i] > 70) signal = -1;
    }

    if (position && signal === -position.direction) {
      const gross = (c.close - position.entry) *
        position.direction * position.units;
      const fees = (position.entry + c.close) *
        position.units * feePercent / 100;
      const pnl = gross - fees;

      capital += pnl;
      trades++;
      if (pnl > 0) wins++;
      position = null;
    }

    if (!position && signal !== 0) {
      const riskMoney = capital * riskPercent / 100;
      const stopDistance = c.close * 0.005;
      const units = riskMoney / stopDistance;

      position = {
        entry: c.close,
        direction: signal,
        units
      };
    }

    equityPeak = Math.max(equityPeak, capital);
    maxDrawdown = Math.max(
      maxDrawdown,
      (equityPeak - capital) / equityPeak * 100
    );
  }

  if (position) {
    const last = closes[closes.length - 1];
    const gross = (last - position.entry) *
      position.direction * position.units;
    const fees = (position.entry + last) *
      position.units * feePercent / 100;
    const pnl = gross - fees;
    capital += pnl;
    trades++;
    if (pnl > 0) wins++;
  }

  return {
    strategy,
    startingCapital: capitalInitial,
    endingCapital: Number(capital.toFixed(2)),
    netProfit: Number((capital - capitalInitial).toFixed(2)),
    returnPercent: Number(
      ((capital / capitalInitial - 1) * 100).toFixed(2)
    ),
    trades,
    winRate: trades ? Number((wins / trades * 100).toFixed(2)) : 0,
    maxDrawdownPercent: Number(maxDrawdown.toFixed(2)),
    note: "Prototype: spread, slippage et spécifications du courtier non intégrés."
  };
}

function compareStrategies(candles, options = {}) {
  return ["trend", "breakout", "reversal"]
    .map(strategy => backtest(candles, strategy, options))
    .sort((a, b) => b.returnPercent - a.returnPercent);
}

function validateTimeframe(timeframe) {
  if (!TIMEFRAMES.includes(timeframe)) {
    throw new Error("Timeframe non supporté.");
  }
  return timeframe;
}

export {
  TIMEFRAMES,
  sma,
  rsi,
  backtest,
  compareStrategies,
  validateTimeframe
};

