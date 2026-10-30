


/**
 * TradePilot AI — XAUUSD
 * Cloudflare Worker
 *
 * Signaux selectifs avec confirmation de pullback M1.
 * Aucun ordre reel n'est execute.
 *
 * Capital de reference : 1000 USD
 * Taille indicative : 0.5 lot / 1000 USD
 * Levier indicatif : x500
 * Objectif : 2 USD de mouvement XAUUSD
 * Stop : 7 USD de mouvement XAUUSD
 *
 * Variables Cloudflare optionnelles :
 * ALERT_WEBHOOK : URL HTTPS du webhook d'alerte
 * TP_STATE       : binding KV pour memoriser les signaux
 */

const CONFIG = {
  SERVICE: "TradePilot AI",
  INSTRUMENT: "GOLD / XAUUSD",

  DEFAULT_CAPITAL: 1000,
  LOTS_PER_1000: 0.5,
  LEVERAGE: 500,

  TARGET_MOVE: 2,
  STOP_MOVE: 7,

  MIN_SCORE: 75,
  MAX_CANDLES: 250,
  COOLDOWN_MS: 5 * 60 * 1000,

  FRESHNESS_INTERVALS: 2,
  FRESHNESS_GRACE_MS: 60 * 1000,

  QUALITY_LOOKBACK_MS: 2 * 60 * 60 * 1000,
  GAP_TOLERANCE_MS: 30 * 1000,

  // Parametres du pullback M1
  PULLBACK_LOOKBACK: 5,
  PULLBACK_ATR_TOLERANCE: 0.30,

  SOURCE_URL: "https://biquote.io/api/XAUUSD/ohlc"
};

const TIMEFRAMES = {
  M1:  { interval: "1m",  ms: 60_000 },
  M5:  { interval: "5m",  ms: 300_000 },
  M15: { interval: "15m", ms: 900_000 },
  M30: { interval: "30m", ms: 1_800_000 },
  H1:  { interval: "1h",  ms: 3_600_000 },
  H4:  { interval: "4h",  ms: 14_400_000 },
  D1:  { interval: "1d",  ms: 86_400_000 }
};

// --------------------------------------------------
// REPONSES HTTP
// --------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

