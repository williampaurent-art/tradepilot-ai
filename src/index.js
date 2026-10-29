
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const TIMEFRAMES = {
  M1: "1m",
  M5: "5m",
  M15: "15m",
  M30: "30m",
  H1: "1h",
  H4: "4h",
  D1: "1d",
  W1: "1w",
};
const DATA_SOURCE = "biquote";
const INSTRUMENT = "GOLD / XAUUSD";
const DEFAULT_TARGET = 2;
const DEFAULT_STOP = 7;
const DEFAULT_RISK_PERCENT = 1;
const DEFAULT_CAPITAL = 1000;
function respond(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
function numberParam(params, name, fallback) {
  const value = params.get(name);
  if (value === null || value.trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Paramètre numérique invalide : ${name}`);
  }
  return number;
}
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const ranges = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}
function normalizeBars(bars) {
  if (!Array.isArray(bars)) return [];
  return bars
    .filter(b => b && !b.isOpen)
    .map(b => ({
      time: b.openTime ?? b.time ?? null,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    }))
    .filter(b =>
      [b.open, b.high, b.low, b.close].every(Number.isFinite) &&
      b.low > 0 &&
      b.high >= Math.max(b.open, b.close) &&
      b.low <= Math.min(b.open, b.close)
    )
    .sort((a, b) => {
      const ta = typeof a.time === "number" ? a.time : Date.parse(b.time);
      const tb = typeof b.time === "number" ? b.time : Date.parse(b.time);
      if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
      return ta - tb;
    });
}
async function fetchGoldCandles(timeframe = "M1", limit = 100) {
  const interval = TIMEFRAMES[timeframe];
  if (!interval) {
    throw new Error(`Unité de temps non prise en charge : ${timeframe}`);
  }
  const safeLimit = Math.max(30, Math.min(500, Number(limit) || 100));
  const response = await fetch(
    `https://biquote.io/api/XAUUSD/ohlc?interval=${encodeURIComponent(interval)}&limit=${safeLimit}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!response.ok) {
    throw new Error(`BiQuote a répondu avec le statut ${response.status}.`);
  }
  const data = await response.json();
  if (!Array.isArray(data.bars)) {
    throw new Error("Format des données historiques inattendu.");
  }
  const candles = normalizeBars(data.bars);
  if (candles.length < 30) {
    throw new Error(`Pas assez de bougies clôturées en ${timeframe}.`);
  }
  return candles;
}
// ------------------------------------------------------
// ANALYSE TECHNIQUE
// ------------------------------------------------------
function analyze(bars, timeframe = "M15") {
  const candles = normalizeBars(bars);
  if (candles.length < 30) {
    return {
      ok: false,
      error: "Pas assez de bougies clôturées.",
      received: candles.length,
      required: 30,
    };
  }
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const fast = sma(closes, 10);
  const slow = sma(closes, 20);
  const previousFast = sma(closes.slice(0, -1), 10);
  const previousSlow = sma(closes.slice(0, -1), 20);
  const momentum = rsi(closes);
  const volatility = atr(candles);
  let signal = "ATTENDRE";
  let reason = "Aucun signal confirmé.";
  if (
    previousFast <= previousSlow &&
    fast > slow &&
    momentum >= 50 &&
    momentum < 70
  ) {
    signal = "ACHAT";
    reason = "Croisement haussier SMA 10/20 avec RSI favorable.";
  } else if (
    previousFast >= previousSlow &&
    fast < slow &&
    momentum <= 50 &&
    momentum > 30
  ) {
    signal = "VENTE";
    reason = "Croisement baissier SMA 10/20 avec RSI favorable.";
  }
  return {
    ok: true,
    instrument: INSTRUMENT,
    timeframe,
    source: DATA_SOURCE,
    updatedAt: new Date().toISOString(),
    lastClosedCandle: last.time,
    price: last.close,
    indicators: {
      SMA10: Number(fast.toFixed(4)),
      SMA20: Number(slow.toFixed(4)),
      RSI14: Number(momentum.toFixed(2)),
      ATR14: volatility === null ? null : Number(volatility.toFixed(4)),
    },
    signal,
    reason,
    warning: "Signal indicatif uniquement. Aucun ordre réel n'est exécuté.",
  };
}
// ------------------------------------------------------
// MOTEUR DE SCALPING
// Objectif par défaut : 2 $
// Stop par défaut : 7 $
// ------------------------------------------------------
function detectScalpSignal(m1, m5, options = {}) {
  const targetMove = Number(options.targetMove ?? DEFAULT_TARGET);
  const stopDistance = Number(options.stopDistance ?? DEFAULT_STOP);
  const riskPercent = Number(options.riskPercent ?? DEFAULT_RISK_PERCENT);
  const capital = Number(options.capital ?? DEFAULT_CAPITAL);
  if (
    !Number.isFinite(targetMove) || targetMove <= 0 ||
    !Number.isFinite(stopDistance) || stopDistance <= 0 ||
    !Number.isFinite(riskPercent) || riskPercent <= 0 || riskPercent > 100 ||
    !Number.isFinite(capital) || capital <= 0
  ) {
    throw new Error("Paramètres de scalping invalides.");
  }
  if (m1.length < 30 || m5.length < 30) {
    throw new Error("Il faut au moins 30 bougies clôturées en M1 et M5.");
  }
  const last = m1[m1.length - 1];
  const previous = m1.slice(-6, -1);
  const closesM1 = m1.map(c => c.close);
  const closesM5 = m5.map(c => c.close);
  const trendFast = sma(closesM5, 10);
  const trendSlow = sma(closesM5, 20);
  const rsiM1 = rsi(closesM1);
  const volatility = atr(m1);
  const recentHigh = Math.max(...previous.map(c => c.high));
  const recentLow = Math.min(...previous.map(c => c.low));
  const bullishTrend = trendFast > trendSlow;
  const bearishTrend = trendFast < trendSlow;
  let signal = "ATTENDRE";
  let reason = "Aucune cassure confirmée par les filtres.";
  // Le RSI filtre les entrées trop étendues.
  if (
    last.close > recentHigh &&
    bullishTrend &&
    rsiM1 >= 50 &&
    rsiM1 < 75
  ) {
    signal = "ACHAT";
    reason = "Cassure M1 haussière, tendance M5 positive et RSI favorable.";
  } else if (
    last.close < recentLow &&
    bearishTrend &&
    rsiM1 <= 50 &&
    rsiM1 > 25
  ) {
    signal = "VENTE";
    reason = "Cassure M1 baissière, tendance M5 négative et RSI favorable.";
  }
  const entry = last.close;
  let stopLoss = null;
  let takeProfit = null;
  if (signal === "ACHAT") {
    stopLoss = entry - stopDistance;
    takeProfit = entry + targetMove;
  } else if (signal === "VENTE") {
    stopLoss = entry + stopDistance;
    takeProfit = entry - targetMove;
  }
  return {
    ok: true,
    instrument: "XAUUSD",
    strategy: "M1 breakout + M5 trend + RSI filter",
    source: DATA_SOURCE,
    updatedAt: new Date().toISOString(),
    lastClosedCandle: last.time,
    signal,
    reason,
    entry: Number(entry.toFixed(2)),
    stopLoss: stopLoss === null ? null : Number(stopLoss.toFixed(2)),
    takeProfit: takeProfit === null ? null : Number(takeProfit.toFixed(2)),
    configuration: {
      capital: Number(capital.toFixed(2)),
      riskPercent,
      estimatedRiskBudget: Number((capital * riskPercent / 100).toFixed(2)),
      targetMoveDollars: targetMove,
      stopDistanceDollars: stopDistance,
    },
    trendM5: bullishTrend ? "HAUSSIÈRE" : bearishTrend ? "BAISSIÈRE" : "NEUTRE",
    indicators: {
      SMA10_M5: Number(trendFast.toFixed(2)),
      SMA20_M5: Number(trendSlow.toFixed(2)),
      RSI14_M1: rsiM1 === null ? null : Number(rsiM1.toFixed(2)),
      ATR14_M1: volatility === null ? null : Number(volatility.toFixed(4)),
      previousHighM1: Number(recentHigh.toFixed(2)),
      previousLowM1: Number(recentLow.toFixed(2)),
    },
    status: "SIGNAL_ONLY_NO_LIVE_ORDERS",
    warning:
      "Prototype indicatif. Le budget de risque ne calcule pas la taille réelle de position. " +
      "Spread, slippage, frais et exécution du courtier ne sont pas simulés.",
  };
}
// ------------------------------------------------------
// BACKTEST
// ------------------------------------------------------
function fullSMA(values, period) {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    return values.slice(i + 1 - period, i + 1)
      .reduce((sum, value) => sum + value, 0) / period;
  });
}
function fullRSI(values, period = 14) {
  return values.map((_, i) => {
    if (i < period) return null;
    let gains = 0;
    let losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const change = values[j] - values[j - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    if (losses === 0) return gains === 0 ? 50 : 100;
    return 100 - 100 / (1 + gains / losses);
  });
}
function signalFor(candles, index, strategy, fast, slow, momentum) {
  const close = candles[index].close;
  if (strategy === "trend") {
    if (fast[index] > slow[index] && fast[index - 1] <= slow[index - 1]) return 1;
    if (fast[index] < slow[index] && fast[index - 1] >= slow[index - 1]) return -1;
  }
  if (strategy === "breakout") {
    const previous = candles.slice(index - 20, index);
    if (previous.length < 20) return 0;
    if (close > Math.max(...previous.map(c => c.high))) return 1;
    if (close < Math.min(...previous.map(c => c.low))) return -1;
  }
  if (strategy === "reversal") {
    if (momentum[index] !== null && momentum[index] < 30) return 1;
    if (momentum[index] !== null && momentum[index] > 70) return -1;
  }
  return 0;
}
function backtest(candles, strategy, options = {}) {
  if (candles.length < 50) {
    throw new Error("Le backtest exige au moins 50 bougies.");
  }
  const initialCapital = Number(options.capital ?? 10000);
  const riskPercent = Number(options.riskPercent ?? 1);
  const feePercent = Number(options.feePercent ?? 0.02);
  const stopDistancePercent = Number(options.stopDistancePercent ?? 0.5);
  const targetRiskReward = Number(options.targetRiskReward ?? 2);
  if (
    !Number.isFinite(initialCapital) || initialCapital <= 0 ||
    !Number.isFinite(riskPercent) || riskPercent <= 0 || riskPercent > 100 ||
    !Number.isFinite(feePercent) || feePercent < 0 || feePercent > 5 ||
    !Number.isFinite(stopDistancePercent) || stopDistancePercent <= 0 ||
    !Number.isFinite(targetRiskReward) || targetRiskReward <= 0
  ) {
    throw new Error("Paramètres de backtest invalides.");
  }
  const closes = candles.map(c => c.close);
  const fast = fullSMA(closes, 10);
  const slow = fullSMA(closes, 20);
  const momentum = fullRSI(closes);
  let capital = initialCapital;
  let position = null;
  let trades = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let peak = capital;
  let maxDrawdown = 0;
  function closePosition(price) {
    const gross = (price - position.entry) * position.direction * position.units;
    const fees = (position.entry + price) * position.units * feePercent / 100;
    const pnl = gross - fees;
    capital += pnl;
    trades++;
    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
    } else {
      grossLoss += Math.abs(pnl);
    }
    position = null;
  }
  for (let i = 21; i < candles.length; i++) {
    const candle = candles[i];
    if (position) {
      const stopHit = position.direction === 1
        ? candle.low <= position.stop
        : candle.high >= position.stop;
      const targetHit = position.direction === 1
        ? candle.high >= position.target
        : candle.low <= position.target;
      // Hypothèse prudente si stop et objectif sont atteints dans la même bougie.
      if (stopHit) closePosition(position.stop);
      else if (targetHit) closePosition(position.target);
    }
    if (!position) {
      const direction = signalFor(candles, i, strategy, fast, slow, momentum);
      if (direction !== 0) {
        const entry = candle.close;
        const stopDistance = entry * stopDistancePercent / 100;
        const riskMoney = capital * riskPercent / 100;
        const units = riskMoney / stopDistance;
        position = {
          entry,
          direction,
          units,
          stop: entry - direction * stopDistance,
          target: entry + direction * targetRiskReward * stopDistance,
        };
      }
    }
    peak = Math.max(peak, capital);
    maxDrawdown = Math.max(
      maxDrawdown,
      peak > 0 ? (peak - capital) / peak * 100 : 0
    );
  }
  if (position) closePosition(candles[candles.length - 1].close);
  return {
    strategy,
    startingCapital: Number(initialCapital.toFixed(2)),
    endingCapital: Number(capital.toFixed(2)),
    netProfit: Number((capital - initialCapital).toFixed(2)),
    returnPercent: Number(((capital / initialCapital - 1) * 100).toFixed(2)),
    trades,
    winRate: trades ? Number((wins / trades * 100).toFixed(2)) : 0,
    profitFactor: grossLoss > 0
      ? Number((grossProfit / grossLoss).toFixed(2))
      : grossProfit > 0 ? null : 0,
    maxDrawdownPercent: Number(maxDrawdown.toFixed(2)),
    configuration: { riskPercent, feePercent, stopDistancePercent, targetRiskReward },
    note:
      "Simulation indicative. Le spread, le slippage, les gaps et les règles du courtier ne sont pas entièrement modélisés.",
  };
}
function compareStrategies(candles, options = {}) {
  return ["trend", "breakout", "reversal"]
    .map(strategy => backtest(candles, strategy, options))
    .sort((a, b) => b.returnPercent - a.returnPercent);
}
function validCandles(candles) {
  return Array.isArray(candles) && candles.every(c =>
    c &&
    [c.open, c.high, c.low, c.close].every(
      n => typeof n === "number" && Number.isFinite(n)
    ) &&
    c.low > 0 &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close)
  );
}
// ------------------------------------------------------
// ROUTES API
// ------------------------------------------------------
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    const timeframe = (url.searchParams.get("timeframe") || "M15").toUpperCase();
    if (url.pathname === "/" || url.pathname === "/health") {
      return respond({
        ok: true,
        service: "TradePilot AI",
        status: "online",
        instrument: INSTRUMENT,
        source: DATA_SOURCE,
        liveTrading: false,
        automaticPushNotifications: false,
        endpoints: [
          "/health",
          "/gold?timeframe=M15",
          "/analyze?timeframe=M15",
          "/scalp?target=2&stopDistance=7&riskPercent=1&capital=1000",
          "/backtest",
        ],
        defaultScalpConfiguration: {
          targetMoveDollars: DEFAULT_TARGET,
          stopDistanceDollars: DEFAULT_STOP,
          riskPercent: DEFAULT_RISK_PERCENT,
          capital: DEFAULT_CAPITAL,
        },
        timeframes: Object.keys(TIMEFRAMES),
      });
    }
    if (url.pathname === "/gold" || url.pathname === "/analyze") {
      if (!TIMEFRAMES[timeframe]) {
        return respond({
          ok: false,
          error: "Unité de temps non prise en charge.",
          available: Object.keys(TIMEFRAMES),
        }, 400);
      }
      try {
        const candles = await fetchGoldCandles(timeframe, 100);
        return respond(analyze(candles, timeframe));
      } catch (error) {
        return respond({
          ok: false,
          error: "Impossible de récupérer les données GOLD.",
          details: String(error),
        }, 502);
      }
    }
    if (url.pathname === "/scalp") {
      if (request.method !== "GET") {
        return respond({
          ok: false,
          error: "Utilise GET pour obtenir un signal de scalping.",
        }, 405);
      }
      try {
        const targetMove = numberParam(url.searchParams, "target", DEFAULT_TARGET);
        const stopDistance = numberParam(url.searchParams, "stopDistance", DEFAULT_STOP);
        const riskPercent = numberParam(url.searchParams, "riskPercent", DEFAULT_RISK_PERCENT);
        const capital = numberParam(url.searchParams, "capital", DEFAULT_CAPITAL);
        const [m1, m5] = await Promise.all([
          fetchGoldCandles("M1", 100),
          fetchGoldCandles("M5", 100),
        ]);
        const result = detectScalpSignal(m1, m5, {
          targetMove,
          stopDistance,
          riskPercent,
          capital,
        });
        return respond({
          ...result,
          candlesM1: m1.length,
          candlesM5: m5.length,
        });
      } catch (error) {
        return respond({
          ok: false,
          error: "Impossible de calculer le signal de scalping.",
          details: String(error),
        }, 502);
      }
    }
    if (url.pathname === "/backtest") {
      if (request.method !== "POST") {
        return respond({
          ok: false,
          error: "Utilise POST avec un tableau de bougies historiques.",
          format: {
            candles: [{
              open: 4000,
              high: 4010,
              low: 3990,
              close: 4005,
            }],
            capital: 10000,
            riskPercent: 1,
            feePercent: 0.02,
            stopDistancePercent: 0.5,
            targetRiskReward: 2,
          },
        }, 405);
      }
      try {
        const body = await request.json();
        if (
          !validCandles(body.candles) ||
          body.candles.length < 50 ||
          body.candles.length > 10000
        ) {
          return respond({
            ok: false,
            error: "Fournis entre 50 et 10000 bougies OHLC numériques valides.",
          }, 400);
        }
        const results = compareStrategies(body.candles, {
          capital: body.capital,
          riskPercent: body.riskPercent,
          feePercent: body.feePercent,
          stopDistancePercent: body.stopDistancePercent,
          targetRiskReward: body.targetRiskReward,
        });
        return respond({
          ok: true,
          instrument: INSTRUMENT,
          timeframe: body.timeframe || "M15",
          candlesUsed: body.candles.length,
          results,
          warning:
            "Simulation historique uniquement. Les performances passées ne garantissent pas les résultats futurs.",
        });
      } catch (error) {
        return respond({
          ok: false,
          error: "Impossible d'exécuter le backtest.",
          details: String(error),
        }, 400);
      }
    }
    return respond({
      ok: false,
      error: "Route introuvable.",
      available: ["/health", "/gold", "/analyze", "/scalp", "/backtest"],
    }, 404);
  },
  // Le déclencheur Cron doit être configuré dans les paramètres Cloudflare.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};
