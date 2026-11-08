const CONFIG = {
  SERVICE: "TradePilot AI",
  SYMBOL: "XAUUSD",
  SOURCE_URL: "https://biquote.io/api/XAUUSD/ohlc",

  CAPITAL: 1000,
  LOTS_PER_1000: 0.5,
  LEVERAGE: 500,

  TARGET: 2,
  STOP: 7,
  EARLY_SCORE: 45,
  MIN_SCORE: 60,

  MAX_CANDLES: 250,
  COOLDOWN_MS: 15 * 60 * 1000,

  FRESHNESS_GRACE_MS: 60_000,
  LIVE_QUOTE_MAX_AGE_SECONDS: 60,
  QUALITY_LOOKBACK_MS: 2 * 60 * 60 * 1000,
  GAP_TOLERANCE_MS: 30_000
};

const TIMEFRAMES = {
  M1: { interval: "1m", ms: 60_000 },
  M5: { interval: "5m", ms: 300_000 },
  M15: { interval: "15m", ms: 900_000 },
  H1: { interval: "1h", ms: 3_600_000 },
  H4: { interval: "4h", ms: 14_400_000 },
  D1: { interval: "1d", ms: 86_400_000 }
};

// --------------------------------------------------
// HTTP
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

  // Correction : un paramètre absent ou vide doit utiliser
  // la valeur par défaut, et non être converti en zéro.
  if (raw === null || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function getSettings(url) {
  const capital = numberParam(
    url, "capital", CONFIG.CAPITAL, 1, 100_000_000
  );

  return {
    capital,
    target: numberParam(
      url, "target", CONFIG.TARGET, 0.01, 1000
    ),
    stop: numberParam(
      url, "stopDistance", CONFIG.STOP, 0.01, 1000
    ),
    minScore: numberParam(
      url, "minScore", CONFIG.MIN_SCORE, 50, 100
    ),
    lots: Number(
      ((capital / 1000) * CONFIG.LOTS_PER_1000).toFixed(4)
    )
  };
}

// --------------------------------------------------
// NORMALISATION DES DONNEES
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

    if (!trimmed) {
      return NaN;
    }

    const numeric = Number(trimmed);

    if (Number.isFinite(numeric)) {
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

  const keys = ["bars", "candles", "data", "results", "ohlc"];

  for (const key of keys) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }

  for (const key of keys) {
    const nested = payload[key];

    if (nested && typeof nested === "object") {
      for (const child of keys) {
        if (Array.isArray(nested[child])) {
          return nested[child];
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
      "Format OHLC non reconnu. Verifier la reponse de la source."
    );
  }

  const bars = rows.map(row => {
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
      isOpen: row.isOpen === true || row.is_open === true
    };
  }).filter(bar =>
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
    if (
      unique.length &&
      unique[unique.length - 1].time === bar.time
    ) {
      unique[unique.length - 1] = bar;
    } else {
      unique.push(bar);
    }
  }

  return unique;
}

// --------------------------------------------------
// RECUPERATION DES BOUGIES
// --------------------------------------------------

async function fetchCandles(timeframe, limit = 200) {
  const tf = TIMEFRAMES[timeframe];

  if (!tf) {
    throw new Error(`Timeframe non pris en charge : ${timeframe}`);
  }

  const url = new URL(CONFIG.SOURCE_URL);
  url.searchParams.set("interval", tf.interval);
  url.searchParams.set(
    "limit",
    String(Math.min(CONFIG.MAX_CANDLES, Math.max(30, limit)))
  );

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000)
  });

  if (!response.ok) {
    throw new Error(`Erreur source OHLC : HTTP ${response.status}`);
  }

  const payload = await response.json();
  const bars = normalizeBars(payload);
  const now = Date.now();

  // Hypothese : le timestamp correspond au debut de la bougie.
  // Cette hypothese devra etre confirmee avec la documentation
  // de la source OHLC.
  const closed = bars.filter(bar =>
    !bar.isOpen &&
    bar.time + tf.ms <= now
  );

  if (closed.length < 55) {
    throw new Error(
      `Historique insuffisant pour ${timeframe} : ` +
      `${closed.length} bougies cloturees.`
    );
  }

  return closed.slice(-Math.min(limit, CONFIG.MAX_CANDLES));
}

async function fetchLiveQuote() {
  const url = new URL(`https://biquote.io/api/${CONFIG.SYMBOL}`);
  // Garder le dernier tick disponible permet de distinguer un marché fermé
  // d'une panne ou d'un flux inconnu. Il n'est jamais utilisé comme cours live
  // si son état est fermé ou si son âge dépasse le seuil strict ci-dessous.
  url.searchParams.set("allowStale", "true");

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000)
  });

  if (!response.ok) {
    throw new Error(`Cours live indisponible : HTTP ${response.status}`);
  }

  const quote = await response.json();
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const mid = Number(quote.mid);
  const timestamp = Date.parse(quote.timestamp || "");
  const rawReportedAge = quote.quoteAgeSeconds;
  const reportedAge = rawReportedAge === null || rawReportedAge === undefined || rawReportedAge === ""
    ? NaN
    : Number(rawReportedAge);
  const ageSeconds = Number.isFinite(reportedAge)
    ? reportedAge
    : (Date.now() - timestamp) / 1000;

  if (quote.marketState === "closed") {
    throw new Error("Marché XAUUSD fermé selon la source BiQuote.");
  }
  if (quote.marketState !== "open") {
    throw new Error("État du marché XAUUSD non confirmé par la source.");
  }
  if (quote.stale === true || !Number.isFinite(ageSeconds) ||
      ageSeconds < 0 || ageSeconds > CONFIG.LIVE_QUOTE_MAX_AGE_SECONDS) {
    throw new Error("Cours XAUUSD périmé. Aucun signal immédiat autorisé.");
  }
  if (!Number.isFinite(bid) || !Number.isFinite(ask) ||
      !Number.isFinite(mid) || bid <= 0 || ask < bid) {
    throw new Error("Cours XAUUSD incomplet ou incohérent.");
  }

  return {
    bid,
    ask,
    mid,
    spread: Number.isFinite(Number(quote.spread))
      ? Number(quote.spread)
      : ask - bid,
    timestamp: quote.timestamp,
    quoteAgeSeconds: Number(ageSeconds.toFixed(1)),
    marketState: quote.marketState,
    source: quote.source || "BiQuote"
  };
}

// --------------------------------------------------
// FRAICHEUR ET CONTINUITE
// --------------------------------------------------

function inspectDataQuality(bars, timeframe) {
  const tf = TIMEFRAMES[timeframe];
  const last = bars?.[bars.length - 1];

  if (!tf || !last || bars.length < 30) {
    return {
      ok: false,
      fresh: false,
      ageMs: null,
      maxAgeMs: null,
      gapCount: 0,
      gaps: [],
      reason: "Historique insuffisant"
    };
  }

  const ageMs = Date.now() - (last.time + tf.ms);
  const maxAgeMs = tf.ms * 2 + CONFIG.FRESHNESS_GRACE_MS;

  const recent = bars.filter(
    bar => bar.time >= last.time - CONFIG.QUALITY_LOOKBACK_MS
  );

  const gaps = [];

  for (let i = 1; i < recent.length; i++) {
    const delta = recent[i].time - recent[i - 1].time;

    if (delta > tf.ms + CONFIG.GAP_TOLERANCE_MS) {
      gaps.push({
        from: new Date(recent[i - 1].time).toISOString(),
        to: new Date(recent[i].time).toISOString(),
        gapMs: delta
      });
    }
  }

  const fresh = ageMs >= 0 && ageMs <= maxAgeMs;

  const issues = [];

  if (!fresh) {
    issues.push("Derniere bougie trop ancienne ou timestamp futur.");
  }

  if (gaps.length) {
    issues.push("Interruption detectee dans l'historique recent.");
  }

  return {
    ok: fresh && gaps.length === 0,
    fresh,
    ageMs,
    maxAgeMs,
    gapCount: gaps.length,
    gaps,
    issues
  };
}

// --------------------------------------------------
// INDICATEURS TECHNIQUES
// --------------------------------------------------

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) result = values[i] * k + result * (1 - k);
  return result;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = Array(values.length).fill(null);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = value;
  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
    out[i] = value;
  }
  return out;
}

function calculateRSI(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calculateATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const ranges = [];
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i], p = bars[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return sma(ranges, period);
}

function calculateMACD(values) {
  if (values.length < 35) return { macd: null, signal: null, histogram: null, previousHistogram: null };
  const fast = emaSeries(values, 12), slow = emaSeries(values, 26);
  const line = values.map((_, i) => fast[i] === null || slow[i] === null ? null : fast[i] - slow[i]);
  const validStart = line.findIndex(v => v !== null);
  const compact = line.slice(validStart);
  const sigCompact = emaSeries(compact, 9);
  const sig = Array(values.length).fill(null);
  for (let i = 0; i < sigCompact.length; i++) sig[validStart + i] = sigCompact[i];
  const i = values.length - 1, p = i - 1;
  return {
    macd: line[i],
    signal: sig[i],
    histogram: line[i] === null || sig[i] === null ? null : line[i] - sig[i],
    previousHistogram: line[p] === null || sig[p] === null ? null : line[p] - sig[p]
  };
}

function calculateBollinger(values, period = 20, deviations = 2) {
  if (values.length < period) return { middle: null, upper: null, lower: null, bandwidth: null };
  const slice = values.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = middle + deviations * sd, lower = middle - deviations * sd;
  return { middle, upper, lower, bandwidth: middle !== 0 ? (upper - lower) / middle : null };
}

function calculateADX(bars, period = 14) {
  if (bars.length < period * 2 + 1) return { adx: null, plusDI: null, minusDI: null };
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i], p = bars[i - 1];
    const up = c.high - p.high, down = p.low - c.low;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const dx = [];
  let sumTR = 0, sumPlus = 0, sumMinus = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < period) { sumTR += tr[i]; sumPlus += plusDM[i]; sumMinus += minusDM[i]; }
    else {
      sumTR = sumTR - sumTR / period + tr[i];
      sumPlus = sumPlus - sumPlus / period + plusDM[i];
      sumMinus = sumMinus - sumMinus / period + minusDM[i];
    }
    if (i >= period - 1) {
      const pdi = sumTR ? 100 * sumPlus / sumTR : 0;
      const mdi = sumTR ? 100 * sumMinus / sumTR : 0;
      dx.push({ dx: pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0, pdi, mdi });
    }
  }
  if (dx.length < period) return { adx: null, plusDI: null, minusDI: null };
  const adx = sma(dx.map(x => x.dx), period);
  return { adx, plusDI: dx[dx.length - 1].pdi, minusDI: dx[dx.length - 1].mdi };
}

function calculateStochastic(bars, period = 14, smooth = 3) {
  if (bars.length < period + smooth) return { k: null, d: null, previousK: null, previousD: null };
  const ks = [];
  for (let i = period - 1; i < bars.length; i++) {
    const window = bars.slice(i - period + 1, i + 1);
    const highest = Math.max(...window.map(b => b.high));
    const lowest = Math.min(...window.map(b => b.low));
    ks.push(highest === lowest ? 50 : 100 * (bars[i].close - lowest) / (highest - lowest));
  }
  const ds = [];
  for (let i = smooth - 1; i < ks.length; i++) ds.push(sma(ks.slice(0, i + 1), smooth));
  return {
    k: ks[ks.length - 1],
    d: ds[ds.length - 1],
    previousK: ks[ks.length - 2] ?? null,
    previousD: ds[ds.length - 2] ?? null
  };
}

function findSupportResistance(bars, lookback = 40) {
  const recent = bars.slice(-lookback);
  if (recent.length < 10) return { support: null, resistance: null };
  const support = Math.min(...recent.map(b => b.low));
  const resistance = Math.max(...recent.map(b => b.high));
  return { support, resistance };
}

function getIndicators(bars) {
  const closes = bars.map(bar => bar.close);
  return {
    price: closes[closes.length - 1],
    ema9: ema(closes, 9),
    ema20: ema(closes, 20),
    ema21: ema(closes, 21),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi: calculateRSI(closes, 14),
    atr: calculateATR(bars, 14),
    macd: calculateMACD(closes),
    bollinger: calculateBollinger(closes, 20, 2),
    adx: calculateADX(bars, 14),
    stochastic: calculateStochastic(bars, 14, 3),
    levels: findSupportResistance(bars, 40)
  };
}

function getTrend(indicator) {
  if (indicator.ema9 === null || indicator.ema21 === null || indicator.ema50 === null) return "NEUTRE";
  if (indicator.ema9 > indicator.ema21 && indicator.ema21 > indicator.ema50) return "HAUSSIER";
  if (indicator.ema9 < indicator.ema21 && indicator.ema21 < indicator.ema50) return "BAISSIER";
  return "NEUTRE";
}

function countSeparatedTouches(bars, field, level, tolerance, minGap = 2) {
  let count = 0, lastIndex = -Infinity;
  bars.forEach((bar, index) => {
    if (Math.abs(bar[field] - level) <= tolerance && index - lastIndex >= minGap) {
      count++;
      lastIndex = index;
    }
  });
  return count;
}

function analyzeMarketRegime(bars, indicator) {
  const recent = bars.slice(-40);
  const unavailable = {
    regime: "INDETERMINE", phase: "DONNEES_INSUFFISANTES",
    rangeHigh: null, rangeLow: null, rangePosition: null,
    touchesHigh: 0, touchesLow: 0, emaSlopeAtr: null,
    breakoutUp: false, breakoutDown: false,
    breakoutCandidateUp: false, breakoutCandidateDown: false,
    breakoutState: "INDISPONIBLE", breakoutDirection: "NEUTRE",
    fakeoutUp: false, fakeoutDown: false,
    rangeReentryUp: false, rangeReentryDown: false,
    rangeReentryDirection: "NEUTRE", rangeReentryDepthAtr: null,
    rangeReentryWickBodyRatio: null, rangeReentryClosePosition: null,
    rangeReentryQuality: "NON_EVALUE",
    retestUp: false, retestDown: false,
    rangeQuality: 0, rangeWidthAtr: null, emaCompressionAtr: null,
    followThrough: false, explanation: "Historique insuffisant pour classifier le régime."
  };
  if (recent.length < 25 || indicator.adx?.adx == null ||
      indicator.bollinger?.bandwidth == null || indicator.atr == null ||
      indicator.atr <= 0 || indicator.ema21 == null || indicator.ema50 == null) {
    return unavailable;
  }

  // Les trois dernières bougies restent hors de la zone de référence :
  // elles servent uniquement à observer cassure, rejet et retest.
  const base = recent.slice(0, -3);
  const last = recent[recent.length - 1];
  const previous = recent[recent.length - 2];
  const beforePrevious = recent[recent.length - 3];
  const rangeHigh = Math.max(...base.map(b => b.high));
  const rangeLow = Math.min(...base.map(b => b.low));
  const width = rangeHigh - rangeLow;
  const rangeWidthAtr = width / indicator.atr;
  const price = last.close;
  const rangePosition = width > 0 ? (price - rangeLow) / width : 0.5;
  const tolerance = Math.max(indicator.atr * 0.25, width * 0.035);
  const buffer = Math.max(indicator.atr * 0.12, width * 0.015);
  const touchesHigh = countSeparatedTouches(base, "high", rangeHigh, tolerance);
  const touchesLow = countSeparatedTouches(base, "low", rangeLow, tolerance);

  const closes = bars.map(b => b.close);
  const priorEma21 = ema(closes.slice(0, -5), 21);
  const emaSlopeAtr = priorEma21 === null ? null :
    (indicator.ema21 - priorEma21) / (indicator.atr * 5);
  const emaCompressionAtr = Math.abs(indicator.ema21 - indicator.ema50) / indicator.atr;
  const adx = indicator.adx.adx;
  const priorAdx = calculateADX(bars.slice(0, -1), 14).adx;
  const adxRising = priorAdx !== null && adx > priorAdx + 0.5;
  const compressed = indicator.bollinger.bandwidth < 0.0055;
  const flat = emaSlopeAtr !== null && Math.abs(emaSlopeAtr) < 0.24;
  const emaCompressed = emaCompressionAtr < 0.85;
  const rangeStructure = touchesHigh >= 2 && touchesLow >= 2 &&
    rangePosition >= 0 && rangePosition <= 1;
  const contained = rangePosition >= 0 && rangePosition <= 1;
  const rangeQuality = Math.max(0, Math.min(100,
    (Math.min(touchesHigh, 3) + Math.min(touchesLow, 3)) * 10 +
    (adx <= 18 ? 20 : adx <= 22 ? 12 : 0) +
    (flat ? 10 : 0) + (compressed ? 10 : 0) +
    (emaCompressed ? 10 : 0) + (rangeWidthAtr <= 7 ? 10 : 0)
  ));

  const candleRange = Math.max(last.high - last.low, 1e-9);
  const bodyRatio = Math.abs(last.close - last.open) / candleRange;
  const closeNearHigh = (last.high - last.close) / candleRange <= 0.20;
  const closeNearLow = (last.close - last.low) / candleRange <= 0.20;
  const bullishDirectional = indicator.adx.plusDI > indicator.adx.minusDI;
  const bearishDirectional = indicator.adx.minusDI > indicator.adx.plusDI;

  const fakeoutUp = (last.high > rangeHigh + buffer && last.close <= rangeHigh) ||
    (previous.close > rangeHigh + buffer && last.close < rangeHigh);
  const fakeoutDown = (last.low < rangeLow - buffer && last.close >= rangeLow) ||
    (previous.close < rangeLow - buffer && last.close > rangeLow);

  // Réintégration stricte sur la dernière bougie clôturée : la mèche traverse
  // la borne du range, mais la clôture revient à l'intérieur.
  // Une simple clôture précédente hors range ne suffit pas à qualifier la mèche.
  const rangeReentryUp = last.high > rangeHigh + buffer && last.close < rangeHigh;
  const rangeReentryDown = last.low < rangeLow - buffer && last.close > rangeLow;
  const rangeReentryDirection = rangeReentryDown ? "HAUSSIER"
    : rangeReentryUp ? "BAISSIER" : "NEUTRE";
  const reentryDepth = rangeReentryDown ? rangeLow - last.low
    : rangeReentryUp ? last.high - rangeHigh : null;
  const reentryWick = rangeReentryDown ? Math.min(last.open, last.close) - last.low
    : rangeReentryUp ? last.high - Math.max(last.open, last.close) : null;
  const reentryWickBodyRatio = reentryWick === null ? null
    : reentryWick / Math.max(Math.abs(last.close - last.open), indicator.atr * 0.01);
  const reentryClosePosition = (last.close - last.low) / candleRange;
  const reentryAlignedClose = rangeReentryDown ? reentryClosePosition >= 0.60
    : rangeReentryUp ? reentryClosePosition <= 0.40 : false;
  const rangeReentryQuality = !rangeReentryUp && !rangeReentryDown ? "NON_EVALUE"
    : reentryDepth / indicator.atr >= 0.08 && reentryWickBodyRatio >= 1.5 && reentryAlignedClose
      ? "FORTE"
      : reentryDepth / indicator.atr >= 0.03 && reentryWickBodyRatio >= 1 &&
        (rangeReentryDown ? reentryClosePosition >= 0.55 : reentryClosePosition <= 0.45)
        ? "MODEREE" : "FAIBLE";

  const breakoutCandidateUp = last.close > rangeHigh + buffer;
  const breakoutCandidateDown = last.close < rangeLow - buffer;
  const followThroughUp = previous.close > rangeHigh + buffer &&
    last.close > rangeHigh + buffer;
  const followThroughDown = previous.close < rangeLow - buffer &&
    last.close < rangeLow - buffer;
  const impulseUp = breakoutCandidateUp && bodyRatio >= 0.55 &&
    closeNearHigh && adx >= 22 && adxRising && bullishDirectional;
  const impulseDown = breakoutCandidateDown && bodyRatio >= 0.55 &&
    closeNearLow && adx >= 22 && adxRising && bearishDirectional;
  const breakoutUp = !fakeoutUp && (followThroughUp || impulseUp);
  const breakoutDown = !fakeoutDown && (followThroughDown || impulseDown);

  const retestUp = !breakoutUp && previous.close > rangeHigh + buffer &&
    last.low <= rangeHigh + tolerance && last.close > rangeHigh &&
    last.close >= last.open;
  const retestDown = !breakoutDown && previous.close < rangeLow - buffer &&
    last.high >= rangeLow - tolerance && last.close < rangeLow &&
    last.close <= last.open;

  let breakoutState = "AUCUNE";
  let breakoutDirection = "NEUTRE";
  let followThrough = false;
  if (fakeoutUp || fakeoutDown) {
    breakoutState = "FAUSSE_CASSURE";
    breakoutDirection = fakeoutUp ? "HAUSSIER" : "BAISSIER";
  } else if (breakoutUp || breakoutDown) {
    breakoutState = "CONFIRMEE";
    breakoutDirection = breakoutUp ? "HAUSSIER" : "BAISSIER";
    followThrough = breakoutUp ? followThroughUp : followThroughDown;
  } else if (breakoutCandidateUp || breakoutCandidateDown) {
    breakoutState = "EN_ATTENTE_CONFIRMATION";
    breakoutDirection = breakoutCandidateUp ? "HAUSSIER" : "BAISSIER";
  } else if (retestUp || retestDown) {
    breakoutState = "RETEST";
    breakoutDirection = retestUp ? "HAUSSIER" : "BAISSIER";
  }

  const isRange = adx <= 22 && contained && rangeWidthAtr <= 8.5 &&
    (rangeStructure || (rangeQuality >= 55 && (flat || emaCompressed || compressed)));
  const rangeCandidate = !isRange && adx <= 25 && contained &&
    rangeWidthAtr <= 10 && (rangeQuality >= 40 || flat || compressed);

  let regime = "TRANSITION";
  let phase = "MARCHE_MIXTE";
  let explanation = "Les critères de range et de tendance ne convergent pas suffisamment : phase de transition.";
  if (fakeoutUp) {
    phase = "FAUSSE_CASSURE_HAUSSIERE";
    explanation = "Le prix a dépassé la borne haute puis a clôturé à l'intérieur : fausse cassure haussière possible.";
  } else if (fakeoutDown) {
    phase = "FAUSSE_CASSURE_BAISSIERE";
    explanation = "Le prix a percé la borne basse puis a clôturé à l'intérieur : fausse cassure baissière possible.";
  } else if (breakoutUp) {
    regime = "TENDANCE"; phase = "CASSURE_HAUSSIERE";
    explanation = followThroughUp
      ? "Deux clôtures successives au-dessus de la borne haute : suivi de cassure confirmé."
      : "Impulsion haussière forte au-dessus de la borne, avec ADX en hausse et +DI dominant.";
  } else if (breakoutDown) {
    regime = "TENDANCE"; phase = "CASSURE_BAISSIERE";
    explanation = followThroughDown
      ? "Deux clôtures successives sous la borne basse : suivi de cassure confirmé."
      : "Impulsion baissière forte sous la borne, avec ADX en hausse et -DI dominant.";
  } else if (retestUp) {
    regime = "TENDANCE"; phase = "RETEST_HAUSSIER";
    explanation = "L'ancienne résistance est retestée et défendue en clôture après une clôture au-dessus de la borne.";
  } else if (retestDown) {
    regime = "TENDANCE"; phase = "RETEST_BAISSIER";
    explanation = "L'ancien support est retesté et rejeté en clôture après une clôture sous la borne.";
  } else if (breakoutCandidateUp || breakoutCandidateDown) {
    phase = "CASSURE_EN_ATTENTE";
    explanation = "Une clôture dépasse la borne, mais le suivi ou l'impulsion ne suffit pas encore à confirmer la cassure.";
  } else if (isRange) {
    regime = "RANGE";
    phase = rangePosition <= 0.25 ? "PROCHE_SUPPORT" :
      rangePosition >= 0.75 ? "PROCHE_RESISTANCE" : "MILIEU_RANGE";
    explanation = "Consolidation probable : ADX modéré/faible, prix contenu, bornes testées et compression/pente réduite.";
  } else if (rangeCandidate) {
    regime = "TRANSITION"; phase = "RANGE_POTENTIEL";
    explanation = "Consolidation possible mais les contacts ou les critères de compression ne suffisent pas à valider un range établi.";
  } else if (adx >= 25 && emaSlopeAtr !== null && Math.abs(emaSlopeAtr) >= 0.20) {
    regime = "TENDANCE";
    phase = getTrend(indicator) === "HAUSSIER" ? "TENDANCE_HAUSSIERE" :
      getTrend(indicator) === "BAISSIER" ? "TENDANCE_BAISSIERE" :
      "TENDANCE_EN_CONSTRUCTION";
    explanation = "ADX élevé et pente EMA marquée : dynamique directionnelle plus probable qu'une consolidation.";
  }

  return {
    regime, phase, rangeHigh, rangeLow,
    rangePosition: Number(rangePosition.toFixed(3)),
    touchesHigh, touchesLow,
    emaSlopeAtr: emaSlopeAtr === null ? null : Number(emaSlopeAtr.toFixed(3)),
    breakoutUp, breakoutDown, breakoutCandidateUp, breakoutCandidateDown,
    breakoutState, breakoutDirection, followThrough,
    fakeoutUp, fakeoutDown, retestUp, retestDown,
    rangeReentryUp, rangeReentryDown, rangeReentryDirection,
    rangeReentryDepthAtr: reentryDepth === null ? null : Number((reentryDepth / indicator.atr).toFixed(2)),
    rangeReentryWickBodyRatio: reentryWickBodyRatio === null ? null : Number(reentryWickBodyRatio.toFixed(2)),
    rangeReentryClosePosition: Number(reentryClosePosition.toFixed(2)),
    rangeReentryQuality,
    rangeQuality: Math.round(rangeQuality),
    rangeWidthAtr: Number(rangeWidthAtr.toFixed(2)),
    emaCompressionAtr: Number(emaCompressionAtr.toFixed(2)),
    adx: Number(adx.toFixed(2)),
    priorAdx: priorAdx === null ? null : Number(priorAdx.toFixed(2)),
    adxRising, bodyRatio: Number(bodyRatio.toFixed(2)),
    bollingerBandwidth: Number(indicator.bollinger.bandwidth.toFixed(5)),
    compressed, flat, explanation
  };
}
// --------------------------------------------------
// ANALYSE DU MARCHE : INDICATEURS + CASSURE/RETEST
// --------------------------------------------------

