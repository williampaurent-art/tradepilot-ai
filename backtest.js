const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"];

function sma(values, period) {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    const slice = values.slice(i + 1 - period, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function rsi(values, period = 14) {
  const result = Array(values.length).fill(null);
  if (!Array.isArray(values) || values.length < period + 1) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  const value = () => avgLoss === 0
    ? (avgGain === 0 ? 50 : 100)
    : 100 - 100 / (1 + avgGain / avgLoss);
  result[period] = value();

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = ((avgGain * (period - 1)) + Math.max(change, 0)) / period;
    avgLoss = ((avgLoss * (period - 1)) + Math.max(-change, 0)) / period;
    result[i] = value();
  }
  return result;
}

function getSignal(index, candles, fast, slow, momentum, strategy) {
  const candle = candles[index];
  if (strategy === "trend") {
    if (fast[index] > slow[index] && fast[index - 1] <= slow[index - 1]) return 1;
    if (fast[index] < slow[index] && fast[index - 1] >= slow[index - 1]) return -1;
  } else if (strategy === "breakout") {
    const previous = candles.slice(index - 20, index);
    const high = Math.max(...previous.map(item => item.high));
    const low = Math.min(...previous.map(item => item.low));
    if (candle.close > high) return 1;
    if (candle.close < low) return -1;
  } else if (strategy === "reversal") {
    if (momentum[index] !== null && momentum[index] < 30) return 1;
    if (momentum[index] !== null && momentum[index] > 70) return -1;
  }
  return 0;
}

function trueRange(candle, previous) {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previous.close),
    Math.abs(candle.low - previous.close)
  );
}

function classifyRegime(candles, index, options = {}) {
  const trendLookback = Number(options.regimeTrendLookback ?? 5);
  const volatilityLookback = Number(options.regimeVolatilityLookback ?? 50);
  const slopeThreshold = Number(options.regimeSlopeThreshold ?? 0.5);
  const highVolatilityMultiplier = Number(options.highVolatilityMultiplier ?? 1.5);

  if (index < Math.max(21, volatilityLookback + 15)) return "insufficient_history";

  const closes = candles.slice(0, index + 1).map(item => item.close);
  const ranges = [];
  for (let i = 1; i <= index; i++) {
    ranges.push(trueRange(candles[i], candles[i - 1]));
  }

  // ATR courant calculé uniquement avec les chandeliers clôturés jusqu'à index.
  const recentRanges = ranges.slice(-14);
  const atr = recentRanges.reduce((sum, value) => sum + value, 0) / recentRanges.length;

  // Référence de volatilité constituée uniquement des ATR antérieurs.
  const historicalAtr = [];
  const first = Math.max(14, index - volatilityLookback);
  for (let end = first; end < index; end++) {
    const sample = ranges.slice(Math.max(0, end - 13), end + 1);
    if (sample.length === 14) {
      historicalAtr.push(sample.reduce((sum, value) => sum + value, 0) / 14);
    }
  }
  const sortedAtr = historicalAtr.slice().sort((a, b) => a - b);
  const medianAtr = sortedAtr.length
    ? sortedAtr[Math.floor(sortedAtr.length / 2)]
    : atr;

  const currentClose = closes[index];
  const priorClose = closes[index - trendLookback];
  const normalizedSlope = atr > 0
    ? (currentClose - priorClose) / atr
    : 0;

  const volatility = medianAtr > 0 && atr >= medianAtr * highVolatilityMultiplier
    ? "high_volatility"
    : "normal_volatility";

  let direction = "range";
  if (normalizedSlope >= slopeThreshold) direction = "uptrend";
  else if (normalizedSlope <= -slopeThreshold) direction = "downtrend";

  return direction === "range"
    ? volatility === "high_volatility" ? "volatile_range" : "range"
    : volatility === "high_volatility" ? direction + "_high_volatility" : direction;
}

