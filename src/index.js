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

// --------------------------------------------------
// ANALYSE DU MARCHE : INDICATEURS + CASSURE/RETEST
// --------------------------------------------------

function analyzeSetup(m1, m5, m15, settings) {
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
    // Divergence M5/M15 : penalite, pas veto absolu.
    if (t5 === "HAUSSIER") sellScore -= 8;
    else if (t5 === "BAISSIER") buyScore -= 8;
  }

  buyScore = Math.max(0, Math.min(100, buyScore));
  sellScore = Math.max(0, Math.min(100, sellScore));
  let signal = "ATTENDRE", score = Math.max(buyScore, sellScore);
  let reasons = ["Aucune configuration ne satisfait l'ensemble des filtres."];
  let targetPrice = null, stopPrice = null;
  const entry = i1.price;

  if (buyScore >= CONFIG.EARLY_SCORE && buyScore > sellScore) {
    signal = "ACHAT"; score = buyScore; reasons = buyReasons;
    targetPrice = entry + settings.target; stopPrice = entry - settings.stop;
  } else if (sellScore >= CONFIG.EARLY_SCORE && sellScore > buyScore) {
    signal = "VENTE"; score = sellScore; reasons = sellReasons;
    targetPrice = entry - settings.target; stopPrice = entry + settings.stop;
  }

  const alertLevel = signal === "ATTENDRE" ? "NONE" :
    score >= settings.minScore ? "CONFIRMED" : "EARLY";

  const round = value => Number(value.toFixed(2));
  return {
    ok: true, instrument: CONFIG.SYMBOL, signal, score, alertLevel,
    entry: round(entry), targetMove: settings.target, stopMove: settings.stop,
    targetPrice: targetPrice === null ? null : round(targetPrice),
    stopPrice: stopPrice === null ? null : round(stopPrice),
    capital: settings.capital, lotSize: settings.lots, leverage: CONFIG.LEVERAGE,
    riskReward: Number((settings.target / settings.stop).toFixed(3)),
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
      volatility
    },
    reasons,
    generatedAt: new Date().toISOString(),
    execution: "AUCUN ORDRE REEL"
  };
}

// --------------------------------------------------
// ANALYSE COMPLETE
// --------------------------------------------------

async function getSignal(settings, env) {
  const [m1, m5, m15] = await Promise.all([
    fetchCandles("M1"),
    fetchCandles("M5"),
    fetchCandles("M15")
  ]);

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

  const result = analyzeSetup(m1, m5, m15, settings);
  result.dataQuality = quality;

  const economicContext = await getEconomicContext(env);
  return applyEconomicFilter(result, economicContext);
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

  return [
    `🚨 TRADEPILOT AI — ${signal.instrument}`,
    "",
    `📊 SIGNAL : ${signal.signal}`,
    `🏷️ Niveau : ${signal.alertLevel === "CONFIRMED" ? "SIGNAL CONFIRME" : "OPPORTUNITE A SURVEILLER"}`,
    `🎯 Score technique : ${signal.score}/100`,
    "",
    `💰 Entrée indicative : ${signal.entry}`,
    `✅ Take Profit : ${signal.targetPrice}`,
    `🛑 Stop Loss : ${signal.stopPrice}`,
    "",
    `📦 Taille indicative : ${signal.lotSize} lot`,
    `💵 Capital de référence : ${signal.capital} USD`,
    `⚙️ Levier indicatif : x${signal.leverage}`,
    "",
    "📈 Tendances :",
    `M1 : ${signal.market.trendM1}`,
    `M5 : ${signal.market.trendM5}`,
    `M15 : ${signal.market.trendM15}`,
    "",
    "Motifs :",
    reasons,
    "",
    "⚠️ Signal indicatif uniquement. Aucun ordre réel exécuté."
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

    const url = new URL(ECONOMIC_CALENDAR.URL);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("country", "US,EU");
    url.searchParams.set("impact", "high");
    url.searchParams.set(
      "category",
      "economic-indicators,central-banks-monetary-policy"
    );
    url.searchParams.set("tz", "Europe/Paris");
    url.searchParams.set("limit", "200");

    const response = await fetch(url.toString(), {
      headers: {
        accept: "application/json",
        "X-API-Key": apiKey
      },
      signal: AbortSignal.timeout(12_000)
    });

    if (!response.ok) {
      throw new Error("Calendrier économique HTTP " + response.status);
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

    const signal = await getSignal(settings, env);

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

async function handleAnalyze(request, env) {
  const settings = getSettings(new URL(request.url));
  const signal = await getSignal(settings, env);

  return json(signal, signal.ok ? 200 : 503);
}

async function handleScalp(request, env) {
  const settings = getSettings(new URL(request.url));
  const signal = await getSignal(settings, env);

  if (!signal.ok || signal.signal === "ATTENDRE") {
    return json({
      ...signal,
      alert: {
        sent: false,
        reason: "Aucun signal valide."
      }
    }, signal.ok ? 200 : 503);
  }

  try {
    await sendTelegram(env, buildAlertMessage(signal));

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

      if (path === "/analyze") {
        return await handleAnalyze(request, env);
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