function analyzeSetup(m1, m5, m15, settings, liveQuote) {
  const i1 = getIndicators(m1), i5 = getIndicators(m5), i15 = getIndicators(m15);
  const t1 = getTrend(i1), t5 = getTrend(i5), t15 = getTrend(i15);
  let buyScore = 0, sellScore = 0;
  const buyReasons = [], sellReasons = [];
  const add = (side, points, reason) => {
    if (side === "BUY") { buyScore += points; buyReasons.push(reason); }
    else { sellScore += points; sellReasons.push(reason); }
  };

  if (t15 === "HAUSSIER") add("BUY", 12, "Tendance EMA M15 haussiere");
  if (t5 === "HAUSSIER") add("BUY", 12, "Tendance EMA M5 haussiere");
  if (t1 === "HAUSSIER") add("BUY", 8, "Tendance EMA M1 haussiere");
  if (t15 === "BAISSIER") add("SELL", 12, "Tendance EMA M15 baissiere");
  if (t5 === "BAISSIER") add("SELL", 12, "Tendance EMA M5 baissiere");
  if (t1 === "BAISSIER") add("SELL", 8, "Tendance EMA M1 baissiere");

  if (i1.rsi !== null && i1.rsi >= 50 && i1.rsi <= 70) add("BUY", 6, "RSI M1 favorable aux achats");
  if (i1.rsi !== null && i1.rsi <= 50 && i1.rsi >= 30) add("SELL", 6, "RSI M1 favorable aux ventes");
  if (i5.rsi !== null && i5.rsi >= 50 && i5.rsi <= 70) add("BUY", 5, "RSI M5 confirme les achats");
  if (i5.rsi !== null && i5.rsi <= 50 && i5.rsi >= 30) add("SELL", 5, "RSI M5 confirme les ventes");

  const macd = i1.macd;
  if (macd.histogram !== null && macd.previousHistogram !== null) {
    if (macd.histogram > 0 && macd.histogram > macd.previousHistogram) add("BUY", 10, "MACD positif et en acceleration");
    if (macd.histogram < 0 && macd.histogram < macd.previousHistogram) add("SELL", 10, "MACD negatif et en acceleration");
  }

  const bb = i1.bollinger;
  if (bb.lower !== null && i1.price > bb.middle && i1.price < bb.upper) add("BUY", 4, "Prix dans la moitie haute des bandes de Bollinger");
  if (bb.upper !== null && i1.price < bb.middle && i1.price > bb.lower) add("SELL", 4, "Prix dans la moitie basse des bandes de Bollinger");

  if (i1.adx.adx !== null && i1.adx.adx >= 20) {
    if (i1.adx.plusDI > i1.adx.minusDI) add("BUY", 10, "ADX confirme une force directionnelle haussiere");
    if (i1.adx.minusDI > i1.adx.plusDI) add("SELL", 10, "ADX confirme une force directionnelle baissiere");
  }

  const st = i1.stochastic;
  if (st.k !== null && st.d !== null && st.previousK !== null && st.previousD !== null) {
    if (st.previousK <= st.previousD && st.k > st.d && st.k < 80) add("BUY", 6, "Croisement haussier du stochastique");
    if (st.previousK >= st.previousD && st.k < st.d && st.k > 20) add("SELL", 6, "Croisement baissier du stochastique");
  }

  const last = m1[m1.length - 1], previous = m1[m1.length - 2];
  const levels = findSupportResistance(m1.slice(0, -1), 40);
  const tolerance = Math.max((i1.atr || 0) * 0.25, 0.15);
  const brokeUp = levels.resistance !== null && previous.close <= levels.resistance + tolerance && last.close > levels.resistance;
  const brokeDown = levels.support !== null && previous.close >= levels.support - tolerance && last.close < levels.support;
  const retestUp = levels.resistance !== null &&
    m1.slice(-4, -1).some(b => b.low <= levels.resistance + tolerance && b.low >= levels.resistance - tolerance) &&
    last.close > levels.resistance && last.close >= last.open;
  const retestDown = levels.support !== null &&
    m1.slice(-4, -1).some(b => b.high >= levels.support - tolerance && b.high <= levels.support + tolerance) &&
    last.close < levels.support && last.close <= last.open;

  // Le retest est volontairement exigeant : si aucune bougie récente
  // ne revient tester le niveau cassé, il n'ajoute pas de points.
  if (brokeUp || retestUp) add("BUY", retestUp ? 15 : 7, retestUp ? "Cassure haussiere puis retest confirme de resistance" : "Cassure haussiere de resistance (retest non confirme)");
  if (brokeDown || retestDown) add("SELL", retestDown ? 15 : 7, retestDown ? "Cassure baissiere puis retest confirme du support" : "Cassure baissiere du support (retest non confirme)");

  // RSI extreme : ne bloque pas automatiquement le scalping,
  // mais penalise les entrees tardives dans un mouvement deja etire.
  if (i1.rsi !== null) {
    if (i1.rsi >= 75) {
      buyScore -= 8;
      buyReasons.push("Penalite : RSI M1 en zone de surachat");
    } else if (i1.rsi <= 25) {
      sellScore -= 8;
      sellReasons.push("Penalite : RSI M1 en zone de survente");
    }
  }

  // Un signal oppose a la tendance M1 doit obtenir davantage
  // de confirmations ; on reduit son score sans veto automatique.
  if (t1 === "BAISSIER") buyScore -= 5;
  if (t1 === "HAUSSIER") sellScore -= 5;

  const atrPercent = i1.atr !== null && i1.price > 0 ? (i1.atr / i1.price) * 100 : null;
  let volatility = "NORMALE";
  if (atrPercent === null) volatility = "INDISPONIBLE";
  else if (atrPercent < 0.001) volatility = "TROP FAIBLE";
  else if (atrPercent > 0.25) volatility = "TROP ELEVEE";

  // Les filtres de volatilite et de tendance superieure
  // modulent le score au lieu de bloquer automatiquement tout signal.
  // La qualite/fraicheur des donnees reste, elle, un blocage strict.
  if (volatility === "TROP FAIBLE") {
    buyScore -= 8;
    sellScore -= 8;
    buyReasons.push("Penalite : volatilite faible");
    sellReasons.push("Penalite : volatilite faible");
  } else if (volatility === "TROP ELEVEE") {
    buyScore -= 12;
    sellScore -= 12;
    buyReasons.push("Penalite : volatilite tres elevee");
    sellReasons.push("Penalite : volatilite tres elevee");
  } else if (volatility === "INDISPONIBLE") {
    buyScore -= 15;
    sellScore -= 15;
  }

  if (t5 === "NEUTRE" || t15 === "NEUTRE") {
    buyScore -= 5;
    sellScore -= 5;
  } else if (t5 !== t15) {
    if (t5 === "HAUSSIER") sellScore -= 8;
    else if (t5 === "BAISSIER") buyScore -= 8;
  }

  // Classification multi-critères du régime M15, puis adaptation du setup.
  const regimeAnalysis = analyzeMarketRegime(m15, i15);
  const regime = regimeAnalysis.regime;
  let rangeLocation = "HORS_RANGE";
  if (regime === "RANGE" && regimeAnalysis.rangePosition !== null) {
    const p = regimeAnalysis.rangePosition;
    rangeLocation = p <= 0.25 ? "BORNE_BASSE" : p >= 0.75 ? "BORNE_HAUTE" : "CENTRE";
    if (rangeLocation === "BORNE_BASSE") {
      buyScore += 9;
      sellScore -= 7;
      buyReasons.push("Range M15 : proximité de la borne basse, rebond acheteur à confirmer");
      sellReasons.push("Range M15 : vente pénalisée près du support");
    } else if (rangeLocation === "BORNE_HAUTE") {
      sellScore += 9;
      buyScore -= 7;
      sellReasons.push("Range M15 : proximité de la borne haute, rejet vendeur à confirmer");
      buyReasons.push("Range M15 : achat pénalisé près de la résistance");
    } else {
      buyScore -= 12;
      sellScore -= 12;
      buyReasons.push("Range M15 : prix au milieu de la zone, entrée sans avantage");
      sellReasons.push("Range M15 : prix au milieu de la zone, entrée sans avantage");
    }
  } else if (regime === "TENDANCE") {
    const direction = regimeAnalysis.phase.includes("BAISSIERE") ? "SELL" :
      regimeAnalysis.phase.includes("HAUSSIERE") ? "BUY" : null;
    if (direction === "BUY") {
      buyScore += 5; sellScore -= 8;
      buyReasons.push("Régime M15 directionnel haussier confirmé");
    } else if (direction === "SELL") {
      sellScore += 5; buyScore -= 8;
      sellReasons.push("Régime M15 directionnel baissier confirmé");
    }
  } else if (regime === "TRANSITION") {
    buyScore -= 6; sellScore -= 6;
    buyReasons.push("Marché en transition : confirmations supplémentaires nécessaires");
    sellReasons.push("Marché en transition : confirmations supplémentaires nécessaires");
  }

  // Dans un range, un rebond doit montrer un rejet réel de la borne.
  const lastRangeBar = m15[m15.length - 1];
  const bullishRejection = lastRangeBar.close > lastRangeBar.open &&
    (lastRangeBar.close - lastRangeBar.low) > (lastRangeBar.high - lastRangeBar.low) * 0.60;
  const bearishRejection = lastRangeBar.close < lastRangeBar.open &&
    (lastRangeBar.high - lastRangeBar.close) > (lastRangeBar.high - lastRangeBar.low) * 0.60;
  if (regime === "RANGE" && rangeLocation === "BORNE_BASSE" && bullishRejection) {
    buyScore += 6;
    buyReasons.push("Bougie M15 de rejet haussier sur la borne basse");
  }
  if (regime === "RANGE" && rangeLocation === "BORNE_HAUTE" && bearishRejection) {
    sellScore += 6;
    sellReasons.push("Bougie M15 de rejet baissier sur la borne haute");
  }

  // Vérifie qu'un obstacle opposé ne se trouve pas avant l'objectif de +2 points.
  const obstacleBuffer = Math.max((i1.atr || 0) * 0.15, 0.10);
  const buyObstacleDistance = regimeAnalysis.rangeHigh !== null
    ? regimeAnalysis.rangeHigh - liveQuote.ask : Infinity;
  const sellObstacleDistance = regimeAnalysis.rangeLow !== null
    ? liveQuote.bid - regimeAnalysis.rangeLow : Infinity;
  const buyRoomOK = regime !== "RANGE" || buyObstacleDistance >= settings.target + obstacleBuffer;
  const sellRoomOK = regime !== "RANGE" || sellObstacleDistance >= settings.target + obstacleBuffer;
  if (regime === "RANGE" && !buyRoomOK) {
    buyScore -= 15;
    buyReasons.push("Espace insuffisant avant la borne haute pour viser l'objectif");
  }
  if (regime === "RANGE" && !sellRoomOK) {
    sellScore -= 15;
    sellReasons.push("Espace insuffisant avant la borne basse pour viser l'objectif");
  }

  buyScore = Math.max(0, Math.min(100, buyScore));
  sellScore = Math.max(0, Math.min(100, sellScore));
  let signal = "ATTENDRE", score = Math.max(buyScore, sellScore);
  let reasons = ["Aucune configuration ne satisfait l'ensemble des filtres."];
  let targetPrice = null, stopPrice = null;
  let entry = liveQuote.mid;

  if (buyScore >= CONFIG.EARLY_SCORE && buyScore > sellScore) {
    signal = "ACHAT"; score = buyScore; reasons = buyReasons;
    entry = liveQuote.ask;
    targetPrice = entry + settings.target;
    stopPrice = entry - settings.stop;
  } else if (sellScore >= CONFIG.EARLY_SCORE && sellScore > buyScore) {
    signal = "VENTE"; score = sellScore; reasons = sellReasons;
    entry = liveQuote.bid;
    targetPrice = entry - settings.target;
    stopPrice = entry + settings.stop;
  }

  // En range, aucune entrée immédiate sans rejet de borne et espace suffisant.
  if (regime === "RANGE") {
    const validRangeBuy = rangeLocation === "BORNE_BASSE" && bullishRejection && buyRoomOK;
    const validRangeSell = rangeLocation === "BORNE_HAUTE" && bearishRejection && sellRoomOK;
    if ((signal === "ACHAT" && !validRangeBuy) ||
        (signal === "VENTE" && !validRangeSell)) {
      signal = "ATTENDRE";
      reasons = [
        "Range détecté : aucune entrée immédiate sans rejet confirmé de la borne et espace suffisant jusqu'à l'objectif.",
        ...reasons
      ];
      targetPrice = null;
      stopPrice = null;
      entry = liveQuote.mid;
    }
  }

  const riskReward = settings.stop > 0 ? settings.target / settings.stop : 0;
  const breakEvenWinRate = settings.target + settings.stop > 0
    ? settings.stop / (settings.target + settings.stop)
    : 1;
  const spreadToATR = i1.atr > 0 ? liveQuote.spread / i1.atr : null;
  const spreadOK = spreadToATR !== null && spreadToATR <= 0.20;
  const marketRegime = regimeAnalysis.regime;

  // A signal can only be labelled CONFIRMED when the technical score
  // and the deterministic risk checks both pass. No broker order is sent.
  const riskChecks = {
    riskReward: Number(riskReward.toFixed(3)),
    breakEvenWinRate: Number((breakEvenWinRate * 100).toFixed(2)),
    // The break-even rate excludes spread, commissions and slippage.
    spreadToATR: spreadToATR === null ? null : Number(spreadToATR.toFixed(3)),
    maxSpreadToATR: 0.20,
    spreadOK,
    marketRegime,
    marketPhase: regimeAnalysis.phase,
    rangeLocation,
    buyRoomOK,
    sellRoomOK
  };

  const alertLevel = signal === "ATTENDRE" ? "NONE" :
    score >= settings.minScore && spreadOK
      ? "CONFIRMED"
      : "EARLY";

  const round = value => Number(value.toFixed(2));
  return {
    ok: true, instrument: CONFIG.SYMBOL, signal, score, alertLevel,
    entry: round(entry), targetMove: settings.target, stopMove: settings.stop,
    targetPrice: targetPrice === null ? null : round(targetPrice),
    stopPrice: stopPrice === null ? null : round(stopPrice),
    capital: settings.capital, lotSize: settings.lots, leverage: CONFIG.LEVERAGE,
    riskReward: Number((settings.target / settings.stop).toFixed(3)),
    riskChecks,
    liveQuote: {
      bid: Number(liveQuote.bid.toFixed(2)),
      ask: Number(liveQuote.ask.toFixed(2)),
      mid: Number(liveQuote.mid.toFixed(2)),
      spread: Number(liveQuote.spread.toFixed(3)),
      timestamp: liveQuote.timestamp,
      quoteAgeSeconds: liveQuote.quoteAgeSeconds,
      source: liveQuote.source
    },
    market: {
      trendM1: t1, trendM5: t5, trendM15: t15,
      rsiM1: i1.rsi === null ? null : Number(i1.rsi.toFixed(2)),
      rsiM5: i5.rsi === null ? null : Number(i5.rsi.toFixed(2)),
      atrM1: i1.atr === null ? null : Number(i1.atr.toFixed(4)),
      macdM1: {
        value: i1.macd.macd === null ? null : Number(i1.macd.macd.toFixed(4)),
        signal: i1.macd.signal === null ? null : Number(i1.macd.signal.toFixed(4)),
        histogram: i1.macd.histogram === null ? null : Number(i1.macd.histogram.toFixed(4))
      },
      bollingerM1: {
        middle: i1.bollinger.middle === null ? null : round(i1.bollinger.middle),
        upper: i1.bollinger.upper === null ? null : round(i1.bollinger.upper),
        lower: i1.bollinger.lower === null ? null : round(i1.bollinger.lower)
      },
      adxM1: {
        adx: i1.adx.adx === null ? null : Number(i1.adx.adx.toFixed(2)),
        plusDI: i1.adx.plusDI === null ? null : Number(i1.adx.plusDI.toFixed(2)),
        minusDI: i1.adx.minusDI === null ? null : Number(i1.adx.minusDI.toFixed(2))
      },
      stochasticM1: {
        k: i1.stochastic.k === null ? null : Number(i1.stochastic.k.toFixed(2)),
        d: i1.stochastic.d === null ? null : Number(i1.stochastic.d.toFixed(2))
      },
      support: levels.support === null ? null : round(levels.support),
      resistance: levels.resistance === null ? null : round(levels.resistance),
      breakoutRetest: { brokeUp, brokeDown, retestUp, retestDown },
      volatility,
      marketRegime,
      marketPhase: regimeAnalysis.phase,
      regimeExplanation: regimeAnalysis.explanation,
      range: {
        high: regimeAnalysis.rangeHigh === null ? null : round(regimeAnalysis.rangeHigh),
        low: regimeAnalysis.rangeLow === null ? null : round(regimeAnalysis.rangeLow),
        position: regimeAnalysis.rangePosition,
        location: rangeLocation,
        upperTouches: regimeAnalysis.touchesHigh,
        lowerTouches: regimeAnalysis.touchesLow,
        buyRoomOK,
        sellRoomOK,
        bullishRejection,
        bearishRejection
      },
      regimeDiagnostics: {
        adxM15: regimeAnalysis.adx ?? null,
        emaSlopeAtr: regimeAnalysis.emaSlopeAtr,
        bollingerBandwidthM15: regimeAnalysis.bollingerBandwidth ?? null,
        compressed: regimeAnalysis.compressed ?? null,
        flat: regimeAnalysis.flat ?? null,
        breakoutUp: regimeAnalysis.breakoutUp,
        breakoutDown: regimeAnalysis.breakoutDown
      }
    },
    reasons,
    generatedAt: new Date().toISOString(),
    execution: "AUCUN ORDRE REEL"
  };
}