function numberParam(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);

  if (raw === null || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

// --------------------------------------------------
// PARAMETRES ET CALCUL DES LOTS
// --------------------------------------------------

function getSettings(url) {
  const capital = numberParam(
    url, "capital", CONFIG.DEFAULT_CAPITAL, 1, 100_000_000
  );

  const target = numberParam(
    url, "target", CONFIG.TARGET_MOVE, 0.01, 1000
  );

  const stopDistance = numberParam(
    url, "stopDistance", CONFIG.STOP_MOVE, 0.01, 1000
  );

  const minScore = numberParam(
    url, "minScore", CONFIG.MIN_SCORE, 50, 100
  );

  // 0.5 lot pour chaque tranche de 1000 USD.
  const lots = (capital / 1000) * CONFIG.LOTS_PER_1000;

  return {
    capital,
    target,
    stopDistance,
    minScore,
    leverage: CONFIG.LEVERAGE,
    lots: Number(lots.toFixed(4))
  };
}

// --------------------------------------------------
// NORMALISATION DES TIMESTAMPS ET BOUGIES
// --------------------------------------------------

function toTimestamp(value) {
  if (value === null || value === undefined) {
    return NaN;
  }

  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const numeric = Number(trimmed);

    if (trimmed !== "" && Number.isFinite(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  return NaN;
}

function extractRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const possibleKeys = [
    "bars",
    "candles",
    "data",
    "results",
    "ohlc"
  ];

  for (const key of possibleKeys) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }

  for (const key of possibleKeys) {
    const nested = payload[key];

    if (nested && typeof nested === "object") {
      for (const nestedKey of possibleKeys) {
        if (Array.isArray(nested[nestedKey])) {
          return nested[nestedKey];
        }
      }
    }
  }

  return null;
}

function normalizeBars(payload) {
  const rows = extractRows(payload);

  if (!rows) {
    throw new Error(
      "Format OHLC non reconnu. Verifier la reponse de BiQuote."
    );
  }

  const bars = rows.map((row) => {
    if (Array.isArray(row)) {
      return {
        time: toTimestamp(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        isOpen: false
      };
    }

    return {
      time: toTimestamp(
        row.openTime ??
        row.open_time ??
        row.time ??
        row.timestamp ??
        row.t ??
        row.datetime ??
        row.date
      ),

      open: Number(row.open ?? row.o),
      high: Number(row.high ?? row.h),
      low: Number(row.low ?? row.l),
      close: Number(row.close ?? row.c),

      isOpen:
        row.isOpen === true ||
        row.is_open === true
    };
  }).filter((bar) =>
    Number.isFinite(bar.time) &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    bar.high >= bar.low &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close)
  );

  bars.sort((a, b) => a.time - b.time);

  const unique = [];

  for (const bar of bars) {
    const previous = unique[unique.length - 1];

    if (previous && previous.time === bar.time) {
      unique[unique.length - 1] = bar;
    } else {
      unique.push(bar);
    }
  }

  return unique;
}

// --------------------------------------------------
// FRAICHEUR DES DONNEES
// --------------------------------------------------

function validateFreshness(bars, timeframe = "M1") {
  const tf = TIMEFRAMES[timeframe];
  const last = bars?.[bars.length - 1];

  if (!tf || !last) {
    return {
      fresh: false,
      ageMs: null,
      maxAgeMs: null,
      timeframe
    };
  }

  const candleCloseTime = last.time + tf.ms;
  const ageMs = Date.now() - candleCloseTime;

  const maxAgeMs =
    tf.ms * CONFIG.FRESHNESS_INTERVALS +
    CONFIG.FRESHNESS_GRACE_MS;

  return {
    fresh: ageMs >= 0 && ageMs <= maxAgeMs,
    ageMs,
    maxAgeMs,
    timeframe
  };
}

// --------------------------------------------------
// QUALITE ET CONTINUITE DES HISTORIQUES
// --------------------------------------------------

function inspectDataQuality(bars, timeframe = "M1") {
  const tf = TIMEFRAMES[timeframe];

  if (!tf || !Array.isArray(bars) || bars.length < 30) {
    return {
      ok: false,
      timeframe,
      checkedCandles: bars?.length || 0,
      freshness: null,
      gapCount: 0,
      gaps: [],
      issues: ["Historique insuffisant"]
    };
  }

  const freshness = validateFreshness(bars, timeframe);
  const last = bars[bars.length - 1];

  const cutoff =
    last.time - CONFIG.QUALITY_LOOKBACK_MS;

  const recentBars = bars.filter(
    bar => bar.time >= cutoff
  );

  const gaps = [];

  for (let i = 1; i < recentBars.length; i++) {
    const previous = recentBars[i - 1];
    const current = recentBars[i];

    const delta = current.time - previous.time;
    const expected = tf.ms;

    if (delta > expected + CONFIG.GAP_TOLERANCE_MS) {
      gaps.push({
        from: new Date(previous.time).toISOString(),
        to: new Date(current.time).toISOString(),
        actualGapMs: delta,
        expectedGapMs: expected,
        missingIntervals: Math.max(
          0,
          Math.round(delta / expected) - 1
        )
      });
    }
  }

  const issues = [];

  if (!freshness.fresh) {
    issues.push("Derniere bougie trop ancienne ou horodatage futur");
  }

  if (gaps.length > 0) {
    issues.push(
      "Interruption detectee dans l'historique recent"
    );
  }

  return {
    ok: freshness.fresh && gaps.length === 0,
    timeframe,
    checkedCandles: recentBars.length,
    freshness,
    gapCount: gaps.length,
    gaps,
    issues
  };
}

// --------------------------------------------------
// RECUPERATION DES DONNEES DE MARCHE
// --------------------------------------------------

async function fetchCandles(timeframe = "M1", limit = 200) {
  const tf = TIMEFRAMES[String(timeframe).toUpperCase()];

  if (!tf) {
    throw new Error(
      `Timeframe non pris en charge : ${timeframe}`
    );
  }

  const url = new URL(CONFIG.SOURCE_URL);

  url.searchParams.set("interval", tf.interval);

  url.searchParams.set(
    "limit",
    String(
      Math.min(CONFIG.MAX_CANDLES, Math.max(30, limit))
    )
  );

  const response = await fetch(url.toString(), {
    headers: {
      accept: "application/json"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(
      `Source de marche indisponible : HTTP ${response.status}`
    );
  }

  const payload = await response.json();
  const bars = normalizeBars(payload);

  if (bars.length === 0) {
    throw new Error(
      `Aucune bougie exploitable pour ${timeframe}.`
    );
  }

  const now = Date.now();

  const closed = bars.filter((bar) =>
    !bar.isOpen &&
    bar.time + tf.ms <= now
  );

  if (closed.length < 30) {
    throw new Error(
      `Historique insuffisant pour ${timeframe} : ` +
      `${closed.length} bougies cloturees sur ${bars.length} recues.`
    );
  }

  return closed.slice(
    -Math.min(limit, CONFIG.MAX_CANDLES)
  );
}

// --------------------------------------------------
// INDICATEURS TECHNIQUES
// --------------------------------------------------

function sma(values, period) {
  if (values.length < period) {
    return null;
  }

  const slice = values.slice(-period);

  return slice.reduce(
    (sum, value) => sum + value, 0
  ) / period;
}

function ema(values, period) {
  if (values.length < period) {
    return null;
  }

  const k = 2 / (period + 1);

  let result = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length < period + 1) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  const averageGain = gains / period;
  const averageLoss = losses / period;

  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

function calculateATR(bars, period = 14) {
  if (bars.length < period + 1) {
    return null;
  }

  const ranges = [];

  for (let i = 1; i < bars.length; i++) {
    const current = bars[i];
    const previous = bars[i - 1];

    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  return sma(ranges, period);
}

function getIndicators(bars) {
  const closes = bars.map(bar => bar.close);
  const last = bars[bars.length - 1];

  return {
    price: last.close,
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    ema50: ema(closes, 50),
    rsi: calculateRSI(closes, 14),
    atr: calculateATR(bars, 14)
  };
}

function getTrend(indicator) {
  if (
    indicator.ema9 === null ||
    indicator.ema21 === null ||
    indicator.ema50 === null
  ) {
    return "NEUTRE";
  }

  if (
    indicator.ema9 > indicator.ema21 &&
    indicator.ema21 > indicator.ema50
  ) {
    return "HAUSSIER";
  }

  if (
    indicator.ema9 < indicator.ema21 &&
    indicator.ema21 < indicator.ema50
  ) {
    return "BAISSIER";
  }

  return "NEUTRE";
}

function roundPrice(value) {
  return Number(value.toFixed(2));
}

// --------------------------------------------------
// DETECTION DU PULLBACK M1
// --------------------------------------------------

function detectPullback(bars, indicator, direction) {
  if (
    !Array.isArray(bars) ||
    bars.length < CONFIG.PULLBACK_LOOKBACK + 2 ||
    indicator.ema9 === null ||
    indicator.ema21 === null ||
    indicator.atr === null
  ) {
    return {
      confirmed: false,
      touched: false,
      trigger: false,
      reason: "Historique ou indicateurs insuffisants"
    };
  }

  const last = bars[bars.length - 1];

  // Les bougies precedant la bougie de confirmation.
  const previousBars = bars.slice(
    -(CONFIG.PULLBACK_LOOKBACK + 1),
    -1
  );

  const tolerance = Math.max(
    indicator.atr * CONFIG.PULLBACK_ATR_TOLERANCE,
    0.01
  );

  const emaLevels = [
    indicator.ema9,
    indicator.ema21
  ];

  // Recherche d'un retour du prix vers les EMA.
  const touched = previousBars.some(bar => {
    return emaLevels.some(level => {
      return (
        bar.low <= level + tolerance &&
        bar.high >= level - tolerance
      );
    });
  });

  if (!touched) {
    return {
      confirmed: false,
      touched: false,
      trigger: false,
      reason: "Aucun retour vers les EMA 9/21"
    };
  }

  let trigger = false;

  if (direction === "ACHAT") {
    trigger =
      last.close > last.open &&
      last.close > indicator.ema9;
  }

  if (direction === "VENTE") {
    trigger =
      last.close < last.open &&
      last.close < indicator.ema9;
  }

  if (!trigger) {
    return {
      confirmed: false,
      touched: true,
      trigger: false,
      reason: "Pullback detecte, mais reprise non confirmee"
    };
  }

  return {
    confirmed: true,
    touched: true,
    trigger: true,
    reason: direction === "ACHAT"
      ? "Pullback suivi d'une reprise haussiere au-dessus de l'EMA 9"
      : "Pullback suivi d'une reprise baissiere sous l'EMA 9"
  };
}

// --------------------------------------------------
// MOTEUR DE SCENARIOS ET DE SIGNAUX
// --------------------------------------------------

function analyzeSetup(m1, m5, m15, settings) {
  const i1 = getIndicators(m1);
  const i5 = getIndicators(m5);
  const i15 = getIndicators(m15);

  const trend1 = getTrend(i1);
  const trend5 = getTrend(i5);
  const trend15 = getTrend(i15);

  const buyReasons = [];
  const sellReasons = [];

  let buyScore = 0;
  let sellScore = 0;

  // Direction principale : M15 et confirmation M5.
  if (trend15 === "HAUSSIER") {
    buyScore += 20;
    buyReasons.push("Tendance M15 haussiere");
  }

  if (trend5 === "HAUSSIER") {
    buyScore += 20;
    buyReasons.push("Tendance M5 haussiere");
  }

  if (trend15 === "BAISSIER") {
    sellScore += 20;
    sellReasons.push("Tendance M15 baissiere");
  }

  if (trend5 === "BAISSIER") {
    sellScore += 20;
    sellReasons.push("Tendance M5 baissiere");
  }

  // Tendance M1 : confirmation supplementaire.
  if (trend1 === "HAUSSIER") {
    buyScore += 10;
    buyReasons.push("Tendance M1 haussiere");
  }

  if (trend1 === "BAISSIER") {
    sellScore += 10;
    sellReasons.push("Tendance M1 baissiere");
  }

  // RSI M1.
  if (i1.rsi !== null) {
    if (i1.rsi >= 50 && i1.rsi <= 68) {
      buyScore += 15;
      buyReasons.push("RSI M1 favorable aux achats");
    }

    if (i1.rsi <= 50 && i1.rsi >= 32) {
      sellScore += 15;
      sellReasons.push("RSI M1 favorable aux ventes");
    }
  }

  // RSI M5.
  if (i5.rsi !== null) {
    if (i5.rsi >= 50 && i5.rsi <= 70) {
      buyScore += 10;
      buyReasons.push("RSI M5 confirme les achats");
    }

    if (i5.rsi <= 50 && i5.rsi >= 30) {
      sellScore += 10;
      sellReasons.push("RSI M5 confirme les ventes");
    }
  }

  // Pullback M1.
  const buyPullback = detectPullback(
    m1,
    i1,
    "ACHAT"
  );

  const sellPullback = detectPullback(
    m1,
    i1,
    "VENTE"
  );

  if (buyPullback.confirmed) {
    buyScore += 25;
    buyReasons.push(buyPullback.reason);
  }

  if (sellPullback.confirmed) {
    sellScore += 25;
    sellReasons.push(sellPullback.reason);
  }

  // Filtre de volatilite.
  const atr = i1.atr;

  const atrPercent =
    atr !== null && i1.price > 0
      ? (atr / i1.price) * 100
      : null;

  let volatility = "NORMALE";
  let volatilityAllowed = true;

  if (atrPercent === null) {
    volatility = "INDISPONIBLE";
    volatilityAllowed = false;
  } else if (atrPercent < 0.001) {
    volatility = "TROP FAIBLE";
    volatilityAllowed = false;
  } else if (atrPercent > 0.25) {
    volatility = "TROP ELEVEE";
    volatilityAllowed = false;
  }

  if (!volatilityAllowed) {
    buyScore = Math.min(buyScore, 49);
    sellScore = Math.min(sellScore, 49);
  }

  // M5 et M15 doivent etre dans la meme direction.
  if (trend5 !== trend15 || trend5 === "NEUTRE") {
    buyScore = Math.min(buyScore, 69);
    sellScore = Math.min(sellScore, 69);
  }

  // Le pullback est obligatoire pour declencher un signal.
  if (!buyPullback.confirmed) {
    buyScore = Math.min(buyScore, 74);
  }

  if (!sellPullback.confirmed) {
    sellScore = Math.min(sellScore, 74);
  }

  // Les scores restent bornes entre 0 et 100.
  buyScore = Math.min(100, buyScore);
  sellScore = Math.min(100, sellScore);

  let signal = "ATTENDRE";
  let score = Math.max(buyScore, sellScore);

  let reasons = [
    "Aucune configuration ne satisfait les filtres."
  ];

  const entry = i1.price;

  let targetPrice = null;
  let stopPrice = null;

  if (
    buyPullback.confirmed &&
    trend5 === "HAUSSIER" &&
    trend15 === "HAUSSIER" &&
    buyScore >= settings.minScore &&
    buyScore > sellScore
  ) {
    signal = "ACHAT";
    score = buyScore;
    reasons = buyReasons;

    targetPrice = roundPrice(
      entry + settings.target
    );

    stopPrice = roundPrice(
      entry - settings.stopDistance
    );

  } else if (
    sellPullback.confirmed &&
    trend5 === "BAISSIER" &&
    trend15 === "BAISSIER" &&
    sellScore >= settings.minScore &&
    sellScore > buyScore
  ) {
    signal = "VENTE";
    score = sellScore;
    reasons = sellReasons;

    targetPrice = roundPrice(
      entry - settings.target
    );

    stopPrice = roundPrice(
      entry + settings.stopDistance
    );
  }

  if (signal === "ATTENDRE") {
    reasons = [
      "Configuration incomplete : aucune entree valide.",
      `Pullback achat : ${buyPullback.reason}.`,
      `Pullback vente : ${sellPullback.reason}.`,
      `Score achat : ${buyScore}/100.`,
      `Score vente : ${sellScore}/100.`,
      `Seuil minimum : ${settings.minScore}/100.`
    ];
  }

  return {
    ok: true,
    instrument: CONFIG.INSTRUMENT,

    signal,
    score,

    // Score technique, pas probabilite statistique de gain.
    confidence: `${score}%`,

    entry: roundPrice(entry),

    targetMove: settings.target,
    stopMove: settings.stopDistance,

    targetPrice,
    stopPrice,

    capital: settings.capital,

    lotSize: settings.lots,
    lotSizingRule: "0.5 lot par tranche de 1000 USD",

    leverage: settings.leverage,

    estimatedRiskReward: Number(
      (settings.target / settings.stopDistance).toFixed(3)
    ),

    market: {
      trendM1: trend1,
      trendM5: trend5,
      trendM15: trend15,

      rsiM1:
        i1.rsi === null
          ? null
          : Number(i1.rsi.toFixed(2)),

      rsiM5:
        i5.rsi === null
          ? null
          : Number(i5.rsi.toFixed(2)),

      atrM1:
        atr === null
          ? null
          : Number(atr.toFixed(4)),

      volatility,

      pullbackM1: {
        buy: buyPullback,
        sell: sellPullback
      }
    },

    reasons,

    generatedAt: new Date().toISOString(),

    execution: "AUCUN ORDRE REEL"
  };
}

// --------------------------------------------------
// ANALYSE COMPLETE ET VALIDATION DES DONNEES
// --------------------------------------------------

async function getSignal(settings) {
  const [m1, m5, m15] = await Promise.all([
    fetchCandles("M1", 200),
    fetchCandles("M5", 200),
    fetchCandles("M15", 200)
  ]);

  const quality = {
    M1: inspectDataQuality(m1, "M1"),
    M5: inspectDataQuality(m5, "M5"),
    M15: inspectDataQuality(m15, "M15")
  };

  const dataQualityOk = Object.values(quality)
    .every(item => item.ok);

  if (!dataQualityOk) {
    return {
      ok: false,
      instrument: CONFIG.INSTRUMENT,
      signal: "ATTENDRE",
      score: 0,

      error: "Qualite des donnees insuffisante.",

      dataQuality: quality,

      reasons: [
        "Analyse bloquee : verifier la fraicheur et la continuite des bougies."
      ],

      generatedAt: new Date().toISOString(),

      execution: "AUCUN ORDRE REEL"
    };
  }

  const result = analyzeSetup(
    m1,
    m5,
    m15,
    settings
  );

  result.dataQuality = quality;

  return result;
}

// --------------------------------------------------
// ALERTES WEBHOOK
// --------------------------------------------------

async function sendAlert(env, signal) {
  if (!env.ALERT_WEBHOOK) {
    return {
      sent: false,
      reason: "ALERT_WEBHOOK non configure"
    };
  }

  if (
    !signal.ok ||
    signal.signal === "ATTENDRE"
  ) {
    return {
      sent: false,
      reason: "Aucun signal valide"
    };
  }

  const message = {
    text:
      `${CONFIG.SERVICE}: ${signal.signal} ${CONFIG.INSTRUMENT}\n` +
      `Score technique: ${signal.score}/100\n` +
      `Entree indicative: ${signal.entry}\n` +
      `Objectif: ${signal.targetPrice}\n` +
      `Stop: ${signal.stopPrice}\n` +
      `Capital: ${signal.capital} USD\n` +
      `Taille indicative: ${signal.lotSize} lot\n` +
      `Levier indicatif: x${signal.leverage}\n` +
      `Aucun ordre reel execute.`,

    signal
  };

  const response = await fetch(env.ALERT_WEBHOOK, {
    method: "POST",

    headers: {
      "content-type": "application/json"
    },

    body: JSON.stringify(message),

    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(
      `Echec du webhook d'alerte : HTTP ${response.status}`
    );
  }

  return {
    sent: true
  };
}

// --------------------------------------------------
// ROUTE HEALTH
// --------------------------------------------------

async function handleHealth() {
  return json({
    ok: true,

    service: CONFIG.SERVICE,
    status: "online",
    instrument: CONFIG.INSTRUMENT,

    strategy: {
      capitalReference: CONFIG.DEFAULT_CAPITAL,
      lotsPer1000: CONFIG.LOTS_PER_1000,
      lotSizingRule: "0.5 lot par tranche de 1000 USD",
      leverage: CONFIG.LEVERAGE,
      targetMove: CONFIG.TARGET_MOVE,
      stopMove: CONFIG.STOP_MOVE,
      minimumScore: CONFIG.MIN_SCORE,
      selectiveSignals: true,
      pullbackEnabled: true,
      pullbackLookback: CONFIG.PULLBACK_LOOKBACK,
      pullbackAtrTolerance: CONFIG.PULLBACK_ATR_TOLERANCE
    },

    dataValidation: {
      enabled: true,
      freshnessIntervals: CONFIG.FRESHNESS_INTERVALS,
      freshnessGraceMs: CONFIG.FRESHNESS_GRACE_MS,
      qualityLookbackMs: CONFIG.QUALITY_LOOKBACK_MS,
      gapToleranceMs: CONFIG.GAP_TOLERANCE_MS
    },

    liveTrading: false,
    automaticPushNotifications: false,

    endpoints: [
      "/health",
      "/gold?timeframe=M1",
      "/gold?timeframe=M5",
      "/gold?timeframe=M15",
      "/analyze",
      "/scalp",
      "/backtest"
    ],

    timestamp: new Date().toISOString()
  });
}

// --------------------------------------------------
// ROUTE GOLD
// --------------------------------------------------

async function handleGold(request) {
  const url = new URL(request.url);

  const timeframe = (
    url.searchParams.get("timeframe") || "M1"
  ).toUpperCase();

  const bars = await fetchCandles(
    timeframe,
    200
  );

  return json({
    ok: true,

    instrument: CONFIG.INSTRUMENT,
    timeframe,

    count: bars.length,

    latest: bars[bars.length - 1],

    freshness: validateFreshness(
      bars,
      timeframe
    ),

    dataQuality: inspectDataQuality(
      bars,
      timeframe
    ),

    candles: bars,

    source: CONFIG.SOURCE_URL
  });
}

// --------------------------------------------------
// ROUTE ANALYZE
// --------------------------------------------------

async function handleAnalyze(request) {
  const settings = getSettings(
    new URL(request.url)
  );

  const result = await getSignal(settings);

  return json(
    result,
    result.ok === false ? 503 : 200
  );
}

// --------------------------------------------------
// ROUTE SCALP
// --------------------------------------------------

async function handleScalp(request, env) {
  const settings = getSettings(
    new URL(request.url)
  );

  const result = await getSignal(settings);

  result.alert = {
    sent: false,
    reason: "Aucun signal valide"
  };

  if (
    result.ok &&
    result.signal !== "ATTENDRE"
  ) {
    try {
      result.alert = await sendAlert(
        env,
        result
      );
    } catch (error) {
      result.alert = {
        sent: false,
        error: error.message
      };
    }
  }

  return json(
    result,
    result.ok === false ? 503 : 200
  );
}

// --------------------------------------------------
// ROUTE BACKTEST
// --------------------------------------------------

async function handleBacktest(request) {
  const settings = getSettings(
    new URL(request.url)
  );

  const [m1, m5, m15] = await Promise.all([
    fetchCandles("M1", CONFIG.MAX_CANDLES),
    fetchCandles("M5", CONFIG.MAX_CANDLES),
    fetchCandles("M15", CONFIG.MAX_CANDLES)
  ]);

  const quality = {
    M1: inspectDataQuality(m1, "M1"),
    M5: inspectDataQuality(m5, "M5"),
    M15: inspectDataQuality(m15, "M15")
  };

  const dataQualityOk = Object.values(quality)
    .every(item => item.ok);

  if (!dataQualityOk) {
    return json({
      ok: false,
      mode: "SIGNAL ACTUEL",
      signal: "ATTENDRE",
      error: "Qualite des donnees insuffisante.",
      dataQuality: quality
    }, 503);
  }

  const result = analyzeSetup(
    m1,
    m5,
    m15,
    settings
  );

  result.dataQuality = quality;

  return json({
    ok: true,

    mode: "SIGNAL ACTUEL",

    warning:
      "Ce endpoint ne realise pas un backtest historique. " +
      "Il renvoie le signal actuel et ne mesure pas la rentabilite.",

    signal: result
  });
}

// --------------------------------------------------
// CONTROLE PERIODIQUE VIA CRON
// --------------------------------------------------

async function scheduledCheck(env) {
  const capital = CONFIG.DEFAULT_CAPITAL;

  const settings = {
    capital,
    target: CONFIG.TARGET_MOVE,
    stopDistance: CONFIG.STOP_MOVE,
    minScore: CONFIG.MIN_SCORE,
    leverage: CONFIG.LEVERAGE,

    lots: Number(
      ((capital / 1000) * CONFIG.LOTS_PER_1000).toFixed(4)
    )
  };

  const signal = await getSignal(settings);

  if (env.TP_STATE) {
    await env.TP_STATE.put(
      "last_signal",
      JSON.stringify(signal),
      {
        expirationTtl: 7 * 24 * 60 * 60
      }
    );
  }

  if (
    !signal.ok ||
    signal.signal === "ATTENDRE"
  ) {
    return signal;
  }

  let shouldAlert = true;

  if (env.TP_STATE) {
    const previous = await env.TP_STATE.get(
      "last_alert"
    );

    if (previous) {
      try {
        const old = JSON.parse(previous);

        const sameSignal =
          old.signal === signal.signal &&
          old.entry === signal.entry;

        const recent =
          Date.now() - old.time <
          CONFIG.COOLDOWN_MS;

        if (sameSignal && recent) {
          shouldAlert = false;
        }
      } catch {
        // Ignorer un etat KV invalide.
      }
    }
  }

  if (shouldAlert) {
    await sendAlert(env, signal);

    if (env.TP_STATE) {
      await env.TP_STATE.put(
        "last_alert",
        JSON.stringify({
          signal: signal.signal,
          entry: signal.entry,
          time: Date.now()
        }),
        {
          expirationTtl: 24 * 60 * 60
        }
      );
    }
  }

  return signal;
}

// --------------------------------------------------
// WORKER CLOUDFLARE
// --------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.toLowerCase();

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,

        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    if (request.method !== "GET") {
      return json({
        ok: false,
        error: "Methode non prise en charge."
      }, 405);
    }

    try {
      if (
        path === "/" ||
        path === "/health"
      ) {
        return await handleHealth();
      }

      if (path === "/gold") {
        return await handleGold(request);
      }

      if (path === "/analyze") {
        return await handleAnalyze(request);
      }

      if (path === "/scalp") {
        return await handleScalp(request, env);
      }

      if (path === "/backtest") {
        return await handleBacktest(request);
      }

      return json({
        ok: false,
        error: "Route inconnue",

        available: [
          "/health",
          "/gold",
          "/analyze",
          "/scalp",
          "/backtest"
        ]
      }, 404);

    } catch (error) {
      return json({
        ok: false,

        instrument: CONFIG.INSTRUMENT,
        signal: "ATTENDRE",

        error: "Erreur pendant l'analyse du signal.",

        details: error.message,

        timestamp: new Date().toISOString()
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      scheduledCheck(env).catch(async (error) => {
        if (env.TP_STATE) {
          await env.TP_STATE.put(
            "last_error",
            JSON.stringify({
              error: error.message,
              time: new Date().toISOString()
            }),
            {
              expirationTtl: 24 * 60 * 60
            }
          );
        }
      })
    );
  }
};
