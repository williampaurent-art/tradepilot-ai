const DEFAULTS = Object.freeze({ impulseDollars: 5, takeProfitDollars: 1, stopLossDollars: 3, maxHoldBars: 4, spreadDollars: 0.2, slippageDollars: 0.05, commissionPerUnit: 0 });

function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 3) throw new Error("Au moins trois bougies M15 sont nécessaires.");
  let previousTime = -Infinity;
  for (const candle of candles) {
    const values = [candle.open, candle.high, candle.low, candle.close];
    if (!values.every(Number.isFinite) || candle.high < candle.low || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) throw new Error("Données OHLC invalides.");
    if (candle.isOpen === true) throw new Error("Supprimez la bougie M15 encore ouverte.");
    const rawTime = candle.timestamp ?? candle.time ?? candle.openTime;
    if (rawTime !== undefined) {
      const time = typeof rawTime === "number" ? rawTime : Date.parse(rawTime);
      if (!Number.isFinite(time) || time <= previousTime) throw new Error("Les bougies doivent être triées chronologiquement sans doublons.");
      previousTime = time;
    }
  }
}

export function wilsonInterval(wins, total, z = 1.959963984540054) {
  if (!total) return { lower95: null, upper95: null };
  const p = wins / total, z2 = z * z, denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / total) + z2 / (4 * total * total)) / denominator;
  return { lower95: Number(Math.max(0, center - margin).toFixed(4)), upper95: Number(Math.min(1, center + margin).toFixed(4)) };
}

export function runXauM15ImpulseBacktest(inputCandles, overrides = {}) {
  validateCandles(inputCandles);
  const options = { ...DEFAULTS, ...overrides };
  const { impulseDollars, takeProfitDollars, stopLossDollars, maxHoldBars, spreadDollars, slippageDollars, commissionPerUnit } = options;
  if (!(impulseDollars > 0 && takeProfitDollars > 0 && stopLossDollars > 0) || !Number.isInteger(maxHoldBars) || maxHoldBars < 1 || [spreadDollars, slippageDollars, commissionPerUnit].some(v => !Number.isFinite(v) || v < 0)) throw new Error("Paramètres de backtest invalides.");

  const trades = [];
  let activeUntil = -1;
  for (let i = 0; i < inputCandles.length - 1; i++) {
    const impulse = inputCandles[i], move = impulse.close - impulse.open;
    if (Math.abs(move) < impulseDollars || i + 1 <= activeUntil) continue;
    const direction = move > 0 ? 1 : -1, entryIndex = i + 1;
    const rawEntry = inputCandles[entryIndex].open;
    const entry = rawEntry + direction * (spreadDollars / 2 + slippageDollars);
    const target = entry + direction * takeProfitDollars, stop = entry - direction * stopLossDollars;
    const lastIndex = Math.min(inputCandles.length - 1, entryIndex + maxHoldBars - 1);
    let exitIndex = lastIndex, rawExit = inputCandles[lastIndex].close, exitReason = "time_exit";

    for (let j = entryIndex; j <= lastIndex; j++) {
      const candle = inputCandles[j];
      const stopHit = direction === 1 ? candle.low <= stop : candle.high >= stop;
      const targetHit = direction === 1 ? candle.high >= target : candle.low <= target;
      if (stopHit) {
        const gap = direction === 1 ? candle.open < stop : candle.open > stop;
        rawExit = gap ? candle.open : stop; exitIndex = j;
        exitReason = targetHit ? "stop_and_target_same_bar" : "stop_loss"; break;
      }
      if (targetHit) {
        const gap = direction === 1 ? candle.open > target : candle.open < target;
        rawExit = gap ? candle.open : target; exitIndex = j; exitReason = "take_profit"; break;
      }
    }
    const exit = rawExit - direction * (spreadDollars / 2 + slippageDollars);
    const grossPnlPerOunce = (exit - entry) * direction;
    const netPnlPerOunce = grossPnlPerOunce - commissionPerUnit;
    trades.push({ signalIndex: i, entryIndex, exitIndex, direction: direction === 1 ? "BUY" : "SELL", impulseMove: Number(move.toFixed(2)), entry: Number(entry.toFixed(3)), exit: Number(exit.toFixed(3)), exitReason, grossPnlPerOunce: Number(grossPnlPerOunce.toFixed(4)), costsPerOunce: Number(commissionPerUnit.toFixed(4)), netPnlPerOunce: Number(netPnlPerOunce.toFixed(4)), outcome: netPnlPerOunce > 0 ? "WIN" : "LOSS" });
    activeUntil = exitIndex;
  }
  const wins = trades.filter(t => t.netPnlPerOunce > 0), losses = trades.filter(t => t.netPnlPerOunce <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnlPerOunce, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnlPerOunce, 0));
  const totalNet = trades.reduce((s, t) => s + t.netPnlPerOunce, 0);
  return {
    strategy: "XAUUSD M15 single-candle impulse continuation", parameters: options, candles: inputCandles.length,
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? Number((wins.length / trades.length * 100).toFixed(2)) : 0,
    winRateWilson95: wilsonInterval(wins.length, trades.length),
    netExpectancyPerOunce: trades.length ? Number((totalNet / trades.length).toFixed(4)) : 0,
    netPnlPerOunce: Number(totalNet.toFixed(4)),
    profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(3)) : grossProfit ? null : 0,
    takeProfits: trades.filter(t => t.exitReason === "take_profit").length,
    stopLosses: trades.filter(t => t.exitReason === "stop_loss" || t.exitReason === "stop_and_target_same_bar").length,
    timeExits: trades.filter(t => t.exitReason === "time_exit").length, trades
  };
}

export function compareXauM15StopLosses(candles, overrides = {}) {
  return (overrides.stopLosses ?? [1, 2, 3, 4, 5]).map(stopLossDollars => runXauM15ImpulseBacktest(candles, { ...overrides, stopLossDollars })).sort((a, b) => b.netExpectancyPerOunce - a.netExpectancyPerOunce);
}

export function compareXauM15ImpulseThresholds(candles, overrides = {}) {
  return (overrides.impulseThresholds ?? [3, 4, 5, 6, 7]).map(impulseDollars => runXauM15ImpulseBacktest(candles, { ...overrides, impulseDollars })).sort((a, b) => b.netExpectancyPerOunce - a.netExpectancyPerOunce);
}