// --------------------------------------------------
// TRADEPILOT SNIPER — VALIDATION STATISTIQUE
// --------------------------------------------------

const SNIPER_STATS = {
  KEY: "sniper_stats_v1",
  TARGET_WIN_RATE: 0.90,
  MIN_RESOLVED: 100,
  MAX_HOLD_MS: 30 * 60 * 1000,
  SAMPLE_TTL_SECONDS: 90 * 86400,
  MAX_SAMPLES: 3000,
  SAMPLE_INTERVAL_MS: 15 * 60 * 1000
};

function wilsonInterval(wins, total, z = 1.96) {
  if (!total) return { lower: null, upper: null };
  const p = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / total) + z2 / (4 * total * total)) / denominator;
  return {
    lower: Number(Math.max(0, center - margin).toFixed(4)),
    upper: Number(Math.min(1, center + margin).toFixed(4))
  };
}

function getSniperBucketStats(samples, direction, regime) {
  const bucket = samples.filter(sample =>
    sample.direction === direction &&
    sample.regime === regime &&
    ["WIN", "LOSS", "TIMEOUT"].includes(sample.outcome)
  );
  const wins = bucket.filter(sample => sample.outcome === "WIN").length;
  const losses = bucket.filter(sample => sample.outcome === "LOSS").length;
  const timeouts = bucket.filter(sample => sample.outcome === "TIMEOUT").length;
  // A timeout is a non-winning setup for the requested TP-before-SL test.
  // It stays visible separately but is included in the conservative denominator.
  const resolved = wins + losses + timeouts;
  const winRate = resolved ? wins / resolved : null;
  const interval = wilsonInterval(wins, resolved);
  return {
    direction,
    regime,
    samples: bucket.length,
    resolved,
    wins,
    losses,
    timeouts,
    winRate: winRate === null ? null : Number((winRate * 100).toFixed(2)),
    confidence95: {
      lower: interval.lower === null ? null : Number((interval.lower * 100).toFixed(2)),
      upper: interval.upper === null ? null : Number((interval.upper * 100).toFixed(2))
    },
    targetWinRate: SNIPER_STATS.TARGET_WIN_RATE * 100,
    minimumResolved: SNIPER_STATS.MIN_RESOLVED,
    qualified: resolved >= SNIPER_STATS.MIN_RESOLVED &&
      winRate >= SNIPER_STATS.TARGET_WIN_RATE
  };
}

async function updateSniperStatistics(env, signal, m1) {
  const raw = await readKV(env, SNIPER_STATS.KEY);
  let state;
  try {
    state = raw ? JSON.parse(raw) : null;
  } catch {
    state = null;
  }
  if (!state || !Array.isArray(state.samples)) state = { version: 1, samples: [] };

  const now = Date.now();
  const cutoff = now - SNIPER_STATS.SAMPLE_TTL_SECONDS * 1000;
  let samples = state.samples.filter(sample =>
    Number(sample.createdAt) >= cutoff
  );

  // Résolution chronologique : en cas de TP et SL dans la même bougie,
  // on retient le SL par prudence (l'ordre intrabougie est inconnu).
  for (const sample of samples) {
    if (sample.outcome !== "PENDING") continue;
    const eligible = m1.filter(bar =>
      bar.time >= sample.firstEligibleBarTime &&
      bar.time + TIMEFRAMES.M1.ms <= sample.expiresAt &&
      bar.time + TIMEFRAMES.M1.ms <= now
    );
    let resolved = false;

    for (const bar of eligible) {
      const hitTarget = sample.direction === "BUY"
        ? bar.high >= sample.targetMid
        : bar.low <= sample.targetMid;
      const hitStop = sample.direction === "BUY"
        ? bar.low <= sample.stopMid
        : bar.high >= sample.stopMid;

      if (hitTarget && hitStop) {
        sample.outcome = "LOSS";
        sample.resolvedAt = bar.time;
        sample.resolution = "TP_ET_SL_DANS_MEME_BOUGIE_SL_RETENU_PAR_PRUDENCE";
        resolved = true;
        break;
      }
      if (hitStop) {
        sample.outcome = "LOSS";
        sample.resolvedAt = bar.time;
        sample.resolution = "SL";
        resolved = true;
        break;
      }
      if (hitTarget) {
        sample.outcome = "WIN";
        sample.resolvedAt = bar.time;
        sample.resolution = "TP";
        resolved = true;
        break;
      }
    }

    if (!resolved && now >= sample.expiresAt) {
      sample.outcome = "TIMEOUT";
      sample.resolvedAt = sample.expiresAt;
      sample.resolution = "DUREE_MAXIMALE_ATTEINTE";
    }
  }

  const direction = signal.signal === "ACHAT" ? "BUY" :
    signal.signal === "VENTE" ? "SELL" : null;
  const regime = signal.market?.marketRegime || "INDETERMINE";

  // On n'entraîne le journal que sur les configurations techniques
  // qui auraient franchi le filtre pré-statistique. Les analyses /analyze
  // simples ne sont pas ajoutées au jeu d'apprentissage.
  if (
    direction &&
    signal.alertLevel === "CONFIRMED" &&
    !signal.blockedByEconomicCalendar &&
    signal.riskChecks?.spreadOK &&
    Number.isFinite(Number(signal.liveQuote?.mid)) &&
    Number.isFinite(Number(signal.liveQuote?.spread))
  ) {
    const sampleWindow = Math.floor(now / SNIPER_STATS.SAMPLE_INTERVAL_MS);
    const sampleId = direction + "_" + regime + "_" + sampleWindow;
    const exists = samples.some(sample => sample.id === sampleId);

    if (!exists) {
      const mid = Number(signal.liveQuote.mid);
      const spread = Math.max(0, Number(signal.liveQuote.spread));
      const target = Number(signal.targetMove);
      const stop = Number(signal.stopMove);
      const buy = direction === "BUY";
      samples.push({
        id: sampleId,
        direction,
        regime,
        score: signal.score,
        createdAt: now,
        firstEligibleBarTime: Math.floor(now / 60000) * 60000 + 60000,
        expiresAt: now + SNIPER_STATS.MAX_HOLD_MS,
        // OHLC candles are treated as approximate mid-price candles.
        // Convert executable entry (ASK for BUY / BID for SELL) to mid
        // using half the observed spread. This is still an approximation
        // because historical bid/ask ticks are not supplied by the feed.
        entryExecutable: buy ? Number(signal.liveQuote.ask) : Number(signal.liveQuote.bid),
        entryMid: mid,
        spreadAtEntry: spread,
        targetMid: buy
          ? mid + target + spread / 2
          : mid - target - spread / 2,
        stopMid: buy
          ? mid - stop + spread / 2
          : mid + stop - spread / 2,
        targetMove: target,
        stopMove: stop,
        outcome: "PENDING",
        resolution: null
      });
    }
  }

  samples.sort((a, b) => a.createdAt - b.createdAt);
  if (samples.length > SNIPER_STATS.MAX_SAMPLES) {
    samples = samples.slice(-SNIPER_STATS.MAX_SAMPLES);
  }

  const saved = await writeKV(env, SNIPER_STATS.KEY, {
    version: 1,
    updatedAt: now,
    samples
  }, SNIPER_STATS.SAMPLE_TTL_SECONDS);

  const stats = direction
    ? getSniperBucketStats(samples, direction, regime)
    : null;

  if (stats) {
    signal.statisticalValidation = {
      ...stats,
      status: !saved ? "STORAGE_UNAVAILABLE" :
        stats.resolved < SNIPER_STATS.MIN_RESOLVED ? "WAITING_FOR_SAMPLE" :
        stats.qualified ? "QUALIFIED_HISTORICALLY" : "BELOW_TARGET",
      sampleMethod: "Signaux techniques confirmés, TP/SL évalués sur bougies M1 clôturées",
      maxHoldingMinutes: SNIPER_STATS.MAX_HOLD_MS / 60000,
      spreadAdjustment: "Seuils ajustés de la moitié du spread d'entrée sur OHLC mid approximatif; commissions, slippage et bid/ask historiques non modélisés",
      sameCandleRule: "Si TP et SL sont touchés dans la même bougie, résultat compté comme perte",
      warning: "Statistique historique, non prédictive et sans garantie de résultat."
    };

    // Une alerte d'entrée exige désormais le filtre technique ET
    // 100 résultats résolus minimum avec au moins 90 % de réussite observée.
    if (
      signal.alertLevel === "CONFIRMED" &&
      (!saved || !stats.qualified)
    ) {
      signal.alertLevel = "EARLY";
      signal.statisticalValidation.blockReason = !saved
        ? "Stockage statistique indisponible."
        : stats.resolved < SNIPER_STATS.MIN_RESOLVED
          ? "Historique statistique insuffisant."
          : "Taux de réussite historique inférieur à 90 %.";
    }
  } else {
    signal.statisticalValidation = {
      status: "NO_DIRECTIONAL_SETUP",
      targetWinRate: 90,
      minimumResolved: SNIPER_STATS.MIN_RESOLVED
    };
  }

  signal.statisticalValidationStorage = saved ? "OK" : "UNAVAILABLE";
  signal.execution = "AUCUN ORDRE REEL";
  return signal;
}

// --------------------------------------------------
// ANALYSE COMPLETE
// --------------------------------------------------

async function getSignal(settings, env, recordStatistics = false) {
  let m1, m5, m15, liveQuote;

  try {
    [m1, m5, m15, liveQuote] = await Promise.all([
      fetchCandles("M1"),
      fetchCandles("M5"),
      fetchCandles("M15"),
      fetchLiveQuote()
    ]);
  } catch (error) {
    return {
      ok: false,
      instrument: CONFIG.SYMBOL,
      signal: "ATTENDRE",
      score: 0,
      error: error.message,
      execution: "AUCUN ORDRE REEL"
    };
  }

  const quality = {
    M1: inspectDataQuality(m1, "M1"),
    M5: inspectDataQuality(m5, "M5"),
    M15: inspectDataQuality(m15, "M15")
  };

  if (!Object.values(quality).every(item => item.ok)) {
    return {
      ok: false,
      instrument: CONFIG.SYMBOL,
      signal: "ATTENDRE",
      score: 0,
      error: "Qualite des donnees insuffisante.",
      dataQuality: quality,
      execution: "AUCUN ORDRE REEL"
    };
  }

  const result = analyzeSetup(m1, m5, m15, settings, liveQuote);
  result.dataQuality = quality;

  const economicContext = await getEconomicContext(env);
  const filtered = applyEconomicFilter(result, economicContext);
  return recordStatistics
    ? await updateSniperStatistics(env, filtered, m1)
    : filtered;
}

// --------------------------------------------------
// TELEGRAM
// --------------------------------------------------

function telegramConfigured(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

async function sendTelegram(env, textMessage) {
  if (!telegramConfigured(env)) {
    throw new Error("Configuration Telegram absente.");
  }

  const url =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: textMessage,
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(10_000)
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || `Telegram HTTP ${response.status}`
    );
  }

  return result;
}

function buildAlertMessage(signal) {
  const reasons = signal.reasons
    .map(reason => `• ${reason}`)
    .join("\n");
  const confirmed = signal.alertLevel === "CONFIRMED";
  const action = signal.signal === "ACHAT" ? "ACHAT" : "VENTE";
  const entrySide = signal.signal === "ACHAT" ? "ASK" : "BID";

  return [
    `🚨 TRADEPILOT AI — ${signal.instrument}`,
    "",
    confirmed
      ? `📊 DECISION : ${action} MAINTENANT`
      : `📊 SIGNAL : ${action} — À SURVEILLER, PAS D'ENTRÉE`,
    `🎯 Score technique : ${signal.score}/100`,
    "",
    `💰 Prix de référence ${entrySide} à l'alerte : ${signal.entry}`,
    `📡 Bid : ${signal.liveQuote.bid} | Ask : ${signal.liveQuote.ask}`,
    `🎯 Objectif de mouvement : +${signal.targetMove}$ dans ton sens depuis TON prix d'entrée MT5`,
    `🛑 Invalidation : -${signal.stopMove}$ contre ta position depuis TON prix d'entrée MT5`,
    `⚠️ Niveaux affichés calculés depuis le prix de l'alerte : recalcule TP/SL depuis le prix réel d'exécution MT5.`,
    `🕒 Âge du cours reçu : ${signal.liveQuote.quoteAgeSeconds}s`,
    `🕓 Horodatage du cours : ${signal.liveQuote.timestamp}`,
    `✅ Take Profit calculé : ${signal.targetPrice}`,
    `🛑 Stop Loss calculé : ${signal.stopPrice}`,
    "",
    `📦 Taille indicative : ${signal.lotSize} lot`,
    `💵 Capital de référence : ${signal.capital} USD`,
    `⚙️ Levier indicatif : x${signal.leverage}`,
    `⚖️ Ratio gain/risque : ${signal.riskReward}`,
    `📊 Point mort théorique hors frais : ${signal.riskChecks.breakEvenWinRate}%`,
    `🧪 Validation historique : ${signal.statisticalValidation?.winRate ?? "en constitution"}% (${signal.statisticalValidation?.resolved ?? 0}/100 trades résolus)`,
    `🛡️ Régime : ${signal.market.marketRegime || "INDÉTERMINÉ"}`,
    "",
    "📈 Tendances :",
    `M1 : ${signal.market.trendM1}`,
    `M5 : ${signal.market.trendM5}`,
    `M15 : ${signal.market.trendM15}`,
    "",
    "Motifs :",
    reasons,
    "",
    confirmed
      ? "⚠️ Signal basé sur un cours live BiQuote. Vérifie le prix affiché sur MT5 avant toute entrée manuelle. Aucun ordre réel exécuté."
      : "⚠️ Score sous le seuil de confirmation : ne pas entrer sur ce signal. Aucun ordre réel exécuté."
  ].join("\n");
}

// --------------------------------------------------
// KV ET ANTI-DOUBLON
// --------------------------------------------------

async function readKV(env, key) {
  if (!env.TP_STATE) {
    return null;
  }

  try {
    return await env.TP_STATE.get(key);
  } catch {
    return null;
  }
}

async function writeKV(env, key, value, ttl = 86400) {
  if (!env.TP_STATE) {
    return false;
  }

  try {
    await env.TP_STATE.put(key, JSON.stringify(value), {
      expirationTtl: ttl
    });

    return true;
  } catch {
    return false;
  }
}


// --------------------------------------------------
// CALENDRIER ECONOMIQUE — Finance Calendar API
// --------------------------------------------------

const ECONOMIC_CALENDAR = {
  URL: "https://www.financecalendar.com/wp-json/fc/v1/calendar",
  CACHE_KEY: "economic_calendar_cache",
  REFRESH_MS: 15 * 60 * 1000,
  BEFORE_MS: 15 * 60 * 1000,
  AFTER_MS: 15 * 60 * 1000
};

function classifyGoldEvent(event) {
  const name = String(event.name || event.title || event.series_name || "").toLowerCase();
  const criticalTerms = [
    "fomc", "federal funds", "interest rate", "fed rate", "powell",
    "nonfarm", "non-farm", "payroll", "consumer price", "cpi",
    "pce", "inflation", "unemployment rate", " ism ", "gdp"
  ];
  const critical = criticalTerms.some(term => name.includes(term));
  return {
    goldImpact: critical ? "CRITIQUE" : "IMPORTANT",
    goldImpactReason: critical
      ? "Publication généralement sensible au dollar, aux taux ou aux anticipations de politique monétaire."
      : "Publication majeure susceptible d'influencer le dollar ou le sentiment de marché."
  };
}

function numericMacroValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const match = String(value).trim().replace(/\s/g, "").replace(/,/g, ".").match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}
function evaluateGoldMacroSurprise(event) {
  if (event.observation_status === "stale") return null;
  const quality = event.data_quality?.fields || {};
  if (quality.actual?.availability === "unavailable" || quality.consensus?.availability === "unavailable") return null;
  const actual = numericMacroValue(event.actual);
  const consensus = numericMacroValue(event.consensus);
  if (actual === null || consensus === null) return null;
  const diff = actual - consensus;
  const tolerance = Math.max(0.0000001, Math.abs(consensus) * 0.000001);
  const comparison = Math.abs(diff) <= tolerance ? "CONFORME_AUX_ATTENTES" : diff > 0 ? "SUPERIEUR_AU_CONSENSUS" : "INFERIEUR_AU_CONSENSUS";
  const label = String(event.name || event.title || event.series_name || "").toLowerCase();
  const inverse = /(unemployment rate|jobless claims|initial claims|continuing claims)/i.test(label);
  const usdSensitive = /(cpi|consumer price|inflation|pce|nonfarm|non-farm|payroll|employment|gdp|gross domestic|ism|pmi|retail sales|federal funds|interest rate|fed rate)/i.test(label);
  let goldBias = "NON_CLASSE", reason = "Indicateur non classé : pas de biais automatique pour l'or.";
  if (comparison === "CONFORME_AUX_ATTENTES") { goldBias = "IMPACT_DIRECTIONNEL_LIMITÉ"; reason = "Résultat proche du consensus : surprise statistique limitée."; }
  else if (inverse) { goldBias = diff > 0 ? "SOUTIEN_POTENTIEL_OR" : "PRESSION_POTENTIELLE_OR"; reason = "Pour cet indicateur, une valeur supérieure peut signaler un marché du travail moins tendu."; }
  else if (usdSensitive) { goldBias = diff > 0 ? "PRESSION_POTENTIELLE_OR" : "SOUTIEN_POTENTIEL_OR"; reason = "Surprise généralement associée à des anticipations de taux plus restrictives si le chiffre dépasse le consensus."; }
  return { actual:event.actual, consensus:event.consensus, prior:event.prior ?? null, unit:event.unit || null, difference:Number(diff.toFixed(6)), comparison, goldBias, reason, sourceUrl:event.source_url || event.url || null, sourceName:event.source_name || null, verifiedAt:event.last_verified_at || null, dataQuality:event.data_quality?.fields || null };
}
function evaluateEconomicEvents(events, fetchedAt, stale = false) {
  const now = Date.now();
  const relevant = events.filter(event =>
    String(event.impact || "").toLowerCase() === "high" &&
    ["US", "EU"].includes(String(event.country || "").toUpperCase()) &&
    ["economic-indicators", "central-banks-monetary-policy"].includes(event.category) &&
    event.status !== "cancelled" &&
    event.data_stale !== true
  );

  const timed = relevant.map(event => ({
    ...event,
    ...classifyGoldEvent(event),
    releaseMs: Date.parse(event.release_at_utc || event.time_utc || ""),
    windowStartMs: Date.parse(event.time_window_start || ""),
    windowEndMs: Date.parse(event.time_window_end || "")
  }));

  const activeEvent = timed.find(event => {
    if (Number.isFinite(event.releaseMs)) {
      return now >= event.releaseMs - ECONOMIC_CALENDAR.BEFORE_MS &&
        now <= event.releaseMs + ECONOMIC_CALENDAR.AFTER_MS;
    }
    if (Number.isFinite(event.windowStartMs) && Number.isFinite(event.windowEndMs)) {
      return now >= event.windowStartMs - ECONOMIC_CALENDAR.BEFORE_MS &&
        now <= event.windowEndMs + ECONOMIC_CALENDAR.AFTER_MS;
    }
    return false;
  }) || null;

  const upcomingEvents = timed
    .filter(event => Number.isFinite(event.releaseMs) &&
      event.releaseMs > now &&
      event.releaseMs <= now + 24 * 60 * 60 * 1000)
    .sort((a, b) => a.releaseMs - b.releaseMs)
    .slice(0, 8)
    .map(event => ({
      id: event.id || null,
      name: event.name || event.title || event.series_name || "Annonce économique",
      country: event.country || null,
      impact: event.impact || null,
      goldImpact: event.goldImpact,
      goldImpactReason: event.goldImpactReason,
      releaseAt: event.release_at_utc || event.time_utc || null,
      minutesUntil: Math.max(0, Math.round((event.releaseMs - now) / 60000)),
      url: event.url || null
    }));

  const nextEvent = upcomingEvents[0] || null;
  const recentSurprises = stale ? [] : timed
    .filter(event => Number.isFinite(event.releaseMs) &&
      event.releaseMs <= now &&
      event.releaseMs >= now - 72 * 60 * 60 * 1000 &&
      event.status === "released" &&
      event.data_stale !== true)
    .map(event => {
      const surprise = evaluateGoldMacroSurprise(event);
      return surprise ? {
        id: event.id || null,
        name: event.name || event.title || event.series_name || "Publication économique",
        country: event.country || null,
        releaseAt: event.release_at_utc || event.time_utc || null,
        ...surprise
      } : null;
    })
    .filter(Boolean)
    .sort((a,b) => Date.parse(b.releaseAt) - Date.parse(a.releaseAt))
    .slice(0, 6);
  const riskLevel = stale ? "DONNEES_PERIMEES"
    : activeEvent ? "FENETRE_ANNONCE"
      : nextEvent && nextEvent.minutesUntil <= 60 ? "ELEVE"
        : nextEvent ? "A_SURVEILLER" : "NORMAL";

  return {
    configured: true,
    status: stale ? "STALE_CACHE" : "OK",
    source: "Finance Calendar",
    sourceUrl: "https://www.financecalendar.com",
    fetchedAt,
    stale,
    eventCount: relevant.length,
    blackout: Boolean(activeEvent),
    riskLevel,
    nextEvent,
    upcomingEvents,
    recentSurprises,
    activeEvent: activeEvent ? {
      id: activeEvent.id || null,
      name: activeEvent.name || activeEvent.title || activeEvent.series_name || "Annonce économique",
      country: activeEvent.country || null,
      impact: activeEvent.impact || null,
      goldImpact: activeEvent.goldImpact,
      releaseAt: activeEvent.release_at_utc || activeEvent.time_utc || null,
      url: activeEvent.url || null
    } : null,
    events: relevant.slice(0, 30),
    safeToTrade: !stale
  };
}