async function runScheduledCheck(env) {
  const target = Number(env.TP_TARGET ?? DEFAULT_TARGET);
  const stop = Number(env.TP_STOP ?? DEFAULT_STOP);
  const riskPercent = Number(env.TP_RISK_PERCENT ?? DEFAULT_RISK_PERCENT);
  const capital = Number(env.TP_CAPITAL ?? DEFAULT_CAPITAL);
  const [m1, m5] = await Promise.all([
    fetchGoldCandles("M1", 100),
    fetchGoldCandles("M5", 100),
  ]);
  const result = detectScalpSignal(m1, m5, {
    targetMove: target,
    stopDistance: stop,
    riskPercent,
    capital,
  });
  const currentCandle = result.lastClosedCandle;
  if (result.signal === "ATTENDRE") return;
  // Enregistrement durable de la dernière bougie traitée pour éviter les doublons.
  // Ajouter un binding KV nommé TP_STATE avant d'activer cette fonctionnalité.
  if (!env.TP_STATE) {
    console.log("Signal détecté, mais TP_STATE n'est pas configuré.", result);
    return;
  }
  const key = `last-signal:${currentCandle}`;
  const existing = await env.TP_STATE.get(key);
  if (existing) return;
  await env.TP_STATE.put(key, JSON.stringify(result), {
    expirationTtl: 60 * 60 * 24 * 7,
  });
  console.log("Nouveau signal TradePilot AI :", JSON.stringify(result));
  // La notification push doit être raccordée ici à un fournisseur push
  // ou à un endpoint sécurisé. Aucun message push n'est envoyé par ce code.
}