function backtest(candles, strategy, options = {}) {
  const startingCapital = Number(options.capital ?? 10000);
  const riskPercent = Number(options.riskPercent ?? 1);
  const stopDistance = Number(options.stopDistance ?? options.stopLossDistance ?? 7);
  const targetDistance = Number(options.targetDistance ?? options.takeProfitDistance ?? 2);
  const spread = Number(options.spread ?? 0);
  const slippage = Number(options.slippage ?? 0);
  const feePercent = Number(options.feePercent ?? 0.02);

  if (!Array.isArray(candles) || candles.length < 50) {
    throw new Error("Il faut au moins 50 bougies historiques.");
  }
  if (!["trend", "breakout", "reversal"].includes(strategy)) {
    throw new Error("Stratégie non prise en charge.");
  }
  const startIndex = Math.max(21, Math.floor(Number(options.startIndex ?? 21)));
  const endIndex = Math.min(candles.length, Math.floor(Number(options.endIndex ?? candles.length)));
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex) ||
      startIndex < 21 || endIndex <= startIndex || endIndex > candles.length) {
    throw new Error("Fenêtre de backtest invalide.");
  }
  if (!(startingCapital > 0) || !(riskPercent > 0 && riskPercent <= 2)) {
    throw new Error("Capital invalide ou risque supérieur à 2 %.");
  }
  if (!(stopDistance > 0) || !(targetDistance > 0) ||
      spread < 0 || slippage < 0 || feePercent < 0) {
    throw new Error("Paramètres de risque ou de coûts invalides.");
  }

  for (const candle of candles) {
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) ||
        candle.high < candle.low || candle.high < candle.open ||
        candle.high < candle.close || candle.low > candle.open ||
        candle.low > candle.close) {
      throw new Error("Format OHLC invalide.");
    }
  }

  const timeKey = ["timestamp", "time", "datetime", "date"]
    .find(key => candles.every(candle => candle[key] !== undefined && candle[key] !== null));
  if (timeKey) {
    const times = candles.map(candle => {
      const raw = candle[timeKey];
      const parsed = typeof raw === "number" ? raw : Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : null;
    });
    if (times.some(value => value === null)) {
      throw new Error("Horodatage historique illisible.");
    }
    for (let i = 1; i < times.length; i++) {
      if (times[i] <= times[i - 1]) {
        throw new Error("Les bougies doivent être strictement triées par ordre chronologique, sans doublons.");
      }
    }
  }

  const closes = candles.map(candle => candle.close);
  const fast = sma(closes, 10);
  const slow = sma(closes, 20);
  const momentum = rsi(closes, 14);

  let capital = startingCapital;
  let equityPeak = startingCapital;
  let maxDrawdown = 0;
  let position = null;
  const history = [];

  function updateDrawdown(markPrice, candle) {
    if (!position) {
      equityPeak = Math.max(equityPeak, capital);
      maxDrawdown = Math.max(maxDrawdown, (equityPeak - capital) / equityPeak * 100);
      return;
    }
    const adversePrice = position.direction === 1 ? candle.low : candle.high;
    const unrealized = (adversePrice - position.entry) *
      position.direction * position.units;
    const markedEquity = capital + unrealized;
    equityPeak = Math.max(equityPeak, capital);
    maxDrawdown = Math.max(maxDrawdown, (equityPeak - markedEquity) / equityPeak * 100);
  }

  function openPosition(direction, rawOpen, index) {
    const entry = rawOpen + direction * (spread / 2 + slippage);
    const riskMoney = capital * riskPercent / 100;
    const units = riskMoney / stopDistance;
    position = {
      direction, entry, units,
      stop: entry - direction * stopDistance,
      target: entry + direction * targetDistance,
      entryIndex: index,
      regime: classifyRegime(candles, index - 1, options)
    };
  }

  function closePosition(rawExit, index, reason) {
    const exit = rawExit - position.direction * (spread / 2 + slippage);
    const gross = (exit - position.entry) * position.direction * position.units;
    const fees = (Math.abs(position.entry) + Math.abs(exit)) *
      position.units * feePercent / 100;
    const pnl = gross - fees;
    capital += pnl;
    history.push({
      direction: position.direction === 1 ? "BUY" : "SELL",
      entryIndex: position.entryIndex,
      exitIndex: index,
      regime: position.regime,
      entry: Number(position.entry.toFixed(5)),
      exit: Number(exit.toFixed(5)),
      units: Number(position.units.toFixed(5)),
      pnl: Number(pnl.toFixed(2)),
      result: pnl > 0 ? "WIN" : "LOSS",
      exitReason: reason
    });
    position = null;
  }

  for (let i = startIndex; i < endIndex; i++) {
    const candle = candles[i];
    const priorSignal = getSignal(i - 1, candles, fast, slow, momentum, strategy);

    // Signal connu à la clôture précédente : exécution au prochain open.
    if (position && priorSignal === -position.direction) {
      closePosition(candle.open, i, "opposite_signal");
    }
    if (!position && priorSignal !== 0) {
      openPosition(priorSignal, candle.open, i);
    }

    if (position) {
      const stopTouched = position.direction === 1
        ? candle.low <= position.stop
        : candle.high >= position.stop;
      const targetTouched = position.direction === 1
        ? candle.high >= position.target
        : candle.low <= position.target;

      // Si SL et TP sont touchés dans la même bougie, retenir le SL :
      // hypothèse conservatrice, car l'ordre intrabougie est inconnu en OHLC.
      if (stopTouched) {
        const gapThroughStop = position.direction === 1
          ? candle.open < position.stop
          : candle.open > position.stop;
        const stopFill = gapThroughStop ? candle.open : position.stop;
        closePosition(stopFill, i, targetTouched ? "stop_and_target_same_bar" : "stop_loss");
      } else if (targetTouched) {
        const favorableGap = position.direction === 1
          ? candle.open > position.target
          : candle.open < position.target;
        const targetFill = favorableGap ? candle.open : position.target;
        closePosition(targetFill, i, "take_profit");
      }
    }

    updateDrawdown(candle.close, candle);
  }

  if (position) {
    closePosition(candles[endIndex - 1].close, endIndex - 1, "end_of_data");
  }

  const trades = history.length;
  const wins = history.filter(trade => trade.pnl > 0);
  const losses = history.filter(trade => trade.pnl <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const regimeStats = {};

  for (const trade of history) {
    const regime = trade.regime || "unknown";
    if (!regimeStats[regime]) regimeStats[regime] = { trades: 0, wins: 0, losses: 0, netProfit: 0 };
    const bucket = regimeStats[regime];
    bucket.trades++;
    bucket.netProfit += trade.pnl;
    if (trade.pnl > 0) bucket.wins++;
    else bucket.losses++;
  }

  for (const bucket of Object.values(regimeStats)) {
    bucket.netProfit = Number(bucket.netProfit.toFixed(2));
    bucket.winRate = bucket.trades
      ? Number((bucket.wins / bucket.trades * 100).toFixed(2))
      : 0;
  }

  return {
    strategy,
    startingCapital,
    endingCapital: Number(capital.toFixed(2)),
    netProfit: Number((capital - startingCapital).toFixed(2)),
    returnPercent: Number(((capital / startingCapital - 1) * 100).toFixed(2)),
    trades,
    wins: wins.length,
    losses: losses.length,
    winRate: trades ? Number((wins.length / trades * 100).toFixed(2)) : 0,
    profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(3)) : (grossProfit ? null : 0),
    averageWin: wins.length ? Number((grossProfit / wins.length).toFixed(2)) : 0,
    averageLoss: losses.length ? Number((-grossLoss / losses.length).toFixed(2)) : 0,
    maxDrawdownPercent: Number(Math.max(0, maxDrawdown).toFixed(2)),
    regimeStats,
    assumptions: {
      regimeClassification: "Pente du prix normalisée par ATR, volatilité comparée à la médiane historique passée; aucun chandelier futur utilisé.",
      regimeTrendLookback: Number(options.regimeTrendLookback ?? 5),
      regimeVolatilityLookback: Number(options.regimeVolatilityLookback ?? 50),
      regimeSlopeThreshold: Number(options.regimeSlopeThreshold ?? 0.5),
      highVolatilityMultiplier: Number(options.highVolatilityMultiplier ?? 1.5),
      entry: "Signal calculé à la clôture, entrée à l'ouverture de la bougie suivante",
      stopDistance,
      targetDistance,
      spread,
      slippage,
      feePercent,
      sameBarStopAndTarget: "Stop prioritaire (hypothèse conservatrice)"
    },
    history,
    note: "Simulation OHLC indicative : spread, slippage et commission sont paramétrables; le chemin intrabougie exact et les conditions du courtier ne sont pas connus."
  };
}