async function getEconomicContext(env) {
  const apiKey = String(env.FINANCE_CALENDAR_API_KEY || "").trim();

  if (!apiKey) {
    return {
      configured: false,
      status: "API_KEY_MISSING",
      source: "Finance Calendar",
      blackout: false,
      safeToTrade: false,
      message: "Secret FINANCE_CALENDAR_API_KEY absent."
    };
  }

  const cachedRaw = await readKV(env, ECONOMIC_CALENDAR.CACHE_KEY);
  let cached = null;

  try {
    if (cachedRaw) cached = JSON.parse(cachedRaw);
  } catch {
    cached = null;
  }

  if (
    cached &&
    Array.isArray(cached.events) &&
    Date.now() - Number(cached.fetchedAt || 0) < ECONOMIC_CALENDAR.REFRESH_MS
  ) {
    return evaluateEconomicEvents(cached.events, cached.fetchedAt, false);
  }

  try {
    const now = new Date();
    const from = new Date(now.getTime() - 3 * 86400 * 1000)
      .toISOString().slice(0, 10);
    const to = new Date(now.getTime() + 7 * 86400 * 1000)
      .toISOString().slice(0, 10);

    // Requête minimale conforme à l'exemple officiel de l'API.
    // On réintroduira les filtres de dates/fuseau après validation.
    const url = new URL(ECONOMIC_CALENDAR.URL);
    // Gold is primarily USD-sensitive; include Euro-area releases as well.
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("country", "US,EU");
    url.searchParams.set("impact", "high");
    url.searchParams.set("tz", "Europe/Paris");
    url.searchParams.set("limit", "100");

    const response = await fetch(url.toString(), {
      headers: {
        accept: "application/json",
        "X-API-Key": apiKey
      },
      signal: AbortSignal.timeout(12_000)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        "Calendrier économique HTTP " + response.status +
        " : " + errorBody.slice(0, 500)
      );
    }

    const payload = await response.json();
    if (!Array.isArray(payload.events)) {
      throw new Error("Réponse du calendrier économique invalide.");
    }

    const fetchedAt = Date.now();
    await writeKV(env, ECONOMIC_CALENDAR.CACHE_KEY, {
      fetchedAt,
      events: payload.events
    }, 2 * 86400);

    return evaluateEconomicEvents(payload.events, fetchedAt, false);
  } catch (error) {
    if (cached && Array.isArray(cached.events)) {
      const fallback = evaluateEconomicEvents(
        cached.events,
        cached.fetchedAt,
        true
      );
      return {
        ...fallback,
        status: "API_ERROR_USING_STALE_CACHE",
        message: error.message,
        safeToTrade: false
      };
    }

    return {
      configured: true,
      status: "API_ERROR",
      source: "Finance Calendar",
      blackout: false,
      safeToTrade: false,
      message: error.message
    };
  }
}

function applyEconomicFilter(signal, context) {
  signal.economicCalendar = {
    configured: context.configured,
    status: context.status,
    blackout: context.blackout,
    safeToTrade: context.safeToTrade,
    activeEvent: context.activeEvent || null,
    source: context.source || "Finance Calendar",
    sourceUrl: context.sourceUrl || "https://www.financecalendar.com"
  };

  if (!context.safeToTrade || context.blackout) {
    signal.technicalSignal = signal.signal;
    signal.technicalScore = signal.score;
    signal.signal = "ATTENDRE";
    signal.alertLevel = "NONE";
    signal.blockedByEconomicCalendar = true;
    signal.reasons = [
      context.blackout
        ? "Entrée bloquée : annonce économique majeure dans la fenêtre de sécurité de 15 minutes."
        : "Entrée bloquée : calendrier économique indisponible ou non vérifié.",
      ...(signal.reasons || [])
    ];
  } else {
    signal.blockedByEconomicCalendar = false;
  }

  return signal;
}

function getAlertKey(signal) {
  // Cle stable par direction et niveau : evite les doublons
  // provoques par les petites variations du prix d'entree.
  return [signal.signal, signal.alertLevel || "CONFIRMED"].join("_");
}

async function shouldSendAlert(env, signal) {
  const previousRaw = await readKV(env, "last_alert");

  if (!previousRaw) {
    return true;
  }

  try {
    const previous = JSON.parse(previousRaw);
    const sameSignal = previous.key === getAlertKey(signal);
    const recent =
      Date.now() - previous.time < CONFIG.COOLDOWN_MS;

    return !(sameSignal && recent);
  } catch {
    return true;
  }
}

// --------------------------------------------------
// ETAT DU CRON
// --------------------------------------------------

async function saveCronStatus(env, status, details = {}) {
  await writeKV(env, "cron_status", {
    status,
    ...details,
    updatedAt: new Date().toISOString()
  }, 7 * 86400);
}

// --------------------------------------------------
// EXECUTION AUTOMATIQUE
// --------------------------------------------------

async function scheduledCheck(env) {
  await saveCronStatus(env, "RUNNING");

  try {
    const settings = {
      capital: CONFIG.CAPITAL,
      target: CONFIG.TARGET,
      stop: CONFIG.STOP,
      minScore: CONFIG.MIN_SCORE,
      lots: CONFIG.LOTS_PER_1000
    };

    const signal = await getSignal(settings, env, true);

    await writeKV(env, "last_signal", signal, 7 * 86400);

    if (!signal.ok) {
      await saveCronStatus(env, "DATA_ERROR", {
        message: signal.error,
        dataQuality: signal.dataQuality
      });

      return signal;
    }

    if (signal.signal === "ATTENDRE") {
      await saveCronStatus(env, "COMPLETED", {
        signal: signal.signal,
        score: signal.score,
        alertSent: false,
        message: "Analyse terminee : aucun signal valide."
      });

      return signal;
    }

    if (signal.alertLevel !== "CONFIRMED") {
      await saveCronStatus(env, "COMPLETED", {
        signal: signal.signal,
        score: signal.score,
        alertSent: false,
        message: "Signal sous le seuil de confirmation : conserve en surveillance, sans alerte d'entree."
      });

      return signal;
    }

    if (!(await shouldSendAlert(env, signal))) {
      await saveCronStatus(env, "COMPLETED", {
        signal: signal.signal,
        score: signal.score,
        alertSent: false,
        message: "Signal identique deja notifie recemment."
      });

      return signal;
    }

    await sendTelegram(env, buildAlertMessage(signal));

    await writeKV(env, "last_alert", {
      key: getAlertKey(signal),
      signal: signal.signal,
      alertLevel: signal.alertLevel || "CONFIRMED",
      entry: signal.entry,
      time: Date.now()
    }, 7 * 86400);

    await saveCronStatus(env, "ALERT_SENT", {
      signal: signal.signal,
      score: signal.score,
      alertSent: true,
      message: "Alerte Telegram envoyee automatiquement."
    });

    return signal;
  } catch (error) {
    await saveCronStatus(env, "ERROR", {
      message: error.message
    });

    throw error;
  }
}


function findSwingPoints(bars, left = 2, right = 2) {
  const highs = [], lows = [];
  for (let i = left; i < bars.length - right; i++) {
    const h = bars[i].high, l = bars[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].high >= h) isHigh = false;
      if (bars[j].low <= l) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: h, time: bars[i].time });
    if (isLow) lows.push({ index: i, price: l, time: bars[i].time });
  }
  return { highs, lows };
}

function analyzeStructure(bars, indicator) {
  const recent = bars.slice(-100);
  const swings = findSwingPoints(recent);
  const highs = swings.highs.slice(-3), lows = swings.lows.slice(-3);
  const last = recent[recent.length - 1];
  const previous = recent[recent.length - 2];
  const lastHigh = swings.highs[swings.highs.length - 1] || null;
  const lastLow = swings.lows[swings.lows.length - 1] || null;
  const priorHigh = swings.highs[swings.highs.length - 2] || null;
  const priorLow = swings.lows[swings.lows.length - 2] || null;

  // Une structure n'est qualifiée que si deux sommets ET deux creux
  // confirmés sont disponibles. Les pivots utilisent 2 bougies à droite.
  const enoughSwings = Boolean(lastHigh && priorHigh && lastLow && priorLow);
  const bullishStructure = Boolean(enoughSwings &&
    lastHigh.price > priorHigh.price && lastLow.price > priorLow.price);
  const bearishStructure = Boolean(enoughSwings &&
    lastHigh.price < priorHigh.price && lastLow.price < priorLow.price);

  // Un événement est validé par une clôture qui franchit un pivot confirmé.
  // Un CHOCH est une rupture contre la structure précédente; un BOS la prolonge.
  const crossAboveSwing = Boolean(lastHigh && previous.close <= lastHigh.price &&
    last.close > lastHigh.price);
  const crossBelowSwing = Boolean(lastLow && previous.close >= lastLow.price &&
    last.close < lastLow.price);
  const chochDown = Boolean(bullishStructure && crossBelowSwing);
  const chochUp = Boolean(bearishStructure && crossAboveSwing);
  const bosUp = Boolean(crossAboveSwing && !bearishStructure);
  const bosDown = Boolean(crossBelowSwing && !bullishStructure);

  const closes = recent.map(b => b.close);
  const rsiAt = index => calculateRSI(closes.slice(0, index + 1), 14);
  const macdAt = index => calculateMACD(closes.slice(0, index + 1)).macd;
  const pivotLows = swings.lows.slice(-2), pivotHighs = swings.highs.slice(-2);
  const recentPivot = pivot => Boolean(pivot && recent.length - 1 - pivot.index <= 20);
  const compareOscillator = (pivots, oscillatorAt, side) => {
    if (pivots.length !== 2) return false;
    const [a, b] = pivots;
    if (!recentPivot(b) || b.index <= a.index) return false;
    const first = oscillatorAt(a.index), second = oscillatorAt(b.index);
    if (!Number.isFinite(first) || !Number.isFinite(second)) return false;
    return side === "LOW"
      ? b.price < a.price && second > first
      : b.price > a.price && second < first;
  };
  const bullishDivergence = compareOscillator(pivotLows, rsiAt, "LOW");
  const bearishDivergence = compareOscillator(pivotHighs, rsiAt, "HIGH");
  const bullishMacdDivergence = compareOscillator(pivotLows, macdAt, "LOW");
  const bearishMacdDivergence = compareOscillator(pivotHighs, macdAt, "HIGH");
  const bullishDivergenceCount = Number(bullishDivergence) + Number(bullishMacdDivergence);
  const bearishDivergenceCount = Number(bearishDivergence) + Number(bearishMacdDivergence);
  const divergenceBias = bullishDivergenceCount > bearishDivergenceCount ? "HAUSSIER" :
    bearishDivergenceCount > bullishDivergenceCount ? "BAISSIER" :
    bullishDivergenceCount > 0 ? "MIXTE" : "AUCUNE";


  const breakEvent = chochUp ? "CHOCH_HAUSSIER" :
    chochDown ? "CHOCH_BAISSIER" :
    bosUp ? "BOS_HAUSSIER" :
    bosDown ? "BOS_BAISSIER" : "AUCUN";
  const breakLevel = chochUp || bosUp ? lastHigh?.price :
    chochDown || bosDown ? lastLow?.price : null;

  return {
    structure: bullishStructure ? "SOMMETS ET CREUX ASCENDANTS" :
      bearishStructure ? "SOMMETS ET CREUX DESCENDANTS" :
      enoughSwings ? "STRUCTURE MIXTE" : "PIVOTS INSUFFISANTS",
    structureBias: bullishStructure ? "HAUSSIER" :
      bearishStructure ? "BAISSIER" : "NEUTRE",
    confirmedSwingCount: swings.highs.length + swings.lows.length,
    bos: bosUp ? "BOS_HAUSSIER" : bosDown ? "BOS_BAISSIER" : "AUCUN",
    choch: chochUp ? "CHOCH_HAUSSIER" : chochDown ? "CHOCH_BAISSIER" : "AUCUN",
    breakEvent,
    breakLevel,
    bullishDivergence, bearishDivergence,
    bullishMacdDivergence, bearishMacdDivergence,
    bullishDivergenceCount, bearishDivergenceCount, divergenceBias,
    lastSwingHigh: lastHigh ? lastHigh.price : null,
    lastSwingLow: lastLow ? lastLow.price : null,
    recentHighs: highs.map(x => x.price),
    recentLows: lows.map(x => x.price)
  };
}

function describeTrendStrength(indicator, trend) {
  const adx = indicator.adx?.adx;
  let strength = "INDISPONIBLE";
  if (Number.isFinite(adx)) {
    strength = adx < 15 ? "FAIBLE" : adx < 25 ? "MODEREE" : adx < 40 ? "FORTE" : "TRES FORTE";
  }
  return {
    direction: trend,
    strength,
    adx: Number.isFinite(adx) ? Number(adx.toFixed(2)) : null,
    technicalScore: Number.isFinite(adx)
      ? Math.max(0, Math.min(100, Math.round(adx * 2)))
      : null,
    scoreMeaning: "Indice technique descriptif, pas une probabilité de réussite."
  };
}

function analyzeVolatility(bars, indicator) {
  if (!Array.isArray(bars) || bars.length < 40 ||
      !Number.isFinite(indicator.atr) || !Number.isFinite(indicator.price) ||
      indicator.price <= 0) {
    return {
      status: "INDETERMINE", atr: indicator.atr ?? null,
      atrPercent: null, recentVsBaseline: null, lastCandleAtr: null,
      recentAverageAtr: null, scalpCondition: "NON EVALUEE",
      explanation: "Historique insuffisant pour mesurer correctement la volatilité."
    };
  }

  const trueRanges = bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previousClose = bars[index - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose)
    );
  });
  const recent = trueRanges.slice(-5);
  const baseline = trueRanges.slice(-25, -5);
  const recentAverage = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const baselineAverage = baseline.reduce((sum, value) => sum + value, 0) / baseline.length;
  const recentVsBaseline = baselineAverage > 0 ? recentAverage / baselineAverage : null;
  const last = bars[bars.length - 1];
  const lastCandleAtr = indicator.atr > 0 ? (last.high - last.low) / indicator.atr : null;
  const atrPercent = indicator.atr / indicator.price * 100;

  let status = "NORMALE";
  let explanation = "Volatilité proche de sa référence récente.";
  let scalpCondition = "A EVALUER AVEC LES AUTRES INDICATEURS";

  if ((lastCandleAtr !== null && lastCandleAtr >= 2.5) ||
      (recentVsBaseline !== null && recentVsBaseline >= 2)) {
    status = "EXTREME";
    explanation = "Mouvement anormalement ample : risque de spread élargi, glissement et faux départs.";
    scalpCondition = "PRUDENCE ELEVEE — EVITER DE POURSUIVRE UNE BOUGIE ETIREE";
  } else if (recentVsBaseline !== null && recentVsBaseline >= 1.35) {
    status = "ACCELERATION";
    explanation = "La volatilité augmente nettement : rechercher une clôture et un retest plutôt que poursuivre l'impulsion.";
    scalpCondition = "ATTENDRE CONFIRMATION ET RETEST";
  } else if (recentVsBaseline !== null && recentVsBaseline <= 0.70) {
    status = "CONTRACTION";
    explanation = "La volatilité se contracte : risque de marché endormi avant une éventuelle expansion.";
    scalpCondition = "MOUVEMENT INSUFFISANT — ATTENDRE UNE SORTIE CONFIRMEE";
  }

  return {
    status,
    atr: Number(indicator.atr.toFixed(5)),
    atrPercent: Number(atrPercent.toFixed(4)),
    recentVsBaseline: recentVsBaseline === null ? null : Number(recentVsBaseline.toFixed(2)),
    lastCandleAtr: lastCandleAtr === null ? null : Number(lastCandleAtr.toFixed(2)),
    recentAverageAtr: Number(recentAverage.toFixed(5)),
    baselineAverageAtr: Number(baselineAverage.toFixed(5)),
    scalpCondition,
    explanation,
    note: "Mesure relative aux bougies récentes de cette unité de temps ; ne prédit pas le sens du prochain mouvement."
  };
}

function analyzeLiquidity(bars, indicator) {
  if (!Array.isArray(bars) || bars.length < 40 ||
      !Number.isFinite(indicator.atr) || indicator.atr <= 0) {
    return {
      status: "INDETERMINE", buySideLevels: [], sellSideLevels: [],
      equalHighs: [], equalLows: [], sweep: "AUCUN",
      explanation: "Historique ou ATR insuffisant pour cartographier les zones de liquidité."
    };
  }

  const recent = bars.slice(-100);
  const swings = findSwingPoints(recent);
  const last = recent[recent.length - 1];
  const tolerance = Math.max(indicator.atr * 0.18, indicator.price * 0.00015);
  const buffer = Math.max(indicator.atr * 0.08, indicator.price * 0.00005);

  const clusterLevels = points => {
    const clusters = [];
    for (const point of points) {
      let cluster = clusters.find(item => Math.abs(item.level - point.price) <= tolerance);
      if (!cluster) {
        cluster = { level: point.price, touches: 0, lastIndex: point.index };
        clusters.push(cluster);
      }
      cluster.touches++;
      cluster.level = (cluster.level * (cluster.touches - 1) + point.price) / cluster.touches;
      cluster.lastIndex = Math.max(cluster.lastIndex, point.index);
    }
    return clusters
      .filter(item => item.touches >= 2)
      .sort((a, b) => b.lastIndex - a.lastIndex)
      .slice(0, 4)
      .map(item => ({
        level: Number(item.level.toFixed(2)),
        touches: item.touches,
        label: item.touches >= 3 ? "EGAUX MULTIPLES" : "EGAUX"
      }));
  };

  const equalHighs = clusterLevels(swings.highs);
  const equalLows = clusterLevels(swings.lows);
  const buySideLevels = [...equalHighs, ...swings.highs.slice(-3).map(p => ({
    level: Number(p.price.toFixed(2)), touches: 1, label: "SOMMET CONFIRME"
  }))].sort((a, b) => a.level - b.level)
    .filter((item, index, all) => all.findIndex(x => Math.abs(x.level - item.level) <= tolerance) === index)
    .slice(-5);
  const sellSideLevels = [...equalLows, ...swings.lows.slice(-3).map(p => ({
    level: Number(p.price.toFixed(2)), touches: 1, label: "CREUX CONFIRME"
  }))].sort((a, b) => a.level - b.level)
    .filter((item, index, all) => all.findIndex(x => Math.abs(x.level - item.level) <= tolerance) === index)
    .slice(0, 5);

  const sweptHigh = buySideLevels
    .filter(item => last.high > item.level + buffer && last.close < item.level)
    .sort((a, b) => b.level - a.level)[0] || null;
  const sweptLow = sellSideLevels
    .filter(item => last.low < item.level - buffer && last.close > item.level)
    .sort((a, b) => a.level - b.level)[0] || null;

  const sweep = sweptHigh ? "BALAYAGE LIQUIDITE HAUSSIERE REJETE" :
    sweptLow ? "BALAYAGE LIQUIDITE BAISSIERE REJETE" : "AUCUN";
  const sweepLevel = sweptHigh?.level ?? sweptLow?.level ?? null;
  const sweepDirection = sweptLow ? "HAUSSIER" : sweptHigh ? "BAISSIER" : null;
  const sweepWick = sweptLow ? lowerWick : sweptHigh ? upperWick : 0;
  const sweepDepth = sweptLow ? sweepLevel - last.low
    : sweptHigh ? last.high - sweepLevel : null;
  const sweepDepthAtr = Number.isFinite(sweepDepth) ? sweepDepth / indicator.atr : null;
  const sweepWickBodyRatio = sweep !== "AUCUN"
    ? sweepWick / Math.max(Math.abs(last.close - last.open), indicator.atr * 0.01)
    : null;
  const sweepClosePosition = (last.close - last.low) / Math.max(last.high - last.low, 1e-9);
  const rejectionAligned = sweptLow ? sweepClosePosition >= 0.65
    : sweptHigh ? sweepClosePosition <= 0.35 : false;
  const sweepQuality = sweep === "AUCUN" ? "NON_EVALUE"
    : sweepDepthAtr >= 0.08 && sweepWickBodyRatio >= 1.5 && rejectionAligned
      ? "FORTE"
      : sweepDepthAtr >= 0.03 && sweepWickBodyRatio >= 1 && (sweptLow
        ? sweepClosePosition >= 0.55 : sweepClosePosition <= 0.45)
        ? "MODEREE" : "FAIBLE";
  const status = sweep !== "AUCUN" ? "BALAYAGE DETECTE" :
    equalHighs.length || equalLows.length ? "ZONES EGALES DETECTEES" : "PIVOTS CONFIRMES";

  return {
    status, buySideLevels, sellSideLevels, equalHighs, equalLows,
    sweep, sweepLevel, sweepDirection, sweepQuality,
    sweepDepthAtr: sweepDepthAtr === null ? null : Number(sweepDepthAtr.toFixed(2)),
    sweepWickBodyRatio: sweepWickBodyRatio === null ? null : Number(sweepWickBodyRatio.toFixed(2)),
    sweepClosePosition: Number(sweepClosePosition.toFixed(2)),
    tolerance: Number(tolerance.toFixed(3)),
    explanation: sweptHigh
      ? "La dernière bougie a dépassé un sommet suivi puis clôturé dessous : balayage potentiel de liquidité acheteuse, à confirmer par la réaction suivante."
      : sweptLow
        ? "La dernière bougie a percé un creux suivi puis clôturé au-dessus : balayage potentiel de liquidité vendeuse, à confirmer par la réaction suivante."
        : equalHighs.length || equalLows.length
          ? "Des sommets ou creux proches et répétés forment des zones candidates de liquidité. Ce sont des estimations OHLC, pas des ordres stop observés."
          : "Pivots récents identifiés. Aucun balayage confirmé sur la dernière bougie clôturée."
  };
}

