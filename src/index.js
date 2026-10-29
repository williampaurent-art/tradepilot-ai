
/**
 * TradePilot AI — XAUUSD
 * Cloudflare Worker
 *
 * Strategie :
 * - Capital de reference : 1000 USD
 * - Taille : 0.5 lot par tranche de 1000 USD
 * - Levier cible : 500
 * - Take profit : mouvement de 2 USD sur XAUUSD
 * - Stop loss : mouvement de 7 USD sur XAUUSD
 * - Signaux selectifs, multi-timeframes
 *
 * Variables Cloudflare optionnelles :
 * - ALERT_WEBHOOK : URL HTTPS d'un webhook d'alerte
 * - TP_STATE : binding KV pour memoriser les signaux
 *
 * IMPORTANT :
 * Ce Worker genere des signaux et des alertes.
 * Il ne passe aucun ordre chez un courtier.
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
  MIN_RISK_REWARD: 0.285,

  MAX_CANDLE_AGE_MS: 5 * 60 * 1000,
  MAX_CANDLES: 250,
  COOLDOWN_MS: 5 * 60 * 1000,

  SOURCE_URL: "https://biquote.io/api/XAUUSD/ohlc"
};

const TIMEFRAMES = {
  M1: { interval: "1m", ms: 60_000 },
  M5: { interval: "5m", ms: 300_000 },
  M15: { interval: "15m", ms: 900_000 },
  M30: { interval: "30m", ms: 1_800_000 },
  H1: { interval: "1h", ms: 3_600_000 },
  H4: { interval: "4h", ms: 14_400_000 },
  D1: { interval: "1d", ms: 86_400_000 }
};

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
  if (raw === null || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;

  return Math.min(max, Math.max(min, value));
}

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

  const riskPercent = numberParam(
    url, "riskPercent", 50, 0.01, 100
  );

  const minScore = numberParam(
    url, "minScore", CONFIG.MIN_SCORE, 50, 100
  );

  // 0.5 lot par tranche de 1000 USD.
  const lots = (capital / 1000) * CONFIG.LOTS_PER_1000;

  return {
    capital,
    target,
    stopDistance,
    riskPercent,
    minScore,
    leverage: CONFIG.LEVERAGE,
    lots: Number(lots.toFixed(4))
  };
}

function toTimestamp(value) {
  if (value === null || value === undefined) return NaN;

  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const numeric = Number(value);

    if (value.trim() !== "" && Number.isFinite(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  return NaN;
}

function normalizeBars(payload) {
  let rows = Array.isArray(payload) ? payload : null;

  if (!rows && payload && typeof payload === "object") {
    for (const key of [
      "candles", "data", "results", "ohlc", "bars"
    ]) {
      if (Array.isArray(payload[key])) {
        rows = payload[key];
        break;
      }
    }
  }

  if (!rows) {
    throw new Error("Format de donnees OHLC non reconnu.");
  }

  const bars = rows.map((row) => {
    if (Array.isArray(row)) {
      return {
        time: toTimestamp(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4])
      };
    }

    return {
      time: toTimestamp(
        row.time ?? row.timestamp ?? row.t ??
        row.datetime ?? row.date
      ),
      open: Number(row.open ?? row.o),
      high: Number(row.high ?? row.h),
      low: Number(row.low ?? row.l),
      close: Number(row.close ?? row.c)
    };
  }).filter((b) =>
    Number.isFinite(b.time) &&
    Number.isFinite(b.open) &&
    Number.isFinite(b.high) &&
    Number.isFinite(b.low) &&
    Number.isFinite(b.close) &&
    b.high >= b.low &&
    b.high >= Math.max(b.open, b.close) &&
    b.low <= Math.min(b.open, b.close)
  );

  bars.sort((a, b) => a.time - b.time);

  const unique = [];
  for (const bar of bars) {
    if (unique.length && unique[unique.length - 1].time === bar.time) {
      unique[unique.length - 1] = bar;
    } else {
      unique.push(bar);
    }
  }

  return unique;
}

async function fetchCandles(timeframe = "M1", limit = 200) {
  const tf = TIMEFRAMES[String(timeframe).toUpperCase()];
  if (!tf) throw new Error("Timeframe non pris en charge.");

  const url = new URL(CONFIG.SOURCE_URL);
  url.searchParams.set("interval", tf.interval);
  url.searchParams.set(
    "limit",
    String(Math.min(CONFIG.MAX_CANDLES, Math.max(30, limit)))
  );

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(
      `Source de marche indisponible : HTTP ${response.status}`
    );
  }

  const payload = await response.json();
  const bars = normalizeBars(payload);

  if (bars.length < 30) {
    throw new Error(
      `Historique insuffisant pour ${timeframe} : ${bars.length} bougies.`
    );
  }

  // On exclut la bougie courante si elle n'est pas encore cloturee.
  const now = Date.now();
  const closed = bars.filter(
    (bar) => bar.time + tf.ms <= now
  );

  if (closed.length < 30) {
    throw new Error(
      `Pas assez de bougies cloturees pour ${timeframe}.`
    );
  }

  return closed.slice(-Math.min(limit, CONFIG.MAX_CANDLES));
}

function sma(values, period) {
  if (values.length < period) return null;

  const part = values.slice(-period);
  return part.reduce((sum, value) => sum + value, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let result = values.slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const averageGain = gains / period;
  const averageLoss = losses / period;

  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function calculateATR(bars, period = 14) {
  if (bars.length < period + 1) return null;

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

function indicators(bars) {
  const closes = bars.map((bar) => bar.close);
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

function trendFrom(indicator) {
  if (
    indicator.ema9 === null ||
    indicator.ema21 === null ||
    indicator.ema50 === null
  ) return "NEUTRE";

  if (
    indicator.ema9 > indicator.ema21 &&
    indicator.ema21 > indicator.ema50
  ) return "HAUSSIER";

  if (
    indicator.ema9 < indicator.ema21 &&
    indicator.ema21 < indicator.ema50
  ) return "BAISSIER";

  return "NEUTRE";
}

function roundPrice(value) {
  return Number(value.toFixed(2));
}

function analyzeSetup(m1, m5, m15, settings) {
  const i1 = indicators(m1);
  const i5 = indicators(m5);
  const i15 = indicators(m15);

  const trend1 = trendFrom(i1);
  const trend5 = trendFrom(i5);
  const trend15 = trendFrom(i15);

  const buyReasons = [];
  const sellReasons = [];

  // Le score privilegie les tendances concordantes.
  if (trend15 === "HAUSSIER") buyReasons.push("Tendance M15 haussiere");
  if (trend5 === "HAUSSIER") buyReasons.push("Tendance M5 haussiere");
  if (trend1 === "HAUSSIER") buyReasons.push("Tendance M1 haussiere");

  if (trend15 === "BAISSIER") sellReasons.push("Tendance M15 baissiere");
  if (trend5 === "BAISSIER") sellReasons.push("Tendance M5 baissiere");
  if (trend1 === "BAISSIER") sellReasons.push("Tendance M1 baissiere");

  let buyScore = buyReasons.length * 20;
  let sellScore = sellReasons.length * 20;

  if (i1.rsi !== null) {
    if (i1.rsi >= 50 && i1.rsi <= 68) {
      buyScore += 15;
      buyReasons.push("RSI favorable aux achats");
    }

    if (i1.rsi <= 50 && i1.rsi >= 32) {
      sellScore += 15;
      sellReasons.push("RSI favorable aux ventes");
    }
  }

  if (i5.rsi !== null) {
    if (i5.rsi >= 50 && i5.rsi <= 70) buyScore += 10;
    if (i5.rsi <= 50 && i5.rsi >= 30) sellScore += 10;
  }

  const last = m1[m1.length - 1];
  const previous = m1[m1.length - 2];

  if (last.close > previous.high && trend1 === "HAUSSIER") {
    buyScore += 15;
    buyReasons.push("Cassure du dernier plus haut");
  }

  if (last.close < previous.low && trend1 === "BAISSIER") {
    sellScore += 15;
    sellReasons.push("Cassure du dernier plus bas");
  }

  // Eviter les marches trop calmes ou trop volatils.
  const atr = i1.atr;
  const atrPercent = atr && i1.price ? (atr / i1.price) * 100 : null;

  let volatilityStatus = "NORMALE";
  let volatilityAllowed = true;

  if (atrPercent === null) {
    volatilityAllowed = false;
    volatilityStatus = "INDISPONIBLE";
  } else if (atrPercent < 0.001) {
    volatilityAllowed = false;
    volatilityStatus = "TROP FAIBLE";
  } else if (atrPercent > 0.25) {
    volatilityAllowed = false;
    volatilityStatus = "TROP ELEVEE";
  }

  if (!volatilityAllowed) {
    buyScore = Math.min(buyScore, 49);
    sellScore = Math.min(sellScore, 49);
  }

  // Les tendances M5 et M15 doivent etre d'accord.
  if (trend5 !== trend15 || trend5 === "NEUTRE") {
    buyScore = Math.min(buyScore, 69);
    sellScore = Math.min(sellScore, 69);
  }

  buyScore = Math.min(100, buyScore);
  sellScore = Math.min(100, sellScore);

  let signal = "ATTENDRE";
  let score = Math.max(buyScore, sellScore);
  let reasons = ["Aucune configuration suffisamment confirmee"];
  let entry = i1.price;
  let targetPrice = null;
  let stopPrice = null;

  if (buyScore >= settings.minScore && buyScore > sellScore) {
    signal = "ACHAT";
    score = buyScore;
    reasons = buyReasons;
    targetPrice = roundPrice(entry + settings.target);
    stopPrice = roundPrice(entry - settings.stopDistance);
  } else if (
    sellScore >= settings.minScore &&
    sellScore > buyScore
  ) {
    signal = "VENTE";
    score = sellScore;
    reasons = sellReasons;
    targetPrice = roundPrice(entry - settings.target);
    stopPrice = roundPrice(entry + settings.stopDistance);
  }

  return {
    ok: true,
    instrument: CONFIG.INSTRUMENT,
    signal,
    score,
    confidence: `${score}%`,
    entry: roundPrice(entry),
    targetMove: settings.target,
    stopMove: settings.stopDistance,
    targetPrice,
    stopPrice,
    capital: settings.capital,
    lotSize: settings.lots,
    leverage: settings.leverage,
    estimatedRiskReward:
      Number((settings.target / settings.stopDistance).toFixed(3)),
    market: {
      trendM1: trend1,
      trendM5: trend5,
      trendM15: trend15,
      rsiM1: i1.rsi === null ? null : Number(i1.rsi.toFixed(2)),
      atrM1: atr === null ? null : Number(atr.toFixed(4)),
      volatility: volatilityStatus
    },
    reasons,
    generatedAt: new Date().toISOString(),
    execution: "AUCUN ORDRE REEL"
  };
}

function validateFreshness(bars, timeframe = "M1") {
  const tf = TIMEFRAMES[timeframe];
  const last = bars[bars.length - 1];
  const age = Date.now() - (last.time + tf.ms);

  return {
    fresh: age >= 0 && age <= CONFIG.MAX_CANDLE_AGE_MS,
    ageMs: age
  };
}

async function getSignal(settings) {
  const [m1, m5, m15] = await Promise.all([
    fetchCandles("M1", 200),
    fetchCandles("M5", 200),
    fetchCandles("M15", 200)
  ]);

  const freshness = validateFreshness(m1, "M1");

  if (!freshness.fresh) {
    return {
      ok: false,
      instrument: CONFIG.INSTRUMENT,
      signal: "ATTENDRE",
      error: "Les donnees M1 sont trop anciennes.",
      candleAgeMs: freshness.ageMs,
      generatedAt: new Date().toISOString()
    };
  }

  return analyzeSetup(m1, m5, m15, settings);
}

async function sendAlert(env, signal) {
  if (!env.ALERT_WEBHOOK) {
    return {
      sent: false,
      reason: "ALERT_WEBHOOK non configure"
    };
  }

  if (signal.signal === "ATTENDRE") {
    return { sent: false, reason: "Aucun signal valide" };
  }

  const response = await fetch(env.ALERT_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text:
        `${CONFIG.SERVICE}: ${signal.signal} ${CONFIG.INSTRUMENT}\n` +
        `Score: ${signal.score}%\n` +
        `Entree: ${signal.entry}\n` +
        `Objectif: ${signal.targetPrice}\n` +
        `Stop: ${signal.stopPrice}\n` +
        `Taille indicative: ${signal.lotSize} lot\n` +
        `Levier cible: x${signal.leverage}\n` +
        `Aucune execution automatique.`,
      signal
    })
  });

  if (!response.ok) {
    throw new Error(`Echec du webhook : HTTP ${response.status}`);
  }

  return { sent: true };
}

async function handleScalp(request, env) {
  const url = new URL(request.url);
  const settings = getSettings(url);

  const signal = await getSignal(settings);

  if (signal.signal && signal.signal !== "ATTENDRE") {
    try {
      signal.alert = await sendAlert(env, signal);
    } catch (error) {
      signal.alert = {
        sent: false,
        error: error.message
      };
    }
  } else {
    signal.alert = {
      sent: false,
      reason: "Aucun signal valide"
    };
  }

  return json(signal, signal.ok === false ? 503 : 200);
}

async function handleGold(request) {
  const url = new URL(request.url);
  const timeframe = (
    url.searchParams.get("timeframe") || "M1"
  ).toUpperCase();

  const bars = await fetchCandles(timeframe, 200);

  return json({
    ok: true,
    instrument: CONFIG.INSTRUMENT,
    timeframe,
    count: bars.length,
    latest: bars[bars.length - 1],
    freshness: validateFreshness(bars, timeframe),
    candles: bars,
    source: CONFIG.SOURCE_URL
  });
}

async function handleBacktest(request) {
  const url = new URL(request.url);
  const settings = getSettings(url);

  const [m1, m5, m15] = await Promise.all([
    fetchCandles("M1", CONFIG.MAX_CANDLES),
    fetchCandles("M5", CONFIG.MAX_CANDLES),
    fetchCandles("M15", CONFIG.MAX_CANDLES)
  ]);

  // Backtest simplifie sur les bougies M1 disponibles.
  // Les bougies M5/M15 utilisees ici sont les plus recentes :
  // ce resultat n'est PAS un backtest historique multi-timeframes.
  const signal = analyzeSetup(m1, m5, m15, settings);

  return json({
    ok: true,
    mode: "ANALYSE TECHNIQUE, PAS BACKTEST HISTORIQUE",
    warning:
      "Ce endpoint ne mesure pas la rentabilite historique. " +
      "Il renvoie seulement le signal actuel.",
    signal,
    capital: settings.capital,
    lotSize: settings.lots,
    leverage: settings.leverage
  });
}

async function handleAnalyze(request) {
  const url = new URL(request.url);
  const settings = getSettings(url);
  const signal = await getSignal(settings);
  return json(signal, signal.ok === false ? 503 : 200);
}

async function handleHealth() {
  return json({
    ok: true,
    service: CONFIG.SERVICE,
    status: "online",
    instrument: CONFIG.INSTRUMENT,
    strategy: {
      capitalReference: 1000,
      lotsPer1000: CONFIG.LOTS_PER_1000,
      leverage: CONFIG.LEVERAGE,
      targetMove: CONFIG.TARGET_MOVE,
      stopMove: CONFIG.STOP_MOVE,
      minimumScore: CONFIG.MIN_SCORE,
      selectiveSignals: true
    },
    liveTrading: false,
    automaticPushNotifications: false,
    webhookConfigured: true,
    endpoints: [
      "/health",
      "/gold?timeframe=M1",
      "/analyze",
      "/scalp",
      "/backtest"
    ],
    timestamp: new Date().toISOString()
  });
}

async function scheduledCheck(env) {
  const settings = getSettings(new URL(
    "https://worker.invalid/scalp"
  ));

  const signal = await getSignal(settings);

  if (env.TP_STATE) {
    await env.TP_STATE.put(
      "last_signal",
      JSON.stringify(signal),
      { expirationTtl: 7 * 24 * 60 * 60 }
    );
  }

  if (signal.signal !== "ATTENDRE") {
    let shouldAlert = true;

    if (env.TP_STATE) {
      const previous = await env.TP_STATE.get("last_alert");

      if (previous) {
        try {
          const old = JSON.parse(previous);
          const sameSignal =
            old.signal === signal.signal &&
            old.entry === signal.entry;

          const recent =
            Date.now() - old.time < CONFIG.COOLDOWN_MS;

          if (sameSignal && recent) shouldAlert = false;
        } catch {
          // Etat invalide : continuer sans bloquer le signal.
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
          { expirationTtl: 24 * 60 * 60 }
        );
      }
    }
  }

  return signal;
}

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

    try {
      if (path === "/" || path === "/health") {
        return handleHealth();
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
            { expirationTtl: 24 * 60 * 60 }
          );
        }
      })
    );
  }
};