function compareStrategies(candles, options = {}) {
  return ["trend", "breakout", "reversal"]
    .map(strategy => backtest(candles, strategy, options))
    .sort((a, b) => b.returnPercent - a.returnPercent);
}

function walkForwardCompare(candles, options = {}) {
  const warmupBars = Math.floor(Number(options.warmupBars ?? 500));
  const testBars = Math.floor(Number(options.testBars ?? 200));
  const stepBars = Math.floor(Number(options.stepBars ?? testBars));
  const capital = Number(options.capital ?? 10000);

  if (!Array.isArray(candles) || warmupBars < 50 || testBars < 20 ||
      stepBars < testBars || !Number.isFinite(warmupBars) ||
      !Number.isFinite(testBars) || !Number.isFinite(stepBars)) {
    throw new Error("Paramètres walk-forward invalides.");
  }
  if (candles.length < warmupBars + testBars) {
    throw new Error("Historique insuffisant pour une première fenêtre hors échantillon.");
  }

  const strategies = ["trend", "breakout", "reversal"];
  const folds = [];
  for (let testStart = warmupBars; testStart + testBars <= candles.length; testStart += stepBars) {
    const testEnd = testStart + testBars;
    const results = strategies.map(strategy => {
      const result = backtest(candles, strategy, {
        ...options,
        capital,
        startIndex: testStart,
        endIndex: testEnd
      });
      return {
        strategy,
        trades: result.trades,
        wins: result.wins,
        losses: result.losses,
        winRate: result.winRate,
        netProfit: result.netProfit,
        returnPercent: result.returnPercent,
        profitFactor: result.profitFactor,
        maxDrawdownPercent: result.maxDrawdownPercent,
        grossProfit: result.history.filter(trade => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0),
        grossLoss: Math.abs(result.history.filter(trade => trade.pnl <= 0).reduce((sum, trade) => sum + trade.pnl, 0)),
        regimeStats: result.regimeStats
      };
    });
    folds.push({
      warmupStartIndex: Math.max(0, testStart - warmupBars),
      warmupEndIndex: testStart - 1,
      testStartIndex: testStart,
      testEndIndex: testEnd - 1,
      results
    });
  }

  const summary = strategies.map(strategy => {
    const results = folds.flatMap(fold => fold.results.filter(item => item.strategy === strategy));
    const trades = results.reduce((sum, item) => sum + item.trades, 0);
    const wins = results.reduce((sum, item) => sum + item.wins, 0);
    const netProfit = results.reduce((sum, item) => sum + item.netProfit, 0);
    const grossProfit = results.reduce((sum, item) => sum + item.grossProfit, 0);
    const grossLoss = results.reduce((sum, item) => sum + item.grossLoss, 0);
    const totalCapital = capital * results.length;
    const profitableFolds = results.filter(item => item.netProfit > 0).length;
    const activeFolds = results.filter(item => item.trades > 0).length;
    return {
      strategy,
      folds: results.length,
      activeFolds,
      profitableFolds,
      foldProfitabilityPercent: results.length
        ? Number((profitableFolds / results.length * 100).toFixed(2))
        : 0,
      trades,
      wins,
      losses: trades - wins,
      winRate: trades ? Number((wins / trades * 100).toFixed(2)) : 0,
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : (grossProfit > 0 ? null : 0),
      netProfit: Number(netProfit.toFixed(2)),
      averageFoldReturnPercent: results.length
        ? Number((results.reduce((sum, item) => sum + item.returnPercent, 0) / results.length).toFixed(2))
        : 0,
      normalizedReturnPercent: totalCapital
        ? Number((netProfit / totalCapital * 100).toFixed(2))
        : 0,
      worstFoldDrawdownPercent: results.length
        ? Number(Math.max(...results.map(item => item.maxDrawdownPercent)).toFixed(2))
        : 0
    };
  }).sort((a, b) => b.normalizedReturnPercent - a.normalizedReturnPercent);

  return {
    method: "Rolling chronological out-of-sample evaluation with indicator warm-up",
    warmupBars,
    testBars,
    stepBars,
    folds: folds.length,
    summary,
    foldResults: folds,
    warning: "La période warm-up sert uniquement à initialiser les indicateurs; aucune optimisation ni aucun apprentissage de modèle n'est effectué. Les fenêtres de test ne se chevauchent pas. Les performances passées ne garantissent pas les résultats futurs. Chaque fenêtre repart du capital initial."
  };
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
  classifyRegime,
  backtest,
  compareStrategies,
  walkForwardCompare,
  validateTimeframe
};