function analyzeSmartMoney(bars, structure, indicator) {
  if (!Array.isArray(bars) || bars.length < 20 || !Number.isFinite(indicator.atr)) {
    return {
      status: "INDETERMINE", fairValueGaps: [], orderBlock: null,
      explanation: "Historique insuffisant pour détecter les déséquilibres et blocs d'ordres."
    };
  }

  const lastIndex = bars.length - 1;
  const last = bars[lastIndex];
  const lookbackStart = Math.max(2, bars.length - 60);
  const gaps = [];

  // FVG classique à trois bougies : déséquilibre entre la bougie 1 et la bougie 3.
  for (let i = lookbackStart; i <= lastIndex; i++) {
    const first = bars[i - 2], third = bars[i];
    let direction = null, lower = null, upper = null;
    if (third.low > first.high) {
      direction = "HAUSSIER"; lower = first.high; upper = third.low;
    } else if (third.high < first.low) {
      direction = "BAISSIER"; lower = third.high; upper = first.low;
    }
    if (!direction) continue;

    const later = bars.slice(i + 1);
    const mitigated = later.some(bar =>
      direction === "HAUSSIER" ? bar.low <= lower : bar.high >= upper
    );
    gaps.push({
      direction,
      lower: Number(lower.toFixed(2)),
      upper: Number(upper.toFixed(2)),
      formedAt: new Date(third.time).toISOString(),
      ageCandles: lastIndex - i,
      mitigated,
      state: mitigated ? "VISITE / PARTIELLEMENT OU TOTALEMENT MITIGE" : "NON MITIGE"
    });
  }

  const recentGaps = gaps.filter(g => !g.mitigated).slice(-5).reverse();
  const event = structure?.breakEvent || "AUCUN";
  let orderBlock = null;
  if (event === "BOS_HAUSSIER" || event === "CHOCH_HAUSSIER" ||
      event === "BOS_BAISSIER" || event === "CHOCH_BAISSIER") {
    const bullishBreak = event.endsWith("HAUSSIER");
    const start = Math.max(0, lastIndex - 12);
    for (let i = lastIndex - 1; i >= start; i--) {
      const candle = bars[i];
      const opposing = bullishBreak ? candle.close < candle.open : candle.close > candle.open;
      if (!opposing) continue;
      const lower = Math.min(candle.open, candle.close);
      const upper = Math.max(candle.open, candle.close);
      const subsequentlyTouched = bars.slice(i + 1).some(bar =>
        bar.low <= upper && bar.high >= lower
      );
      orderBlock = {
        direction: bullishBreak ? "HAUSSIER" : "BAISSIER",
        lower: Number(lower.toFixed(2)),
        upper: Number(upper.toFixed(2)),
        formedAt: new Date(candle.time).toISOString(),
        state: subsequentlyTouched ? "ZONE DEJA RETESTEE" : "ZONE NON RETESTEE",
        basis: event
      };
      break;
    }
  }

  const activeBullish = recentGaps.filter(g => g.direction === "HAUSSIER").length;
  const activeBearish = recentGaps.filter(g => g.direction === "BAISSIER").length;
  const status = orderBlock ? "RUPTURE STRUCTURELLE — BLOC REPERE" :
    recentGaps.length ? "DESEQUILIBRES DETECTES" : "AUCUNE ZONE ACTIVE";
  return {
    status,
    fairValueGaps: recentGaps,
    orderBlock,
    activeBullishFvg: activeBullish,
    activeBearishFvg: activeBearish,
    explanation: orderBlock
      ? "Un bloc candidat a été repéré avant le dernier BOS/CHOCH. Il doit être confirmé par le contexte, la réaction du prix et la confluence."
      : recentGaps.length
        ? "Des déséquilibres à trois bougies restent non mitigés. Ils constituent des zones candidates, pas des ordres institutionnels observés."
        : "Aucun FVG non mitigé récent détecté. L'absence de zone ne préjuge pas de la direction future."
  };
}

function analyzeReversalSignals(bars, structure, indicator, liquidity, regime) {
  const unavailable = {
    status: "DONNEES_INSUFFISANTES", stage: "NON_EVALUE",
    direction: "INDETERMINE", bullishScore: 0, bearishScore: 0,
    bullishEvidence: [], bearishEvidence: [],
    candleConfirmation: false, structureConfirmation: false,
    momentumConfirmation: false, trendExhaustion: false,
    explanation: "Historique insuffisant pour évaluer un retournement.",
    note: "Score heuristique d'indices, jamais une probabilité ni un signal d'ordre."
  };
  if (!Array.isArray(bars) || bars.length < 35 ||
      !Number.isFinite(indicator.atr) || indicator.atr <= 0) return unavailable;

  const last = bars[bars.length - 1], previous = bars[bars.length - 2];
  const candleRange = Math.max(last.high - last.low, 1e-9);
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const closes = bars.map(b => b.close);
  const priorMacd = calculateMACD(closes.slice(0, -1));
  const priorPriorMacd = calculateMACD(closes.slice(0, -2));
  const currentMacd = indicator.macd || calculateMACD(closes);
  const priorAdx = calculateADX(bars.slice(0, -1), 14);
  const priorPriorAdx = calculateADX(bars.slice(0, -2), 14);
  const bullishEvidence = [], bearishEvidence = [];
  let bullishScore = 0, bearishScore = 0;
  const addBull = (points, label) => { bullishScore += points; bullishEvidence.push(label); };
  const addBear = (points, label) => { bearishScore += points; bearishEvidence.push(label); };

  // Chandeliers : les motifs ne comptent que sur la dernière bougie clôturée.
  const bullishEngulfing = last.close > last.open && previous.close < previous.open &&
    last.open <= previous.close && last.close >= previous.open;
  const bearishEngulfing = last.close < last.open && previous.close > previous.open &&
    last.open >= previous.close && last.close <= previous.open;
  const bullishReject = lowerWick >= Math.max(body * 1.8, indicator.atr * 0.18) &&
    last.close >= last.low + candleRange * 0.70;
  const bearishReject = upperWick >= Math.max(body * 1.8, indicator.atr * 0.18) &&
    last.close <= last.low + candleRange * 0.30;
  if (bullishEngulfing) addBull(3, "Englobante haussière clôturée");
  if (bearishEngulfing) addBear(3, "Englobante baissière clôturée");
  if (bullishReject) addBull(2, "Rejet net de la mèche basse");
  if (bearishReject) addBear(2, "Rejet net de la mèche haute");

  const st = structure || {};
  if (st.bullishDivergence) addBull(2, "Divergence RSI haussière récente");
  if (st.bullishMacdDivergence) addBull(2, "Divergence MACD haussière récente");
  if (st.bearishDivergence) addBear(2, "Divergence RSI baissière récente");
  if (st.bearishMacdDivergence) addBear(2, "Divergence MACD baissière récente");

  const bullishChoch = st.breakEvent === "CHOCH_HAUSSIER";
  const bearishChoch = st.breakEvent === "CHOCH_BAISSIER";
  const bullishBos = st.breakEvent === "BOS_HAUSSIER";
  const bearishBos = st.breakEvent === "BOS_BAISSIER";
  const breakCandleRange = Math.max(last.high - last.low, 1e-9);
  const candleBodyRatio = Math.abs(last.close - last.open) / breakCandleRange;
  const closePosition = (last.close - last.low) / breakCandleRange;
  const breakDistance = bullishChoch || bullishBos
    ? last.close - st.breakLevel
    : bearishChoch || bearishBos ? st.breakLevel - last.close : null;
  const breakDistanceAtr = Number.isFinite(breakDistance) && Number.isFinite(indicator.atr)
    ? breakDistance / indicator.atr : null;
  const breakCandleAligned = bullishChoch || bullishBos
    ? last.close > last.open && closePosition >= 0.60
    : bearishChoch || bearishBos
      ? last.close < last.open && closePosition <= 0.40 : false;
  let breakQuality = breakDistanceAtr === null ? "NON_EVALUE"
    : breakDistanceAtr >= 0.20 && candleBodyRatio >= 0.45 &&
      (bullishChoch || bullishBos ? closePosition >= 0.75 : closePosition <= 0.25)
      ? "FORTE"
      : breakDistanceAtr >= 0.08 && candleBodyRatio >= 0.25 && breakCandleAligned
        ? "MODEREE" : "FAIBLE";
  const adxValue = indicator.adx?.adx;
  const plusDI = indicator.adx?.plusDI;
  const minusDI = indicator.adx?.minusDI;
  const directionalConflict = Number.isFinite(adxValue) && adxValue >= 25 &&
    ((bullishChoch || bullishBos) && Number.isFinite(minusDI) && Number.isFinite(plusDI) && minusDI > plusDI ||
     (bearishChoch || bearishBos) && Number.isFinite(plusDI) && Number.isFinite(minusDI) && plusDI > minusDI);
  if (directionalConflict && breakQuality === "FORTE") breakQuality = "MODEREE";
  else if (directionalConflict && breakQuality === "MODEREE") breakQuality = "FAIBLE";
  const structureBreakConfirmed = (breakQuality === "FORTE" || breakQuality === "MODEREE") && !directionalConflict;
  if (bullishChoch) addBull(breakQuality === "FORTE" ? 5 : breakQuality === "MODEREE" ? 3 : 1,
    "CHOCH haussier " + breakQuality.toLowerCase() + " : clôture au-dessus du pivot confirmé" +
    (directionalConflict ? " ; DI baissier dominant avec ADX élevé, confirmation rejetée" : ""));
  else if (bullishBos) addBull(1, "BOS haussier : continuation, pas preuve isolée de retournement");
  if (bearishChoch) addBear(breakQuality === "FORTE" ? 5 : breakQuality === "MODEREE" ? 3 : 1,
    "CHOCH baissier " + breakQuality.toLowerCase() + " : clôture sous le pivot confirmé" +
    (directionalConflict ? " ; DI haussier dominant avec ADX élevé, confirmation rejetée" : ""));
  else if (bearishBos) addBear(1, "BOS baissier : continuation, pas preuve isolée de retournement");

  const sweepPoints = liquidity?.sweepQuality === "FORTE" ? 3
    : liquidity?.sweepQuality === "MODEREE" ? 1 : 0;
  if (liquidity?.sweep === "BALAYAGE LIQUIDITE BAISSIERE REJETE" && sweepPoints) {
    addBull(sweepPoints, "Balayage des creux puis réintégration · qualité " + liquidity.sweepQuality.toLowerCase());
  }
  if (liquidity?.sweep === "BALAYAGE LIQUIDITE HAUSSIERE REJETE" && sweepPoints) {
    addBear(sweepPoints, "Balayage des sommets puis réintégration · qualité " + liquidity.sweepQuality.toLowerCase());
  }
  if (regime?.fakeoutDown) addBull(2, "Fausse cassure baissière détectée");
  if (regime?.fakeoutUp) addBear(2, "Fausse cassure haussière détectée");

  const ema9 = indicator.ema9, ema21 = indicator.ema21, ema50 = indicator.ema50;
  const bullishEmaCross = Number.isFinite(ema9) && Number.isFinite(ema21) &&
    ema9 > ema21 && previous.close <= ema21 && last.close > ema21;
  const bearishEmaCross = Number.isFinite(ema9) && Number.isFinite(ema21) &&
    ema9 < ema21 && previous.close >= ema21 && last.close < ema21;
  if (bullishEmaCross) addBull(2, "Clôture repassée au-dessus de l'EMA21 avec EMA9 ascendante");
  if (bearishEmaCross) addBear(2, "Clôture repassée sous l'EMA21 avec EMA9 descendante");

  const macdSlowing = Number.isFinite(currentMacd.histogram) &&
    Number.isFinite(priorMacd.histogram) &&
    Math.abs(currentMacd.histogram) < Math.abs(priorMacd.histogram);
  const macdDecelerationConfirmed = macdSlowing &&
    Number.isFinite(priorPriorMacd.histogram) &&
    Math.abs(priorMacd.histogram) < Math.abs(priorPriorMacd.histogram);
  const bullishMomentum = Number.isFinite(indicator.rsi) && indicator.rsi > 50 &&
    Number.isFinite(currentMacd.histogram) && currentMacd.histogram > 0;
  const bearishMomentum = Number.isFinite(indicator.rsi) && indicator.rsi < 50 &&
    Number.isFinite(currentMacd.histogram) && currentMacd.histogram < 0;
  if (bullishMomentum) addBull(1, "Momentum RSI/MACD repassé positif");
  if (bearishMomentum) addBear(1, "Momentum RSI/MACD repassé négatif");

  const trend = Number.isFinite(ema9) && Number.isFinite(ema21) && Number.isFinite(ema50)
    ? ema9 > ema21 && ema21 > ema50 ? "HAUSSIER"
      : ema9 < ema21 && ema21 < ema50 ? "BAISSIER" : "NEUTRE"
    : "NEUTRE";
  const adxFalling = Number.isFinite(indicator.adx?.adx) &&
    Number.isFinite(priorAdx.adx) && indicator.adx.adx < priorAdx.adx;
  const adxFallingConfirmed = adxFalling &&
    Number.isFinite(priorPriorAdx.adx) && priorAdx.adx < priorPriorAdx.adx;
  const trendExhaustion = adxFallingConfirmed || macdDecelerationConfirmed ||
    (Number.isFinite(indicator.rsi) && ((trend === "HAUSSIER" && indicator.rsi < 50) ||
      (trend === "BAISSIER" && indicator.rsi > 50)));
  if (trendExhaustion) {
    if (trend === "HAUSSIER") addBear(1, "Essoufflement confirmé sur plusieurs clôtures ou RSI sous 50");
    if (trend === "BAISSIER") addBull(1, "Essoufflement confirmé sur plusieurs clôtures ou RSI au-dessus de 50");
  }

  const direction = bullishScore === bearishScore ? "MIXTE" :
    bullishScore > bearishScore ? "HAUSSIER" : "BAISSIER";
  const dominant = Math.max(bullishScore, bearishScore);
  const opposing = Math.min(bullishScore, bearishScore);
  const candleConfirmation = direction === "HAUSSIER"
    ? bullishEngulfing || bullishReject : direction === "BAISSIER"
      ? bearishEngulfing || bearishReject : false;
  const structureConfirmation = direction === "HAUSSIER"
    ? bullishChoch && structureBreakConfirmed
    : direction === "BAISSIER" ? bearishChoch && structureBreakConfirmed : false;
  const momentumConfirmation = direction === "HAUSSIER" ? bullishMomentum && bullishEmaCross :
    direction === "BAISSIER" ? bearishMomentum && bearishEmaCross : false;
  const oppositeTrend = direction !== "MIXTE" && trend !== "NEUTRE" && trend !== direction;
  // Confluence explicite : balayage aligné, CHOCH confirmé et retest défendu.
  // Ces éléments restent des diagnostics OHLC, pas une preuve d'ordres institutionnels.
  const alignedSweep = direction === "HAUSSIER"
    ? liquidity?.sweep === "BALAYAGE LIQUIDITE BAISSIERE REJETE" &&
      ["FORTE", "MODEREE"].includes(liquidity?.sweepQuality)
    : direction === "BAISSIER"
      ? liquidity?.sweep === "BALAYAGE LIQUIDITE HAUSSIERE REJETE" &&
        ["FORTE", "MODEREE"].includes(liquidity?.sweepQuality)
      : false;
  const alignedRetest = direction === "HAUSSIER" ? regime?.retestUp === true
    : direction === "BAISSIER" ? regime?.retestDown === true : false;
  const alignedRangeReentry = direction !== "MIXTE" &&
    regime?.rangeReentryDirection === direction &&
    ["FORTE", "MODEREE"].includes(regime?.rangeReentryQuality);
  const reversalConfluenceCount = [alignedSweep, structureConfirmation, alignedRetest, alignedRangeReentry]
    .filter(Boolean).length;
  const reversalConfluenceStatus = reversalConfluenceCount >= 3 ? "TRIPLE_CONFLUENCE"
    : alignedRangeReentry && (structureConfirmation || alignedSweep || alignedRetest) ? "RANGE_REENTRY_ET_CONFIRMATION"
      : structureConfirmation && (alignedSweep || alignedRetest) ? "CHOCH_ET_CONFIRMATION"
        : alignedSweep && alignedRetest ? "BALAYAGE_ET_RETEST"
          : alignedRangeReentry ? "REINTEGRATION_RANGE"
            : structureConfirmation ? "CHOCH_SEUL"
              : alignedSweep ? "BALAYAGE_SEUL"
                : alignedRetest ? "RETEST_SEUL" : "AUCUNE_CONFLUENCE";
  let stage = "AUCUN_RETOURNEMENT";
  let status = "PAS_DE_RETOURNEMENT";
  if (direction === "MIXTE" || dominant - opposing < 2) {
    stage = "SIGNAUX_CONTRADICTOIRES"; status = "SIGNAUX_MIXTES";
  } else if (structureConfirmation && candleConfirmation && momentumConfirmation) {
    stage = "RETOURNEMENT_CONFIRME"; status = "RETOURNEMENT_STRUCTUREL_ET_MOMENTUM";
  } else if (structureConfirmation && (candleConfirmation || momentumConfirmation)) {
    stage = "RETOURNEMENT_EN_FORMATION"; status = "CHOCH_AVEC_CONFIRMATION_PARTIELLE";
  } else if (candleConfirmation && dominant >= 4) {
    stage = "REJET_A_SURVEILLER"; status = "REJET_CANDLE_A_SURVEILLER";
  } else if (dominant >= 4 || (trendExhaustion && dominant >= 2)) {
    stage = "PRECURSEUR"; status = "INDICES_PRECURSEURS";
  }
  const explanation = stage === "RETOURNEMENT_CONFIRME"
    ? "CHOCH, réaction de bougie et reprise du momentum sont alignés. Le changement de structure est détecté sur cette unité ; vérifier les unités supérieures avant toute décision."
    : stage === "RETOURNEMENT_EN_FORMATION"
      ? "Un CHOCH est détecté et au moins une confirmation supplémentaire apparaît. Le momentum ou le rejet reste incomplet."
      : stage === "REJET_A_SURVEILLER"
        ? "Une bougie de rejet est visible, mais sans CHOCH confirmé : cela peut rester un simple rebond."
        : stage === "PRECURSEUR"
          ? "Des signes d'essoufflement ou de divergence apparaissent. La tendance n'est pas encore retournée."
          : stage === "SIGNAUX_CONTRADICTOIRES"
            ? "Les éléments haussiers et baissiers se contredisent : aucun sens de retournement ne domine."
            : "Aucun faisceau suffisant d'indices de retournement n'est identifié sur la dernière bougie clôturée.";
  const reversalActive = ["PRECURSEUR", "REJET_A_SURVEILLER",
    "RETOURNEMENT_EN_FORMATION", "RETOURNEMENT_CONFIRME"].includes(stage);
  const invalidationLevel = reversalActive && direction === "HAUSSIER"
    ? (Number.isFinite(st.lastSwingLow) ? st.lastSwingLow : null)
    : reversalActive && direction === "BAISSIER"
      ? (Number.isFinite(st.lastSwingHigh) ? st.lastSwingHigh : null)
      : null;
  const invalidationDistance = invalidationLevel !== null
    ? Math.abs(last.close - invalidationLevel) : null;
  const invalidationDistanceAtr = invalidationDistance !== null
    ? invalidationDistance / indicator.atr : null;
  const invalidationBreached = invalidationLevel !== null &&
    (direction === "HAUSSIER" ? last.close < invalidationLevel : last.close > invalidationLevel);
  const invalidationLabel = !reversalActive
    ? "Aucun scénario actif à invalider"
    : direction === "HAUSSIER"
      ? "Invalidation si clôture sous le dernier creux confirmé"
      : direction === "BAISSIER"
        ? "Invalidation si clôture au-dessus du dernier sommet confirmé"
        : "Aucun niveau : scénario contradictoire";
  return {
    status, stage, direction,
    bullishScore, bearishScore,
    bullishEvidence, bearishEvidence,
    candleConfirmation, structureConfirmation, structureBreakConfirmed,
    breakQuality, breakDistanceAtr: breakDistanceAtr === null ? null : Number(breakDistanceAtr.toFixed(2)),
    breakCandleAligned, directionalConflict, momentumConfirmation,
    alignedSweep, alignedRetest, alignedRangeReentry,
    rangeReentryDirection: regime?.rangeReentryDirection || "NEUTRE",
    rangeReentryQuality: regime?.rangeReentryQuality || "NON_EVALUE",
    rangeReentryDepthAtr: regime?.rangeReentryDepthAtr ?? null,
    reversalConfluenceCount, reversalConfluenceStatus,
    trendExhaustion, trendContext: trend, againstTrend: oppositeTrend,
    emaCrossConfirmation: bullishEmaCross || bearishEmaCross,
    macdSlowing, macdDecelerationConfirmed, adxFalling, adxFallingConfirmed,
    invalidationLevel,
    invalidationLabel,
    invalidationDistance: invalidationDistance === null ? null : Number(invalidationDistance.toFixed(3)),
    invalidationDistanceAtr: invalidationDistanceAtr === null ? null : Number(invalidationDistanceAtr.toFixed(2)),
    invalidationBreached,
    invalidationBasis: !reversalActive
      ? "Aucun retournement actif : aucun niveau d'invalidation n'est présenté."
      : invalidationLevel === null
        ? "Aucun pivot structurel confirmé disponible."
        : "Distance calculée depuis la dernière clôture ; le niveau est invalidé uniquement par une clôture au-delà du pivot, pas par une simple mèche.",
    explanation,
    note: "Score heuristique d'indices, pas une probabilité de réussite. Le niveau d'invalidation est un repère structurel, pas un stop-loss calculé ni un ordre. Confirmation locale à cette unité de temps, non garantie multi-timeframe."
  };
}
function buildDashboardFrame(timeframe, bars) {
  const indicator = getIndicators(bars);
  const trend = indicator.ema200 !== null && indicator.ema20 !== null && indicator.ema50 !== null
    ? (indicator.ema20 > indicator.ema50 && indicator.ema50 > indicator.ema200 ? "HAUSSIER" :
       indicator.ema20 < indicator.ema50 && indicator.ema50 < indicator.ema200 ? "BAISSIER" : "NEUTRE")
    : "NEUTRE";
  const regime = analyzeMarketRegime(bars, indicator);
  const structure = analyzeStructure(bars, indicator);
  const volatility = analyzeVolatility(bars, indicator);
  const liquidity = analyzeLiquidity(bars, indicator);
  const smartMoney = analyzeSmartMoney(bars, structure, indicator);
  const reversalSignals = analyzeReversalSignals(bars, structure, indicator, liquidity, regime);
  const quality = inspectDataQuality(bars, timeframe);
  const macd = indicator.macd || {};
  const bb = indicator.bollinger || {};
  const adx = indicator.adx || {};
  const last = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const slowing = Boolean(
    Number.isFinite(macd.histogram) &&
    Number.isFinite(macd.previousHistogram) &&
    Math.abs(macd.histogram) < Math.abs(macd.previousHistogram)
  );
  const reversalWarnings = [];
  if (structure.bullishDivergence) reversalWarnings.push("Divergence RSI haussiere : le prix marque un plus bas alors que le RSI remonte.");
  if (structure.bearishDivergence) reversalWarnings.push("Divergence RSI baissiere : le prix marque un plus haut alors que le RSI faiblit.");
  if (structure.bullishMacdDivergence) reversalWarnings.push("Divergence MACD haussiere : le prix marque un plus bas tandis que le MACD remonte.");
  if (structure.bearishMacdDivergence) reversalWarnings.push("Divergence MACD baissiere : le prix marque un plus haut tandis que le MACD faiblit.");
  if (structure.choch !== "AUCUN") reversalWarnings.push(structure.choch + " : changement potentiel de caractere de la structure.");
  if (regime.fakeoutUp) reversalWarnings.push("FAUSSE CASSURE HAUSSIERE : dépassement de résistance rejeté en clôture.");
  if (regime.fakeoutDown) reversalWarnings.push("FAUSSE CASSURE BAISSIERE : passage sous le support rejeté en clôture.");
  if (regime.retestUp) reversalWarnings.push("RETEST HAUSSIER : ancienne résistance défendue en clôture.");
  if (regime.retestDown) reversalWarnings.push("RETEST BAISSIER : ancien support rejeté en clôture.");
  if (slowing) reversalWarnings.push("Histogramme MACD en ralentissement : impulsion potentiellement moins forte.");
  if (Number.isFinite(indicator.rsi) && indicator.rsi >= 70) reversalWarnings.push("RSI en zone haute");
  if (Number.isFinite(indicator.rsi) && indicator.rsi <= 30) reversalWarnings.push("RSI en zone basse");
  if (volatility.status === "EXTREME") reversalWarnings.push("VOLATILITE EXTREME : risque de mouvement brutal et d'exécution dégradée.");
  if (volatility.status === "CONTRACTION") reversalWarnings.push("CONTRACTION DE VOLATILITE : attendre une cassure confirmée.");
  if (liquidity.sweep !== "AUCUN") reversalWarnings.push(liquidity.sweep + " au niveau " + liquidity.sweepLevel + " : attendre une confirmation de la réaction.");
  return {
    timeframe,
    candleCount: bars.length,
    lastCandleAt: new Date(last.time + TIMEFRAMES[timeframe].ms).toISOString(),
    dataQuality: quality,
    trend: describeTrendStrength(indicator, trend),
    regime,
    volatility,
    liquidity,
    smartMoney,
    reversalSignals,
    indicators: {
      price: indicator.price,
      ema20: indicator.ema20,
      ema50: indicator.ema50,
      ema200: indicator.ema200,
      rsi14: indicator.rsi,
      macd: {
        line: macd.macd, signal: macd.signal,
        histogram: macd.histogram, previousHistogram: macd.previousHistogram
      },
      adx14: adx.adx, plusDI: adx.plusDI, minusDI: adx.minusDI,
      bollinger: bb,
      atr14: indicator.atr,
      stochastic: indicator.stochastic
    },
    structure,
    levels: findSupportResistance(bars, Math.min(80, bars.length)),
    reversalWarnings,
    candles: bars.slice(-90).map(b => ({
      time: b.time, open: b.open, high: b.high, low: b.low, close: b.close
    }))
  };
}

