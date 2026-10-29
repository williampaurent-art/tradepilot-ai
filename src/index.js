
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

// Normalisation et tri chronologique des bougies.
function normalizeBars(bars) {
  if (!Array.isArray(bars)) return [];

  return bars
    .filter(b => b && b.isOpen !== true)
    .map(b => ({
      time: b.openTime ?? b.time ?? null,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    }))
    .filter(b =>
      b.time !== null &&
      Number.isFinite(Date.parse(b.time)) &&
      [b.open, b.high, b.low, b.close].every(Number.isFinite) &&
      b.low > 0 &&
      b.high >= Math.max(b.open, b.close) &&
      b.low <= Math.min(b.open, b.close)
    )
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

// Contrôle de l'ancienneté de la dernière bougie clôturée.
function checkCandleFreshness(candles, timeframe) {
  const limits = {
    M1: 3 * 60 * 1000,
    M5: 15 * 60 * 1000,
    M15: 40 * 60 * 1000,
    M30: 75 * 60 * 1000,
    H1: 150 * 60 * 1000,
    H4: 10 * 60 * 60 * 1000,
    D1: 36 * 60 * 60 * 1000,
    W1: 10 * 24 * 60 * 60 * 1000,
  };

  if (!candles.length) {
    return {
      ok: false,
      error: "Aucune bougie clôturée disponible.",
    };
  }

  const last = candles[candles.length - 1];
  const candleTime = Date.parse(last.time);
  const ageMs = Date.now() - candleTime;
  const maxAgeMs = limits[timeframe];

  if (!Number.isFinite(candleTime) || ageMs < 0 || !maxAgeMs) {
    return {
      ok: false,
      error: "Horodatage invalide ou futur.",
    };
  }

  return {
    ok: ageMs <= maxAgeMs,
    lastClosedCandle: last.time,
    ageSeconds: Math.floor(ageMs / 1000),
    maxAgeSeconds: Math.floor(maxAgeMs / 1000),
    error: ageMs > maxAgeMs
      ? `Données trop anciennes pour ${timeframe}.`
      : null,
  };
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

  const freshness = checkCandleFreshness(candles, timeframe);

  if (!freshness.ok) {
    return {
      ok: false,
      instrument: INSTRUMENT,
      timeframe,
      source: DATA_SOURCE,
      signal: "ATTENDRE",
      reason: "Analyse bloquée : données trop anciennes ou invalides.",
      freshness,
      status: "STALE_DATA_BLOCKED",
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
    freshness,
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
    trendM5: bullishTrend
      ? "HAUSSIÈRE"
      : bearishTrend
        ? "BAISSIÈRE"
        : "NEUTRE",
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
