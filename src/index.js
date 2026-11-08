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
  M15: { interval: "15m", ms: 900_000 }
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
  url.searchParams.set("allowStale", "false");

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

  if (
    quote.marketState !== "open" ||
    quote.stale === true ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    !Number.isFinite(mid) ||
    bid <= 0 ||
    ask < bid ||
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0 ||
    ageSeconds > CONFIG.LIVE_QUOTE_MAX_AGE_SECONDS
  ) {
    throw new Error("Cours XAUUSD fermé, périmé ou incomplet. Aucun signal immédiat autorisé.");
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
    ema21: ema(closes, 21),
    ema50: ema(closes, 50),
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

function analyzeMarketRegime(bars, indicator) {
  const recent = bars.slice(-40);
  if (recent.length < 25 || indicator.adx.adx === null ||
      indicator.bollinger.bandwidth === null || indicator.atr === null) {
    return { regime: "INDETERMINE", phase: "DONNEES_INSUFFISANTES",
      rangeHigh: null, rangeLow: null, rangePosition: null,
      touchesHigh: 0, touchesLow: 0, emaSlopeAtr: null,
      breakoutUp: false, breakoutDown: false, explanation: "Historique insuffisant pour classifier le régime." };
  }
  const closed = recent.slice(0, -1);
  const rangeHigh = Math.max(...closed.map(b => b.high));
  const rangeLow = Math.min(...closed.map(b => b.low));
  const width = rangeHigh - rangeLow;
  const price = indicator.price;
  const rangePosition = width > 0 ? (price - rangeLow) / width : 0.5;
  const tolerance = Math.max(indicator.atr * 0.25, width * 0.06);
  const touchesHigh = closed.filter(b => Math.abs(b.high - rangeHigh) <= tolerance).length;
  const touchesLow = closed.filter(b => Math.abs(b.low - rangeLow) <= tolerance).length;
  const closes = bars.map(b => b.close);
  const priorEma21 = ema(closes.slice(0, -5), 21);
  const emaSlopeAtr = priorEma21 === null ? null : (indicator.ema21 - priorEma21) / (indicator.atr * 5);
  const breakoutUp = price > rangeHigh + indicator.atr * 0.10;
  const breakoutDown = price < rangeLow - indicator.atr * 0.10;
  const adx = indicator.adx.adx;
  const compressed = indicator.bollinger.bandwidth < 0.0035;
  const flat = emaSlopeAtr !== null && Math.abs(emaSlopeAtr) < 0.18;
  const rangeStructure = touchesHigh >= 2 && touchesLow >= 2 && rangePosition >= 0 && rangePosition <= 1;
  let regime = "TRANSITION";
  let phase = "MARCHE_MIXTE";
  let explanation = "Signaux de régime contradictoires : prudence.";
  if (breakoutUp && adx >= 18) {
    regime = "TENDANCE"; phase = "CASSURE_HAUSSIERE";
    explanation = "Cassure haussière de la zone récente avec force directionnelle.";
  } else if (breakoutDown && adx >= 18) {
    regime = "TENDANCE"; phase = "CASSURE_BAISSIERE";
    explanation = "Cassure baissière de la zone récente avec force directionnelle.";
  } else if (adx <= 18 && flat && (rangeStructure || compressed)) {
    regime = "RANGE"; phase = rangePosition <= 0.25 ? "PROCHE_SUPPORT" :
      rangePosition >= 0.75 ? "PROCHE_RESISTANCE" : "MILIEU_RANGE";
    explanation = "ADX faible, pente EMA réduite et marché contenu dans une zone horizontale.";
  } else if (adx >= 25 && emaSlopeAtr !== null && Math.abs(emaSlopeAtr) >= 0.18) {
    regime = "TENDANCE"; phase = getTrend(indicator) === "HAUSSIER" ? "TENDANCE_HAUSSIERE" :
      getTrend(indicator) === "BAISSIER" ? "TENDANCE_BAISSIERE" : "TENDANCE_EN_CONSTRUCTION";
    explanation = "ADX et pente EMA indiquent une dynamique directionnelle.";
  }
  return { regime, phase, rangeHigh, rangeLow,
    rangePosition: Number(rangePosition.toFixed(3)), touchesHigh, touchesLow,
    emaSlopeAtr: emaSlopeAtr === null ? null : Number(emaSlopeAtr.toFixed(3)),
    breakoutUp, breakoutDown, adx: Number(adx.toFixed(2)),
    bollingerBandwidth: Number(indicator.bollinger.bandwidth.toFixed(5)),
    compressed, flat, explanation };
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
    releaseMs: Date.parse(event.release_at_utc || event.time_utc || ""),
    windowStartMs: Date.parse(event.time_window_start || ""),
    windowEndMs: Date.parse(event.time_window_end || "")
  }));

  const activeEvent = timed.find(event => {
    if (Number.isFinite(event.releaseMs)) {
      return now >= event.releaseMs - ECONOMIC_CALENDAR.BEFORE_MS &&
        now <= event.releaseMs + ECONOMIC_CALENDAR.AFTER_MS;
    }

    if (
      Number.isFinite(event.windowStartMs) &&
      Number.isFinite(event.windowEndMs)
    ) {
      return now >= event.windowStartMs - ECONOMIC_CALENDAR.BEFORE_MS &&
        now <= event.windowEndMs + ECONOMIC_CALENDAR.AFTER_MS;
    }

    // Une date sans heure exacte ne déclenche pas de blocage arbitraire.
    return false;
  }) || null;

  return {
    configured: true,
    status: stale ? "STALE_CACHE" : "OK",
    source: "Finance Calendar",
    sourceUrl: "https://www.financecalendar.com",
    fetchedAt,
    stale,
    eventCount: relevant.length,
    blackout: Boolean(activeEvent),
    activeEvent: activeEvent ? {
      id: activeEvent.id || null,
      name: activeEvent.name || activeEvent.title || activeEvent.series_name || "Annonce économique",
      country: activeEvent.country || null,
      impact: activeEvent.impact || null,
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
    const from = now.toISOString().slice(0, 10);
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
    url.searchParams.set("limit", "5");

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
      !(request.method === "POST" && path === "/telegram-test")
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