function analyzeReversalMultiTimeframe(results, marketOpen) {
  const order = ["M1", "M5", "M15", "H1", "H4", "D1"];
  const weights = { M1: 1, M5: 1.5, M15: 2, H1: 3, H4: 4, D1: 5 };
  if (marketOpen !== true) return {
    status: marketOpen === false ? "MARCHE_FERME" : "ETAT_NON_CONFIRME",
    validTimeframes: 0, bullishCount: 0, bearishCount: 0,
    higherBullish: 0, higherBearish: 0, details: [],
    explanation: "Lecture multi-timeframe indisponible : cours live non confirmé."
  };
  const byTf = new Map(results.filter(x => x.ok && x.analysis?.dataQuality?.ok)
    .map(x => [x.timeframe, x.analysis]));
  const details = [];
  let bullishWeight = 0, bearishWeight = 0;
  let bullishCount = 0, bearishCount = 0;
  let higherBullish = 0, higherBearish = 0;
  let higherBullishConfirmed = 0, higherBearishConfirmed = 0;
  let confirmedCount = 0, formationCount = 0, earlyCount = 0, invalidatedCount = 0;
  let againstTrendCount = 0, withTrendCount = 0;
  let higherTripleBullish = 0, higherTripleBearish = 0;
  const higherFrames = ["H1", "H4", "D1"];
  const stageWeights = {
    PRECURSEUR: 0.25,
    REJET_A_SURVEILLER: 0.4,
    RETOURNEMENT_EN_FORMATION: 0.7,
    RETOURNEMENT_CONFIRME: 1
  };
  for (const tf of order) {
    const a = byTf.get(tf);
    if (!a) continue;
    const r = a.reversalSignals || {};
    const stage = r.stage || "AUCUN_RETOURNEMENT";
    const direction = ["HAUSSIER", "BAISSIER"].includes(r.direction) ? r.direction : "NEUTRE";
    const invalidated = r.invalidationBreached === true;
    const active = Object.prototype.hasOwnProperty.call(stageWeights, stage) && !invalidated;
    const trend = a.trend?.direction || "NEUTRE";
    const againstTrend = active && trend !== "NEUTRE" && direction !== "NEUTRE" && trend !== direction;
    const withTrend = active && trend !== "NEUTRE" && direction === trend;
    if (invalidated) invalidatedCount++;
    if (againstTrend) againstTrendCount++;
    if (withTrend) withTrendCount++;
    const higher = higherFrames.includes(tf);
    if (higher && active && r.reversalConfluenceStatus === "TRIPLE_CONFLUENCE") {
      if (direction === "HAUSSIER") higherTripleBullish++;
      if (direction === "BAISSIER") higherTripleBearish++;
    }
    const stageWeight = active ? stageWeights[stage] : 0;
    if (active && direction === "HAUSSIER") {
      bullishCount++; bullishWeight += weights[tf] * stageWeight;
      if (higher) {
        higherBullish++;
        if (stage === "RETOURNEMENT_CONFIRME") higherBullishConfirmed++;
      }
    } else if (active && direction === "BAISSIER") {
      bearishCount++; bearishWeight += weights[tf] * stageWeight;
      if (higher) {
        higherBearish++;
        if (stage === "RETOURNEMENT_CONFIRME") higherBearishConfirmed++;
      }
    }
    if (active && stage === "RETOURNEMENT_CONFIRME") confirmedCount++;
    else if (active && stage === "RETOURNEMENT_EN_FORMATION") formationCount++;
    else if (active && (stage === "PRECURSEUR" || stage === "REJET_A_SURVEILLER")) earlyCount++;
    details.push({
      timeframe: tf, stage: invalidated ? "SCENARIO_INVALIDE" : stage, direction, trend, active, invalidated, againstTrend, withTrend, weight: weights[tf],
      stageWeight: active ? stageWeight : 0, weightedContribution: Number((weights[tf] * (active ? stageWeight : 0)).toFixed(2)), breakQuality: r.breakQuality || null, breakDistanceAtr: r.breakDistanceAtr ?? null, structureBreakConfirmed: r.structureBreakConfirmed === true, directionalConflict: r.directionalConflict === true, alignedSweep: r.alignedSweep === true, alignedRetest: r.alignedRetest === true, alignedRangeReentry: r.alignedRangeReentry === true, rangeReentryDirection: r.rangeReentryDirection || "NEUTRE", rangeReentryQuality: r.rangeReentryQuality || "NON_EVALUE", rangeReentryDepthAtr: r.rangeReentryDepthAtr ?? null, reversalConfluenceCount: r.reversalConfluenceCount ?? 0, reversalConfluenceStatus: r.reversalConfluenceStatus || "AUCUNE_CONFLUENCE", invalidationLevel: r.invalidationLevel ?? null, invalidationDistance: r.invalidationDistance ?? null, invalidationDistanceAtr: r.invalidationDistanceAtr ?? null, invalidationBreached: r.invalidationBreached === true, invalidationLabel: r.invalidationLabel || null
    });
  }
  const bias = Math.abs(bullishWeight - bearishWeight) < 0.001
    ? "MIXTE" : bullishWeight > bearishWeight ? "HAUSSIER" : "BAISSIER";
  const opposingHigher = bias === "HAUSSIER" ? higherBearish : bias === "BAISSIER" ? higherBullish : 0;
  const supportingHigher = bias === "HAUSSIER" ? higherBullish : bias === "BAISSIER" ? higherBearish : 0;
  const supportingHigherConfirmed = bias === "HAUSSIER" ? higherBullishConfirmed : bias === "BAISSIER" ? higherBearishConfirmed : 0;
  let status = "AUCUN_SIGNAL";
  if (!details.length) status = "COUVERTURE_INSUFFISANTE";
  else if (bias === "MIXTE" && (bullishCount || bearishCount)) status = "SIGNAUX_CONTRADICTOIRES";
  else if (opposingHigher > supportingHigher) status = "CONFLIT_UNITES_SUPERIEURES";
  else if (supportingHigherConfirmed >= 2) status = "SOUTIEN_UNITES_SUPERIEURES";
  else if (supportingHigherConfirmed === 1 || supportingHigher > 0) status = "SOUTIEN_PARTIEL";
  else if (bullishCount + bearishCount > 0) status = "SIGNAL_LOCAL_SEULEMENT";
  const explanation = status === "SOUTIEN_UNITES_SUPERIEURES"
    ? "Le même sens de retournement apparaît sur au moins deux unités supérieures. Cela renforce la cohérence, sans garantir le mouvement."
    : status === "SOUTIEN_PARTIEL"
      ? "Une unité supérieure présente un indice de même sens. La confirmation multi-timeframe reste partielle."
      : status === "CONFLIT_UNITES_SUPERIEURES"
        ? "Les unités supérieures présentent davantage d'indices de retournement opposés. Risque de faux signal local."
        : status === "SIGNAUX_CONTRADICTOIRES"
          ? "Des indices haussiers et baissiers coexistent sur les unités disponibles."
          : status === "SIGNAL_LOCAL_SEULEMENT"
            ? "Le retournement est détecté sur des unités courtes, sans soutien supérieur suffisant."
            : status === "COUVERTURE_INSUFFISANTE"
              ? "Aucune unité ne dispose de données live validées."
              : "Aucun faisceau de retournement actif détecté sur les unités disponibles.";
  return {
    status, bias, bullishCount, bearishCount, higherBullish, higherBearish,
    higherBullishConfirmed, higherBearishConfirmed,
    confirmedCount, formationCount, earlyCount, invalidatedCount, againstTrendCount, withTrendCount,
    higherTripleBullish, higherTripleBearish,
    validTimeframes: details.length,
    missingTimeframes: order.filter(tf => !byTf.has(tf)),
    bullishWeight: Number(bullishWeight.toFixed(2)),
    bearishWeight: Number(bearishWeight.toFixed(2)),
    details, explanation,
    note: "Les précurseurs pèsent moins que les formations et confirmations. Diagnostics sur bougies clôturées ; aucune confirmation automatique d'ordre."
  };
}

function analyzeMultiTimeframeConfluence(results, marketOpen) {
  const weights = { M1: 1, M5: 1.5, M15: 2, H1: 3, H4: 4, D1: 5 };
  const directions = {};
  const usable = [];
  for (const item of results) {
    if (!item.ok || !item.analysis?.dataQuality?.ok) continue;
    const tf = item.timeframe;
    const direction = item.analysis.trend?.direction || "NEUTRE";
    directions[tf] = direction;
    if (marketOpen === true && weights[tf] && direction !== "NEUTRE") {
      usable.push({ timeframe: tf, direction, weight: weights[tf] });
    }
  }

  if (marketOpen !== true) {
    return {
      status: marketOpen === false ? "MARCHE_FERME" : "ETAT_NON_CONFIRME",
      bias: "INDETERMINE", agreementIndex: null, validTimeframes: usable.length,
      directions, higherTimeframeBias: "INDETERMINE",
      lowerTimeframeConflicts: [],
      explanation: "Confluence live non calculée : le marché n'est pas confirmé ouvert."
    };
  }

  const totals = { HAUSSIER: 0, BAISSIER: 0 };
  let totalWeight = 0;
  for (const item of usable) {
    totals[item.direction] += item.weight;
    totalWeight += item.weight;
  }
  const bias = totals.HAUSSIER === totals.BAISSIER ? "MIXTE" :
    totals.HAUSSIER > totals.BAISSIER ? "HAUSSIER" : "BAISSIER";
  const dominantWeight = Math.max(totals.HAUSSIER, totals.BAISSIER);
  const agreementIndex = totalWeight ? Math.round(dominantWeight / totalWeight * 100) : null;

  const higher = usable.filter(x => ["H1", "H4", "D1"].includes(x.timeframe));
  const higherTotals = { HAUSSIER: 0, BAISSIER: 0 };
  higher.forEach(x => { higherTotals[x.direction] += x.weight; });
  const higherBias = higherTotals.HAUSSIER === higherTotals.BAISSIER ? "MIXTE" :
    higherTotals.HAUSSIER > higherTotals.BAISSIER ? "HAUSSIER" : "BAISSIER";
  const lowerConflicts = usable
    .filter(x => ["M1", "M5", "M15"].includes(x.timeframe) &&
      higherBias !== "MIXTE" && x.direction !== higherBias)
    .map(x => x.timeframe);

  const higherCoverage = higher.length;
  let status = "MIXTE";
  if (usable.length < 3 || higherCoverage < 2) status = "COUVERTURE_INSUFFISANTE";
  else if (agreementIndex >= 80 && higherBias === bias && lowerConflicts.length === 0) status = "FORTE_CONFLUENCE";
  else if (agreementIndex >= 65 && higherBias === bias) status = "CONFLUENCE_PARTIELLE";
  else if (lowerConflicts.length > 0) status = "CONFLIT_COURT_TERME";
  else status = "DIRECTIONS_DISPERSEES";

  const explanation = status === "FORTE_CONFLUENCE"
    ? "Les unités disponibles convergent et les unités supérieures confirment le biais dominant."
    : status === "CONFLUENCE_PARTIELLE"
      ? "Le biais dominant est soutenu par les unités supérieures, mais l'alignement n'est pas complet."
      : status === "CONFLIT_COURT_TERME"
        ? "Une ou plusieurs unités courtes s'opposent à la tendance des unités supérieures : risque de mouvement à contre-tendance."
        : status === "COUVERTURE_INSUFFISANTE"
          ? "Pas assez d'unités de temps fraîches, notamment parmi H1, H4 et D1, pour conclure."
          : "Les directions sont dispersées : le marché manque d'alignement multi-timeframe.";

  return {
    status, bias, agreementIndex, validTimeframes: usable.length,
    directions, higherTimeframeBias: higherBias,
    lowerTimeframeConflicts: lowerConflicts,
    higherTimeframeCoverage: higherCoverage,
    weightedBullish: Number(totals.HAUSSIER.toFixed(1)),
    weightedBearish: Number(totals.BAISSIER.toFixed(1)),
    explanation,
    note: "Indice de concordance pondéré, pas une probabilité de réussite ni un signal d'entrée."
  };
}

function analyzeSetupConfluence(results, marketOpen) {
  if (marketOpen !== true) {
    return {
      status: marketOpen === false ? "MARCHE_FERME" : "ETAT_NON_CONFIRME",
      bullish: null, bearish: null,
      explanation: "Aucune confluence exploitable en direct : marché ouvert et cours frais non confirmés."
    };
  }

  const byTf = Object.fromEntries(results.filter(x => x.ok && x.analysis?.dataQuality?.ok)
    .map(x => [x.timeframe, x.analysis]));
  const execution = byTf.M15 || byTf.M5 || byTf.M1;
  const higher = ["H1", "H4", "D1"].map(tf => byTf[tf]).filter(Boolean);
  if (!execution || higher.length < 1) {
    return {
      status: "COUVERTURE_INSUFFISANTE", bullish: null, bearish: null,
      explanation: "Données fraîches insuffisantes pour croiser l'unité d'exécution et le contexte supérieur."
    };
  }

  const evaluate = direction => {
    const opposite = direction === "HAUSSIER" ? "BAISSIER" : "HAUSSIER";
    let score = 0;
    const factors = [];
    const add = (points, label) => { score += points; factors.push({ points, label }); };

    const higherAligned = higher.filter(a => a.trend?.direction === direction).length;
    const higherOpposed = higher.filter(a => a.trend?.direction === opposite).length;
    if (higherAligned) add(Math.min(24, higherAligned * 8), higherAligned + " unité(s) supérieure(s) alignée(s)");
    if (higherOpposed) add(-Math.min(24, higherOpposed * 8), higherOpposed + " unité(s) supérieure(s) opposée(s)");

    const trend = execution.trend?.direction;
    if (trend === direction) add(12, "Tendance de l'unité d'exécution alignée");
    else if (trend === opposite) add(-12, "Tendance de l'unité d'exécution opposée");

    const st = execution.structure || {};
    const expectedBreak = direction === "HAUSSIER" ? "BOS_HAUSSIER" : "BOS_BAISSIER";
    const expectedChoch = direction === "HAUSSIER" ? "CHOCH_HAUSSIER" : "CHOCH_BAISSIER";
    const opposingBreak = direction === "HAUSSIER" ? "BOS_BAISSIER" : "BOS_HAUSSIER";
    if (st.breakEvent === expectedBreak) add(18, "BOS " + direction.toLowerCase() + " confirmé");
    else if (st.breakEvent === expectedChoch) add(14, "CHOCH " + direction.toLowerCase() + " détecté");
    else if (st.breakEvent === opposingBreak) add(-18, "BOS opposé détecté");

    const sm = execution.smartMoney || {};
    const matchingOb = sm.orderBlock?.direction === direction;
    if (matchingOb) add(10, "Order Block candidat " + direction.toLowerCase());
    const matchingFvg = (sm.fairValueGaps || []).some(g => g.direction === direction && !g.mitigated);
    if (matchingFvg) add(8, "FVG non mitigé " + direction.toLowerCase());

    const liquidity = execution.liquidity || {};
    const expectedSweep = direction === "HAUSSIER"
      ? "BALAYAGE LIQUIDITE BAISSIERE REJETE"
      : "BALAYAGE LIQUIDITE HAUSSIERE REJETE";
    if (liquidity.sweep === expectedSweep) add(16, "Balayage de liquidité rejeté dans le sens " + direction.toLowerCase());
    else if (liquidity.sweep !== "AUCUN") add(-8, "Balayage détecté dans le sens opposé");

    const regime = execution.regime || {};
    if ((direction === "HAUSSIER" && (regime.retestUp || regime.breakoutUp)) ||
        (direction === "BAISSIER" && (regime.retestDown || regime.breakoutDown))) {
      add(12, "Cassure confirmée ou retest cohérent avec le scénario");
    } else if ((direction === "HAUSSIER" && regime.breakoutCandidateUp) ||
               (direction === "BAISSIER" && regime.breakoutCandidateDown)) {
      add(2, "Cassure en attente : suivi insuffisant pour confirmation");
    } else if ((direction === "HAUSSIER" && regime.fakeoutDown) ||
               (direction === "BAISSIER" && regime.fakeoutUp)) {
      add(8, "Fausse cassure opposée : rejet compatible avec le scénario");
    } else if ((direction === "HAUSSIER" && regime.fakeoutUp) ||
               (direction === "BAISSIER" && regime.fakeoutDown)) {
      add(-12, "Fausse cassure contre le scénario");
    }

    const reversal = execution.reversalSignals || {};
    const reversalEvidence = direction === "HAUSSIER"
      ? (reversal.bullishEvidence || []) : (reversal.bearishEvidence || []);
    const oppositeReversalEvidence = direction === "HAUSSIER"
      ? (reversal.bearishEvidence || []) : (reversal.bullishEvidence || []);
    if (reversal.direction === direction && reversalEvidence.length >= 2) {
      add(10, "Plusieurs indices de retournement " + direction.toLowerCase() + " convergents");
    } else if (reversalEvidence.length === 1) {
      add(3, "Un indice de retournement " + direction.toLowerCase() + " à surveiller");
    }
    if (oppositeReversalEvidence.length >= 2) {
      add(-10, "Indices de retournement opposés au scénario");
    }

    const vol = execution.volatility || {};
    if (vol.status === "EXTREME") add(-15, "Volatilité extrême : pénalité de risque");
    else if (vol.status === "CONTRACTION") add(-5, "Volatilité contractée : attendre une expansion");
    else if (vol.status === "ACCELERATION") add(3, "Volatilité en accélération : confirmation nécessaire");

    return {
      score: Math.max(0, Math.min(100, 50 + score)),
      factors: factors.sort((a,b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, 6),
      higherAligned, higherOpposed,
      orderBlock: matchingOb, fairValueGap: matchingFvg,
      liquiditySweep: liquidity.sweep === expectedSweep
    };
  };

  const bullish = evaluate("HAUSSIER");
  const bearish = evaluate("BAISSIER");
  const difference = Math.abs(bullish.score - bearish.score);
  const leading = bullish.score > bearish.score ? "HAUSSIER" :
    bearish.score > bullish.score ? "BAISSIER" : "NEUTRE";
  const status = difference < 8 ? "CONFIGURATION_NON_CONCLUANTE" :
    Math.max(bullish.score, bearish.score) >= 75 ? "CONFLUENCE_FORTE_A_VALIDER" :
    Math.max(bullish.score, bearish.score) >= 62 ? "CONFLUENCE_PARTIELLE" :
    "CONFLUENCE_FAIBLE";
  return {
    status, leading, bullish, bearish,
    executionTimeframe: byTf.M15 ? "M15" : byTf.M5 ? "M5" : "M1",
    higherTimeframesUsed: higher.length,
    explanation: status === "CONFLUENCE_FORTE_A_VALIDER"
      ? "Plusieurs éléments techniques convergent. Vérifier le prix live, le spread, le calendrier et la clôture avant toute décision manuelle."
      : status === "CONFLUENCE_PARTIELLE"
        ? "Certains éléments convergent, mais la configuration reste incomplète."
        : status === "CONFLUENCE_FAIBLE"
          ? "Les confirmations sont insuffisantes ou contradictoires : attendre."
          : "Les deux scénarios sont trop proches pour privilégier une direction.",
    note: "Score de confluence heuristique, non calibré statistiquement et jamais assimilable à une probabilité de gain ou à un ordre."
  };
}

// GOLD MACRO CROSS-ASSET: DXY live + Treasury 10Y daily.
async function fetchMacroJson(url) {
  const r = await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
  if(!r.ok) throw new Error("HTTP "+r.status);
  return r.json();
}
function macroRows(p) {
  if(Array.isArray(p)) return p;
  for(const k of ["items","symbols","results","data"]) if(Array.isArray(p?.[k])) return p[k];
  return [];
}
async function findDxySymbol() {
  const u=new URL("https://biquote.io/api/symbols/search");u.searchParams.set("q","US Dollar Index");u.searchParams.set("limit","20");
  const rows=macroRows(await fetchMacroJson(u.toString()));
  const found=rows.map(x=>({name:String(x.name||x.symbol||""),description:String(x.description||""),type:String(x.type||"")}))
    .filter(x=>x.name&&/(?:^DXY$|US Dollar Index|Dollar Index)/i.test(x.name+" "+x.description));
  found.sort((a,b)=>Number(/^DXY$/i.test(b.name))-Number(/^DXY$/i.test(a.name)));
  return found[0]||null;
}
function xmlField(entry,field) {
  const re=new RegExp("<(?:[A-Za-z0-9_]+:)?" + field + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?" + field + ">","i");
  const m=entry.match(re);return m?m[1].replace(/<[^>]*>/g,"").trim():"";
}
async function fetchTreasury10Y() {
  const month=new Date().toISOString().slice(0,7).replace("-","");
  const u=new URL("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml");
  u.searchParams.set("data","daily_treasury_yield_curve");u.searchParams.set("field_tdr_date_value_month",month);
  const r=await fetch(u.toString(),{headers:{accept:"application/xml,text/xml"},signal:AbortSignal.timeout(10000)});
  if(!r.ok) throw new Error("Treasury HTTP "+r.status);
  const xml=await r.text(),entries=xml.match(/<entry\b[\s\S]*?<\/entry>/gi)||[];
  const rows=entries.map(e=>({date:xmlField(e,"NEW_DATE").slice(0,10),value:Number(xmlField(e,"BC_10YEAR"))}))
    .filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&Number.isFinite(x.value)).sort((a,b)=>b.date.localeCompare(a.date));
  if(!rows.length) throw new Error("Aucune observation 10 ans exploitable.");
  const a=rows[0],p=rows[1]||null,ageDays=Math.floor((Date.now()-Date.parse(a.date+"T23:59:59Z"))/86400000);
  return {value:a.value,date:a.date,changeBps:p?Number(((a.value-p.value)*100).toFixed(1)):null,ageDays,fresh:ageDays>=0&&ageDays<=4,frequency:"QUOTIDIEN",source:"U.S. Treasury"};
}
async function fetchGoldMacroContext() {
  const errors=[];let dxy=null,treasury10y=null;
  try {
    const sym=await findDxySymbol();if(!sym)throw new Error("Symbole DXY non identifié dans le catalogue.");
    const u=new URL("https://biquote.io/api/latest");u.searchParams.append("symbols",sym.name);
    const payload=await fetchMacroJson(u.toString()),rows=macroRows(payload);
    const q=rows.find(x=>String(x.symbol||x.name||"").toUpperCase()===sym.name.toUpperCase())||(Array.isArray(payload)?payload[0]:payload?.[sym.name]);
    if(!q)throw new Error("Cotation DXY absente.");
    const age=Number(q.quoteAgeSeconds),price=Number(q.mid),change=Number(q.dayDiffPercent);
    const live=q.marketState==="open"&&q.stale!==true&&Number.isFinite(age)&&age>=0&&age<=300&&Number.isFinite(price)&&price>0;
    dxy={symbol:sym.name,price:Number.isFinite(price)&&price>0?price:null,dayChangePercent:Number.isFinite(change)?change:null,quoteAgeSeconds:Number.isFinite(age)?age:null,marketState:q.marketState||"UNKNOWN",live,timestamp:q.timestamp||null};
    if(!live)errors.push("DXY non live ou cotation trop ancienne.");
  }catch(e){errors.push("DXY : "+e.message);}
  try{treasury10y=await fetchTreasury10Y();if(!treasury10y.fresh)errors.push("Taux 10 ans : observation trop ancienne.");}
  catch(e){errors.push("Taux 10 ans : "+e.message);}
  const dd=dxy?.live&&dxy.dayChangePercent!==null?(dxy.dayChangePercent>0.05?"HAUSSE":dxy.dayChangePercent< -0.05?"BAISSE":"STABLE"):"INCONNU";
  const yd=treasury10y?.fresh&&treasury10y.changeBps!==null?(treasury10y.changeBps>1?"HAUSSE":treasury10y.changeBps< -1?"BAISSE":"STABLE"):"INCONNU";
  let bias="NON_EVALUE",explanation="Contexte macro incomplet : aucune conclusion directionnelle fiable.";
  if(dd!=="INCONNU"&&yd!=="INCONNU"){
    if(dd==="HAUSSE"&&yd==="HAUSSE"){bias="PRESSION_BAISSIERE_OR";explanation="Dollar et taux nominaux en hausse : contexte généralement défavorable à l'or, pas un signal de vente.";}
    else if(dd==="BAISSE"&&yd==="BAISSE"){bias="SOUTIEN_HAUSSIER_OR";explanation="Dollar et taux nominaux en baisse : contexte généralement favorable à l'or, pas un signal d'achat.";}
    else if(dd==="STABLE"&&yd==="STABLE"){bias="NEUTRE";explanation="Dollar et taux relativement stables sur leurs fenêtres respectives.";}
    else{bias="SIGNAUX_MIXTES";explanation="Dollar et taux divergent : pas de biais macro directionnel clair.";}
  }
  return {status:dxy?.live&&treasury10y?.fresh?"DONNEES_DISPONIBLES":"COUVERTURE_PARTIELLE",bias,explanation,dxy,treasury10y,dxyDirection:dd,yieldDirection:yd,errors,generatedAt:new Date().toISOString(),note:"DXY live si frais ; taux 10 ans Treasury publié quotidiennement, jamais intraday. Contexte uniquement, aucun ordre."};
}

function analyzeMarketAnticipation(results, marketOpen, calendar) {
  const order = ["M1", "M5", "M15", "H1", "H4", "D1"];
  const usable = results.filter(x =>
    x.ok && x.analysis?.dataQuality?.ok && order.includes(x.timeframe)
  );
  const byTf = new Map(usable.map(x => [x.timeframe, x.analysis]));
  const eventWindowActive = calendar?.riskLevel === "FENETRE_ANNONCE" && !calendar?.stale;
  const empty = {
    status: marketOpen === false ? "MARCHE_FERME" : "DONNEES_NON_CONFIRMEES",
    phase: "NON_EVALUEE", direction: "INDETERMINE", confluenceIndex: 0,
    bullishEvidence: [], bearishEvidence: [], validTimeframes: usable.length,
    trigger: null, invalidation: null, eventRisk: calendar?.riskLevel || "INCONNU",
    eventWindowActive,
    explanation: "Les flux live et la couverture multi-unites doivent etre valides avant toute anticipation.",
    note: "Indice heuristique de convergence, pas une probabilite ni une prevision certaine."
  };
  if (marketOpen !== true || !byTf.has("M1") || !byTf.has("M5")) return empty;

  const scores = { HAUSSIER: 0, BAISSIER: 0 };
  const evidence = { HAUSSIER: [], BAISSIER: [] };
  const weights = { M1: 1, M5: 1.5, M15: 2, H1: 2.5, H4: 3, D1: 3 };
  const add = (side, points, label) => {
    scores[side] += points;
    evidence[side].push(label);
  };
  let compression = false, pressure = false, impulse = false;
  let bullishBreak = false, bearishBreak = false;
  let bullishTrigger = null, bearishTrigger = null;
  let bullishInvalidation = null, bearishInvalidation = null;

  for (const tf of order) {
    const a = byTf.get(tf);
    if (!a) continue;
    const w = weights[tf], ind = a.indicators || {}, st = a.structure || {};
    const reversal = a.reversalSignals || {}, reg = a.regime || {};
    const vol = a.volatility || {}, liq = a.liquidity || {};
    const trend = a.trend?.direction || "NEUTRE";

    if (trend === "HAUSSIER") add("HAUSSIER", 2 * w, tf + " : alignement EMA haussier");
    if (trend === "BAISSIER") add("BAISSIER", 2 * w, tf + " : alignement EMA baissier");

    if (Number.isFinite(ind.plusDI) && Number.isFinite(ind.minusDI)) {
      const gap = ind.plusDI - ind.minusDI;
      if (gap >= 5) add("HAUSSIER", w, tf + " : pression DI acheteuse");
      if (gap <= -5) add("BAISSIER", w, tf + " : pression DI vendeuse");
    }
    const histogram = ind.macd?.histogram;
    const previousHistogram = ind.macd?.previousHistogram;
    if (Number.isFinite(histogram) && Number.isFinite(previousHistogram)) {
      if (histogram > 0 && histogram > previousHistogram)
        add("HAUSSIER", w, tf + " : momentum MACD haussier en progression");
      if (histogram < 0 && histogram < previousHistogram)
        add("BAISSIER", w, tf + " : momentum MACD baissier en progression");
    }
    if (Number.isFinite(ind.rsi14)) {
      if (ind.rsi14 >= 53 && ind.rsi14 <= 68)
        add("HAUSSIER", 0.6 * w, tf + " : RSI en zone de momentum haussier");
      if (ind.rsi14 <= 47 && ind.rsi14 >= 32)
        add("BAISSIER", 0.6 * w, tf + " : RSI en zone de momentum baissier");
    }
    if (st.bullishDivergence || st.bullishMacdDivergence)
      add("HAUSSIER", 1.5 * w, tf + " : divergence haussiere");
    if (st.bearishDivergence || st.bearishMacdDivergence)
      add("BAISSIER", 1.5 * w, tf + " : divergence baissiere");

    const bullishStructureBreak =
      st.choch === "CHOCH_HAUSSIER" || st.bos === "BOS_HAUSSIER";
    const bearishStructureBreak =
      st.choch === "CHOCH_BAISSIER" || st.bos === "BOS_BAISSIER";
    if (bullishStructureBreak) {
      add("HAUSSIER", 2.5 * w, tf + " : cassure structurelle haussiere");
      bullishBreak = true;
      bullishTrigger = st.breakLevel ?? bullishTrigger;
    }
    if (bearishStructureBreak) {
      add("BAISSIER", 2.5 * w, tf + " : cassure structurelle baissiere");
      bearishBreak = true;
      bearishTrigger = st.breakLevel ?? bearishTrigger;
    }
    if (reversal.stage === "RETOURNEMENT_EN_FORMATION" ||
        reversal.stage === "RETOURNEMENT_CONFIRME") {
      if (reversal.direction === "HAUSSIER")
        add("HAUSSIER", (reversal.stage === "RETOURNEMENT_CONFIRME" ? 2 : 1) * w,
          tf + " : " + reversal.stage.toLowerCase().replaceAll("_", " "));
      if (reversal.direction === "BAISSIER")
        add("BAISSIER", (reversal.stage === "RETOURNEMENT_CONFIRME" ? 2 : 1) * w,
          tf + " : " + reversal.stage.toLowerCase().replaceAll("_", " "));
    }

    if (["M1", "M5", "M15"].includes(tf)) {
      if (vol.status === "CONTRACTION" || reg.compressed === true ||
          (reg.regime === "RANGE" && Number(reg.rangeQuality) >= 60) ||
          (reg.regime === "TRANSITION" && reg.phase === "RANGE_POTENTIEL")) {
        compression = true;
      }
      if (vol.status === "ACCELERATION" || vol.status === "EXTREME" ||
          reg.breakoutCandidateUp || reg.breakoutCandidateDown) pressure = true;
      if (vol.status === "EXTREME" || reg.breakoutUp || reg.breakoutDown) impulse = true;

      if (reg.breakoutCandidateUp || reg.breakoutUp || reg.fakeoutDown) {
        add("HAUSSIER", 1.5 * w, tf + " : pression vers le haut / rejet du bas");
      }
      if (reg.breakoutCandidateDown || reg.breakoutDown || reg.fakeoutUp) {
        add("BAISSIER", 1.5 * w, tf + " : pression vers le bas / rejet du haut");
      }
      if (reg.breakoutUp) { bullishBreak = true; bullishTrigger = reg.rangeHigh ?? bullishTrigger; }
      if (reg.breakoutDown) { bearishBreak = true; bearishTrigger = reg.rangeLow ?? bearishTrigger; }
      if (liq.sweepDirection === "HAUSSIER")
        add("HAUSSIER", w, tf + " : balayage de liquidite basse rejete");
      if (liq.sweepDirection === "BAISSIER")
        add("BAISSIER", w, tf + " : balayage de liquidite haute rejete");
    }

    if (tf === "M1") {
      bullishInvalidation = Number.isFinite(st.lastSwingLow) ? st.lastSwingLow : null;
      bearishInvalidation = Number.isFinite(st.lastSwingHigh) ? st.lastSwingHigh : null;
    }
  }

  const bullish = scores.HAUSSIER, bearish = scores.BAISSIER;
  const difference = Math.abs(bullish - bearish);
  const direction = difference >= 3
    ? (bullish > bearish ? "HAUSSIER" : "BAISSIER")
    : "INDETERMINE";
  const dominant = direction === "HAUSSIER" ? bullish
    : direction === "BAISSIER" ? bearish : Math.max(bullish, bearish);
  const opposition = direction === "HAUSSIER" ? bearish
    : direction === "BAISSIER" ? bullish : Math.min(bullish, bearish);
  const index = Math.max(0, Math.min(100,
    Math.round(dominant / (dominant + opposition + 4) * 100)
  ));
  const alignedHigher = direction !== "INDETERMINE"
    ? ["H1", "H4", "D1"].filter(tf => byTf.get(tf)?.trend?.direction === direction).length
    : 0;
  const confirmedForDirection = direction === "HAUSSIER" ? bullishBreak
    : direction === "BAISSIER" ? bearishBreak : false;
  const trigger = direction === "HAUSSIER" ? bullishTrigger
    : direction === "BAISSIER" ? bearishTrigger : null;
  const invalidation = direction === "HAUSSIER" ? bullishInvalidation
    : direction === "BAISSIER" ? bearishInvalidation : null;

  let phase = "OBSERVATION";
  if (confirmedForDirection) phase = "CONFIRMATION_STRUCTURELLE";
  else if (impulse || pressure) phase = "IMPULSION_EN_COURS";
  else if (compression && (bullish >= 3 || bearish >= 3)) phase = "PREPARATION_POSSIBLE";
  else if (direction !== "INDETERMINE") phase = "PRESSION_DIRECTIONNELLE";

  const status = direction === "INDETERMINE" ? "AUCUN_BIAIS_DOMINANT"
    : index >= 68 && alignedHigher >= 2 ? "CONVERGENCE_FORTE"
    : index >= 55 ? "CONVERGENCE_MODEREE" : "INDICES_PRELIMINAIRES";
  const leadingEvidence = evidence[direction] || [];
  const explanation = direction === "INDETERMINE"
    ? "Les pressions acheteuses et vendeuses restent trop proches : TradePilot ne force pas de direction."
    : phase === "PREPARATION_POSSIBLE"
      ? "Compression ou range detecte avec une pression directionnelle preliminaire. Une expansion est possible, mais le sens doit encore etre confirme par une cloture hors zone."
      : phase === "IMPULSION_EN_COURS"
        ? "La volatilite ou la pression de cassure augmente. Le sens dominant est estime a partir de plusieurs indices, mais le mouvement peut etre un faux depart."
        : confirmedForDirection
          ? "Une cassure dans le sens du scenario dominant est observee sur une unite validee. Le retest et le maintien du niveau restent a surveiller."
          : "Plusieurs indices techniques convergent, sans cassure structurelle suffisante pour qualifier le mouvement de confirme.";

  return {
    status, phase, direction, confluenceIndex: index,
    bullishIndex: Math.round(Math.min(100, bullish * 4)),
    bearishIndex: Math.round(Math.min(100, bearish * 4)),
    bullishEvidence: evidence.HAUSSIER.slice(0, 8),
    bearishEvidence: evidence.BAISSIER.slice(0, 8),
    leadingEvidence: leadingEvidence.slice(0, 8),
    validTimeframes: usable.length, alignedHigherTimeframes: alignedHigher,
    volatility: { compression, pressure, impulse },
    eventRisk: calendar?.riskLevel || "INCONNU",
    eventWindowActive,
    eventName: calendar?.activeEvent?.name || calendar?.nextEvent?.name || null,
    eventMinutes: calendar?.nextEvent?.minutesUntil ?? null,
    trigger, invalidation, explanation,
    note: "Indice heuristique de convergence, pas une probabilite de gain. Les annonces peuvent provoquer des gaps, spreads elargis et faux mouvements. Anticipation indicative uniquement."
  };
}

async function handleDashboardData(env) {
  const timeframes = Object.keys(TIMEFRAMES);
  const results = await Promise.all(timeframes.map(async timeframe => {
    try {
      const bars = await fetchCandles(timeframe, 250);
      return { timeframe, ok: true, analysis: buildDashboardFrame(timeframe, bars) };
    } catch (error) {
      return { timeframe, ok: false, error: error.message };
    }
  }));
  let quote = null, quoteError = null;
  try {
    quote = await fetchLiveQuote();
  } catch (error) {
    quoteError = error.message;
  }
  let calendar;
  try {
    calendar = await getEconomicContext(env);
  } catch (error) {
    calendar = { configured: false, status: "UNAVAILABLE", message: error.message, events: [] };
  }
  let macroCrossAsset;
  try { macroCrossAsset = await fetchGoldMacroContext(); }
  catch (error) { macroCrossAsset = {status:"INDISPONIBLE",bias:"NON_EVALUE",explanation:"Analyse macro indisponible.",errors:[error.message]}; }
  const available = results.filter(x => x.ok);
  const m1 = available.find(x => x.timeframe === "M1")?.analysis;
  const marketOpen = quote ? true :
    (quoteError && /marché XAUUSD fermé/i.test(quoteError) ? false : null);
  const multiTimeframeConfluence = analyzeMultiTimeframeConfluence(results, marketOpen);
  const setupConfluence = analyzeSetupConfluence(results, marketOpen);
  const reversalMultiTimeframe = analyzeReversalMultiTimeframe(results, marketOpen);
  const marketAnticipation = analyzeMarketAnticipation(results, marketOpen, calendar);
  return json({
    ok: available.length > 0,
    instrument: CONFIG.SYMBOL,
    generatedAt: new Date().toISOString(),
    market: {
      open: marketOpen,
      status: marketOpen === true ? "OUVERT" :
        marketOpen === false ? "FERME" : "INDETERMINE",
      price: quote?.mid ?? m1?.indicators?.price ?? null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      quoteTimestamp: quote?.timestamp ?? null,
      quoteAgeSeconds: quote?.quoteAgeSeconds ?? null,
      source: quote?.source ?? (m1 ? "BiQuote OHLC — dernière clôture" : null),
      quoteError
    },
    source: CONFIG.SOURCE_URL,
    timeframes: results,
    multiTimeframeConfluence,
    setupConfluence,
    reversalMultiTimeframe,
    marketAnticipation,
    economicCalendar: calendar,
    macroCrossAsset,
    execution: "AUCUN ORDRE REEL",
    note: "Analyse technique descriptive. Un score technique n'est pas une probabilité."
  });
}


function assistantCleanText(value, max = 240) {
  return typeof value === "string" ? value.replace(/[<>]/g, "").slice(0, max) : "";
}

function assistantNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function buildAssistantMarketContext(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const market = d.market || {};
  const ant = d.marketAnticipation || {};
  const rev = d.reversalMultiTimeframe || {};
  const cal = d.economicCalendar || {};
  const macro = d.macroCrossAsset || {};
  const timeframes = Array.isArray(d.timeframes) ? d.timeframes.slice(0, 6) : [];
  return {
    instrument: "XAUUSD",
    generatedAt: assistantCleanText(d.generatedAt, 40),
    market: {
      open: market.open === true ? true : market.open === false ? false : null,
      status: assistantCleanText(market.status, 40),
      price: assistantNumber(market.price),
      bid: assistantNumber(market.bid),
      ask: assistantNumber(market.ask),
      quoteAgeSeconds: assistantNumber(market.quoteAgeSeconds),
      quoteError: assistantCleanText(market.quoteError, 180)
    },
    timeframes: timeframes.map(item => {
      const a = item?.analysis || {};
      const t = a.trend || {};
      const r = a.regime || {};
      const v = a.volatility || {};
      const st = a.structure || {};
      const liq = a.liquidity || {};
      return {
        timeframe: assistantCleanText(item?.timeframe, 5),
        available: item?.ok === true && a.dataQuality?.ok === true,
        trend: assistantCleanText(t.direction, 30),
        trendStrength: assistantCleanText(t.strength, 30),
        adx: assistantNumber(t.adx),
        regime: assistantCleanText(r.regime, 50),
        regimePhase: assistantCleanText(r.phase, 50),
        rangeQuality: assistantNumber(r.rangeQuality),
        rangeHigh: assistantNumber(r.rangeHigh),
        rangeLow: assistantNumber(r.rangeLow),
        breakoutState: assistantCleanText(r.breakoutState, 50),
        breakoutDirection: assistantCleanText(r.breakoutDirection, 30),
        volatility: assistantCleanText(v.status, 40),
        volatilityExplanation: assistantCleanText(v.explanation, 180),
        structure: assistantCleanText(st.structure, 80),
        bos: assistantCleanText(st.bos, 40),
        choch: assistantCleanText(st.choch, 40),
        breakLevel: assistantNumber(st.breakLevel),
        liquidityStatus: assistantCleanText(liq.status, 40),
        liquiditySweep: assistantCleanText(liq.sweep, 60),
        dataQuality: a.dataQuality?.ok === true ? "OK" : "INSUFFISANTE"
      };
    }),
    anticipation: {
      status: assistantCleanText(ant.status, 60),
      phase: assistantCleanText(ant.phase, 60),
      direction: assistantCleanText(ant.direction, 30),
      confluenceIndex: assistantNumber(ant.confluenceIndex),
      validTimeframes: assistantNumber(ant.validTimeframes),
      alignedHigherTimeframes: assistantNumber(ant.alignedHigherTimeframes),
      bullishEvidence: Array.isArray(ant.bullishEvidence) ? ant.bullishEvidence.slice(0, 6).map(x => assistantCleanText(x, 150)) : [],
      bearishEvidence: Array.isArray(ant.bearishEvidence) ? ant.bearishEvidence.slice(0, 6).map(x => assistantCleanText(x, 150)) : [],
      leadingEvidence: Array.isArray(ant.leadingEvidence) ? ant.leadingEvidence.slice(0, 8).map(x => assistantCleanText(x, 150)) : [],
      trigger: assistantNumber(ant.trigger),
      invalidation: assistantNumber(ant.invalidation),
      eventRisk: assistantCleanText(ant.eventRisk, 50),
      eventWindowActive: ant.eventWindowActive === true,
      explanation: assistantCleanText(ant.explanation, 350)
    },
    reversal: {
      status: assistantCleanText(rev.status, 50),
      bias: assistantCleanText(rev.bias, 30),
      confirmedCount: assistantNumber(rev.confirmedCount),
      formationCount: assistantNumber(rev.formationCount),
      earlyCount: assistantNumber(rev.earlyCount),
      invalidatedCount: assistantNumber(rev.invalidatedCount),
      explanation: assistantCleanText(rev.explanation, 260),
      details: Array.isArray(rev.details) ? rev.details.slice(0, 6).map(x => ({
        timeframe: assistantCleanText(x.timeframe, 5),
        stage: assistantCleanText(x.stage, 50),
        direction: assistantCleanText(x.direction, 30),
        invalidated: x.invalidated === true,
        againstTrend: x.againstTrend === true
      })) : []
    },
    calendar: {
      configured: cal.configured === true,
      status: assistantCleanText(cal.status, 40),
      stale: cal.stale === true,
      riskLevel: assistantCleanText(cal.riskLevel, 50),
      blackout: cal.blackout === true,
      safeToTrade: cal.safeToTrade === true,
      activeEvent: cal.activeEvent ? {
        name: assistantCleanText(cal.activeEvent.name, 120),
        country: assistantCleanText(cal.activeEvent.country, 12),
        impact: assistantCleanText(cal.activeEvent.impact, 20),
        goldImpact: assistantCleanText(cal.activeEvent.goldImpact, 30),
        releaseAt: assistantCleanText(cal.activeEvent.releaseAt, 40)
      } : null,
      nextEvent: cal.nextEvent ? {
        name: assistantCleanText(cal.nextEvent.name, 120),
        country: assistantCleanText(cal.nextEvent.country, 12),
        impact: assistantCleanText(cal.nextEvent.impact, 20),
        goldImpact: assistantCleanText(cal.nextEvent.goldImpact, 30),
        minutesUntil: assistantNumber(cal.nextEvent.minutesUntil),
        releaseAt: assistantCleanText(cal.nextEvent.releaseAt, 40)
      } : null,
      recentSurprises: Array.isArray(cal.recentSurprises) ? cal.recentSurprises.slice(0, 3).map(x => ({
        name: assistantCleanText(x.name, 100),
        comparison: assistantCleanText(x.comparison, 50),
        goldBias: assistantCleanText(x.goldBias, 50),
        reason: assistantCleanText(x.reason, 180)
      })) : []
    },
    macroCrossAsset: {
      status: assistantCleanText(macro.status, 40),
      bias: assistantCleanText(macro.bias, 40),
      explanation: assistantCleanText(macro.explanation, 240)
    },
    execution: "AUCUN ORDRE REEL"
  };
}

async function handleAssistantChat(request, env) {
  if (!env.AI || typeof env.AI.run !== "function") {
    return json({
      ok: false,
      code: "AI_BINDING_MISSING",
      error: "Le service IA Cloudflare n'est pas encore relié à ce Worker."
    }, 503);
  }

  const rawBody = await request.text();
  if (rawBody.length > 24000) {
    return json({ ok: false, error: "Message trop volumineux. Réduis l'historique de conversation." }, 413);
  }

  let body;
  try { body = JSON.parse(rawBody); }
  catch { return json({ ok: false, error: "Corps JSON invalide." }, 400); }

  const question = assistantCleanText(body?.question, 700).trim();
  if (!question) return json({ ok: false, error: "Écris une question avant l'envoi." }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const ipHash = Array.from(new Uint8Array(digest)).slice(0, 12).map(x => x.toString(16).padStart(2, "0")).join("");
  const rateKey = "assistant_rate_" + ipHash;
  if (env.TP_STATE) {
    const previous = Number(await readKV(env, rateKey) || 0);
    if (previous >= 12) {
      return json({ ok: false, code: "RATE_LIMIT", error: "Limite temporaire atteinte. Réessaie dans quelques minutes." }, 429);
    }
    await writeKV(env, rateKey, previous + 1, 600);
  }

  const history = Array.isArray(body?.history) ? body.history.slice(-8) : [];
  const messages = history.map(item => ({
    role: item?.role === "assistant" ? "assistant" : "user",
    content: assistantCleanText(item?.content, 500)
  })).filter(item => item.content);
  if (!messages.length || messages[messages.length - 1].role !== "user" ||
      messages[messages.length - 1].content !== question) {
    messages.push({ role: "user", content: question });
  }

  const context = buildAssistantMarketContext(body?.marketContext);
  const system = [
    "Tu es TradePilot AI, assistant d'analyse de marché spécialisé dans l'or XAUUSD.",
    "Réponds en français, de façon claire, professionnelle, naturelle et concise.",
    "Tu dois répondre à la question en t'appuyant d'abord sur le contexte JSON fourni. Les données sont une photographie au moment generatedAt, pas forcément le cours actuel.",
    "N'invente jamais de prix, d'indicateur, d'annonce, de résultat, de probabilité ou de confirmation absente du contexte. Si une donnée manque ou est périmée, dis-le explicitement.",
    "Distingue préparation, pression, impulsion et confirmation structurelle. Un indice de convergence n'est jamais une probabilité de gain.",
    "Explique les éléments contradictoires et les conditions qui invalideraient un scénario. Si marché fermé, flux non confirmé ou données insuffisantes, indique qu'il ne faut pas présenter cela comme un signal live.",
    "Les niveaux de liquidité sont des approximations OHLC, pas des données de carnet d'ordres.",
    "Tu ne donnes pas d'ordre exécutable, tu ne promets aucun rendement et tu ne prétends pas passer d'ordres. L'exécution reste manuelle et le statut est AUCUN ORDRE REEL.",
    "Si la question sort du contexte XAUUSD, réponds brièvement ou précise les limites.",
    "Contexte de marché structuré (JSON) : " + JSON.stringify(context)
  ].join("\n");

  const prompt = system + "\n\n" + messages.map(item =>
    (item.role === "assistant" ? "TradePilot: " : "Utilisateur: ") + item.content
  ).join("\n") + "\n\nTradePilot:";
  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt,
      max_tokens: 420,
      temperature: 0.25
    });
    const answer = assistantCleanText(
      result?.response || result?.output_text || result?.text ||
      (typeof result === "string" ? result : ""),
      3200
    ).trim();
    if (!answer) throw new Error("Réponse IA vide.");
    return json({
      ok: true,
      answer,
      model: "@cf/meta/llama-3.1-8b-instruct",
      generatedAt: new Date().toISOString(),
      contextAt: context.generatedAt,
      execution: "AUCUN ORDRE REEL"
    });
  } catch (error) {
    return json({
      ok: false,
      code: "AI_UNAVAILABLE",
      error: "Le modèle IA est momentanément indisponible. Réessaie dans quelques instants."
    }, 502);
  }
}

// --------------------------------------------------
// ROUTES
// --------------------------------------------------

async function handleStatus(env) {
  const cronRaw = await readKV(env, "cron_status");
  const signalRaw = await readKV(env, "last_signal");
  const alertRaw = await readKV(env, "last_alert");

  let cron = {
    status: "NOT_YET_EXECUTED",
    message: "Aucune execution Cron enregistree."
  };

  let lastSignal = null;
  let lastAlert = null;

  try {
    if (cronRaw) cron = JSON.parse(cronRaw);
    if (signalRaw) lastSignal = JSON.parse(signalRaw);
    if (alertRaw) lastAlert = JSON.parse(alertRaw);
  } catch {
    // Une donnee KV invalide ne bloque pas le diagnostic.
  }

  return json({
    ok: true,
    service: CONFIG.SERVICE,
    kvConfigured: Boolean(env.TP_STATE),
    telegramConfigured: telegramConfigured(env),
    aiConfigured: Boolean(env.AI && typeof env.AI.run === "function"),
    cron,
    lastSignal,
    lastAlert,
    timestamp: new Date().toISOString()
  });
}

async function handleSniperStats(env) {
  const raw = await readKV(env, SNIPER_STATS.KEY);
  let state;
  try { state = raw ? JSON.parse(raw) : null; } catch { state = null; }
  const samples = Array.isArray(state?.samples) ? state.samples : [];
  const buckets = [];
  for (const direction of ["BUY", "SELL"]) {
    for (const regime of ["TENDANCE", "RANGE", "TRANSITION", "INDETERMINE"]) {
      const stats = getSniperBucketStats(samples, direction, regime);
      if (stats.samples > 0) buckets.push(stats);
    }
  }
  return json({
    ok: true,
    instrument: CONFIG.SYMBOL,
    strategy: { target: CONFIG.TARGET, stop: CONFIG.STOP },
    validation: {
      targetHistoricalWinRate: SNIPER_STATS.TARGET_WIN_RATE * 100,
      minimumResolvedPerDirectionAndRegime: SNIPER_STATS.MIN_RESOLVED,
      maxHoldingMinutes: SNIPER_STATS.MAX_HOLD_MS / 60000,
      sampleRetentionDays: SNIPER_STATS.SAMPLE_TTL_SECONDS / 86400
    },
    storageConfigured: Boolean(env.TP_STATE),
    totalSamples: samples.length,
    pending: samples.filter(sample => sample.outcome === "PENDING").length,
    resolved: samples.filter(sample => ["WIN", "LOSS"].includes(sample.outcome)).length,
    timeouts: samples.filter(sample => sample.outcome === "TIMEOUT").length,
    buckets,
    updatedAt: state?.updatedAt ? new Date(state.updatedAt).toISOString() : null,
    note: "Résultats simulés sur OHLC M1, spread d'entrée pris en compte de façon prudente; commissions, slippage et prix bid/ask historiques ne sont pas disponibles. Aucun taux n'est garanti."
  });
}

async function handleAnalyze(request, env) {
  const settings = getSettings(new URL(request.url));
  const signal = await getSignal(settings, env, false);

  return json(signal, signal.ok ? 200 : 503);
}

async function handleScalp(request, env) {
  const settings = getSettings(new URL(request.url));
  const signal = await getSignal(settings, env, true);

  // Telegram ne reçoit que les décisions pleinement confirmées.
  // Les signaux EARLY restent visibles dans l'analyse, mais ne déclenchent
  // jamais de notification présentée comme une entrée immédiate.
  if (
    !signal.ok ||
    signal.signal === "ATTENDRE" ||
    signal.alertLevel !== "CONFIRMED"
  ) {
    return json({
      ...signal,
      alert: {
        sent: false,
        reason: !signal.ok
          ? "Analyse indisponible : aucune alerte envoyee."
          : signal.signal === "ATTENDRE"
            ? "Aucun signal valide."
            : "Signal precoce non confirme : notification Telegram ignoree."
      }
    }, signal.ok ? 200 : 503);
  }

  // Même anti-doublon que le Cron : une même direction confirmée
  // ne peut pas être renvoyée pendant la période de refroidissement.
  if (!(await shouldSendAlert(env, signal))) {
    return json({
      ...signal,
      alert: {
        sent: false,
        reason: "Signal confirme deja notifie recemment."
      }
    });
  }

  try {
    await sendTelegram(env, buildAlertMessage(signal));

    await writeKV(env, "last_alert", {
      key: getAlertKey(signal),
      signal: signal.signal,
      alertLevel: "CONFIRMED",
      entry: signal.entry,
      time: Date.now()
    }, 7 * 86400);

    return json({
      ...signal,
      alert: { sent: true }
    });
  } catch (error) {
    return json({
      ...signal,
      alert: {
        sent: false,
        error: error.message
      }
    }, 502);
  }
}

async function handleTelegramTest(request, env) {
  const configuredKey = String(env.TELEGRAM_TEST_KEY || "").trim();

  if (!configuredKey) {
    return json({
      ok: false,
      error: "TELEGRAM_TEST_KEY absent dans l'environnement Production."
    }, 503);
  }

  // Compatibilite avec les deux noms d'en-tete utilises pendant les tests.
  let suppliedKey = String(
    request.headers.get("x-test-key") ||
    request.headers.get("x-telegram-test-key") ||
    ""
  ).trim();

  if (!suppliedKey && request.method === "POST") {
    const rawBody = await request.text();

    if (rawBody.trim()) {
      try {
        const body = JSON.parse(rawBody);
        suppliedKey = String(body?.key || "").trim();
      } catch {
        return json({
          ok: false,
          error: "JSON illisible.",
          receivedContentType: request.headers.get("content-type") || "absent",
          bodyLength: rawBody.length,
          hint: "Choisir Body > JSON et envoyer un objet avec la propriete key."
        }, 400);
      }
    }
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      error: "Utiliser POST avec la cle dans le JSON (key) ou l'en-tete x-test-key / x-telegram-test-key."
    }, 405);
  }

  if (!suppliedKey || suppliedKey !== configuredKey) {
    return json({
      ok: false,
      error: "Cle de test invalide.",
      diagnostic: {
        keyReceived: Boolean(suppliedKey),
        receivedLength: suppliedKey.length,
        configuredLength: configuredKey.length
      }
    }, 403);
  }

  try {
    const result = await sendTelegram(
      env,
      "✅ TradePilot AI : test Telegram reussi."
    );

    return json({
      ok: true,
      message: "Notification Telegram envoyee.",
      messageId: result.result?.message_id
    });
  } catch (error) {
    return json({
      ok: false,
      error: error.message
    }, 502);
  }
}

async function handleCalendarKeyCheck(env) {
  const apiKey = String(env.FINANCE_CALENDAR_API_KEY || "").trim();

  if (!apiKey) {
    return json({ configured: false, valid: false, status: "API_KEY_MISSING" }, 503);
  }

  try {
    const response = await fetch("https://www.financecalendar.com/wp-json/fc/v1/keys/me", {
      headers: { accept: "application/json", "X-API-Key": apiKey },
      signal: AbortSignal.timeout(10000)
    });
    const body = await response.text();
    let details = null;
    try { details = body ? JSON.parse(body) : null; } catch { details = null; }

    return json({
      configured: true,
      valid: response.ok,
      httpStatus: response.status,
      status: response.status === 200 ? "KEY_VALID" :
        response.status === 401 ? "KEY_INVALID_OR_UNAUTHORIZED" :
        response.status === 403 ? "KEY_REVOKED" :
        response.status === 503 ? "USAGE_CHECK_UNAVAILABLE" : "KEY_CHECK_ERROR",
      message: response.ok
        ? "La clé est acceptée par Finance Calendar."
        : "Finance Calendar n'a pas validé la clé.",
      details
    }, response.ok ? 200 : 502);
  } catch (error) {
    return json({
      configured: true, valid: false, status: "NETWORK_ERROR",
      message: error.message
    }, 502);
  }
}

async function handleHealth(env) {
  return json({
    ok: true,
    service: CONFIG.SERVICE,
    status: "online",
    instrument: CONFIG.SYMBOL,
    kvConfigured: Boolean(env.TP_STATE),
    telegramConfigured: telegramConfigured(env),
    aiConfigured: Boolean(env.AI && typeof env.AI.run === "function"),
    cronExpected: "*/3 * * * *",
    liveTrading: false,
    execution: "AUCUN ORDRE REEL"
  });
}

// Diagnostic des bougies : /gold?timeframe=M1
async function handleGold(request) {
  const url = new URL(request.url);
  const timeframe = (
    url.searchParams.get("timeframe") || "M1"
  ).toUpperCase();

  if (!TIMEFRAMES[timeframe]) {
    return json({
      ok: false,
      error: "Timeframe non pris en charge.",
      available: Object.keys(TIMEFRAMES)
    }, 400);
  }

  const bars = await fetchCandles(timeframe, 200);
  const quality = inspectDataQuality(bars, timeframe);

  return json({
    ok: true,
    instrument: CONFIG.SYMBOL,
    timeframe,
    count: bars.length,
    latest: bars[bars.length - 1],
    dataQuality: quality,
    source: CONFIG.SOURCE_URL
  });
}

// --------------------------------------------------
// CLOUDFLARE WORKER
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
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-test-key, x-telegram-test-key"
        }
      });
    }

    if (
      request.method !== "GET" &&
      !(request.method === "POST" &&
        (path === "/telegram-test" || path === "/assistant-chat"))
    ) {
      return json({
        ok: false,
        error: "Methode non prise en charge."
      }, 405);
    }

    try {
      if (path === "/" || path === "/health") {
        return await handleHealth(env);
      }

      if (path === "/status") {
        return await handleStatus(env);
      }

      if (path === "/dashboard-data") {
        return await handleDashboardData(env);
      }

      if (path === "/assistant-chat") {
        return await handleAssistantChat(request, env);
      }

      if (path === "/gold") {
        return await handleGold(request);
      }

      if (path === "/calendar") {
        return json(await getEconomicContext(env));
      }

      if (path === "/calendar-key-check") {
        return await handleCalendarKeyCheck(env);
      }

      if (path === "/analyze") {
        return await handleAnalyze(request, env);
      }

      if (path === "/sniper-stats") {
        return await handleSniperStats(env);
      }

      if (path === "/scalp") {
        return await handleScalp(request, env);
      }

      if (path === "/telegram-test") {
        return await handleTelegramTest(request, env);
      }

      return json({
        ok: false,
        error: "Route inconnue.",
        available: [
          "/health",
          "/status",
          "/dashboard-data",
          "/assistant-chat",
          "/gold?timeframe=M1",
          "/gold?timeframe=M5",
          "/gold?timeframe=M15",
          "/analyze",
          "/sniper-stats",
          "/calendar",
          "/scalp",
          "/telegram-test?key=VOTRE_CLE"
        ]
      }, 404);
    } catch (error) {
      return json({
        ok: false,
        instrument: CONFIG.SYMBOL,
        error: error.message,
        timestamp: new Date().toISOString()
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      scheduledCheck(env).catch(async error => {
        await saveCronStatus(env, "ERROR", {
          message: error.message
        });
      })
    );
  }
};
