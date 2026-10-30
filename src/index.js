
const CONFIG = {
  SERVICE: "TradePilot AI",
  SYMBOL: "XAUUSD",
  SOURCE_URL: "https://biquote.io/api/XAUUSD/ohlc",

  CAPITAL: 1000,
  LOTS_PER_1000: 0.5,
  LEVERAGE: 500,

  TARGET: 2,
  STOP: 7,
  MIN_SCORE: 75,

  MAX_CANDLES: 250,
  COOLDOWN_MS: 5 * 60 * 1000,

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

function getSettings(url) {
  const number = (name, fallback, min, max) => {
    const value = Number(url.searchParams.get(name));
    return Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  };

  const capital = number("capital", CONFIG.CAPITAL, 1, 100000000);

  return {
    capital,
    target: number("target", CONFIG.TARGET, 0.01, 1000),
    stop: number("stopDistance", CONFIG.STOP, 0.01, 1000),
    minScore: number("minScore", CONFIG.MIN_SCORE, 50, 100),
    lots: Number(((capital / 1000) * CONFIG.LOTS_PER_1000).toFixed(4))
  };
}

// --------------------------------------------------
// NORMALISATION DES DONNEES
// --------------------------------------------------

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

    return Date.parse(value);
  }

  return NaN;
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;

  const keys = ["bars", "candles", "data", "results", "ohlc"];

  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  for (const key of keys) {
    const nested = payload[key];

    if (nested && typeof nested === "object") {
      for (const child of keys) {
        if (Array.isArray(nested[child])) return nested[child];
      }
    }
  }

  return null;
}

function normalizeBars(payload) {
  const rows = extractRows(payload);

  if (!rows) {
    throw new Error("Format OHLC non reconnu.");
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
        row.openTime ?? row.open_time ??
        row.time ?? row.timestamp ??
        row.t ?? row.datetime ?? row.date
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
    if (unique.length && unique[unique.length - 1].time === bar.time) {
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
    throw new Error(`Erreur source OHLC : HTTP ${response.status}`);
  }

  const payload = await response.json();
  const bars = normalizeBars(payload);

  const now = Date.now();

  // Hypothese : le timestamp indique le debut de la bougie.
  const closed = bars.filter(bar =>
    !bar.isOpen && bar.time + tf.ms <= now
  );

  if (closed.length < 55) {
    throw new Error(
      `Historique insuffisant pour ${timeframe} : ${closed.length} bougies.`
    );
  }

  return closed.slice(-Math.min(limit, CONFIG.MAX_CANDLES));
}

// --------------------------------------------------
// FRAICHEUR ET CONTINUITE
// --------------------------------------------------

function inspectDataQuality(bars, timeframe) {
  const tf = TIMEFRAMES[timeframe];
  const last = bars[bars.length - 1];

  if (!tf || !last || bars.length < 30) {
    return { ok: false, reason: "Historique insuffisant" };
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

  return {
    ok: fresh && gaps.length === 0,
    fresh,
    ageMs,
    maxAgeMs,
    gapCount: gaps.length,
    gaps
  };
}

// --------------------------------------------------
// INDICATEURS
// --------------------------------------------------

function sma(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);

  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let result = sma(values.slice(0, period), period);

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

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
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

function getIndicators(bars) {
  const closes = bars.map(bar => bar.close);

  return {
    price: closes[closes.length - 1],
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

// --------------------------------------------------
// ANALYSE DU MARCHE
// --------------------------------------------------

function analyzeSetup(m1, m5, m15, settings) {
  const i1 = getIndicators(m1);
  const i5 = getIndicators(m5);
  const i15 = getIndicators(m15);

  const t1 = getTrend(i1);
  const t5 = getTrend(i5);
  const t15 = getTrend(i15);

  let buyScore = 0;
  let sellScore = 0;

  const buyReasons = [];
  const sellReasons = [];

  if (t15 === "HAUSSIER") {
    buyScore += 20;
    buyReasons.push("Tendance M15 haussiere");
  }

  if (t5 === "HAUSSIER") {
    buyScore += 20;
    buyReasons.push("Tendance M5 haussiere");
  }

  if (t1 === "HAUSSIER") {
    buyScore += 20;
    buyReasons.push("Tendance M1 haussiere");
  }

  if (t15 === "BAISSIER") {
    sellScore += 20;
    sellReasons.push("Tendance M15 baissiere");
  }

  if (t5 === "BAISSIER") {
    sellScore += 20;
    sellReasons.push("Tendance M5 baissiere");
  }

  if (t1 === "BAISSIER") {
    sellScore += 20;
    sellReasons.push("Tendance M1 baissiere");
  }

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

  const last = m1[m1.length - 1];
  const previous = m1[m1.length - 2];

  if (last.close > previous.high && t1 === "HAUSSIER") {
    buyScore += 15;
    buyReasons.push("Cassure du dernier plus haut");
  }

  if (last.close < previous.low && t1 === "BAISSIER") {
    sellScore += 15;
    sellReasons.push("Cassure du dernier plus bas");
  }

  const atrPercent = i1.atr !== null && i1.price > 0
    ? (i1.atr / i1.price) * 100
    : null;

  let volatility = "NORMALE";

  if (atrPercent === null) {
    volatility = "INDISPONIBLE";
  } else if (atrPercent < 0.001) {
    volatility = "TROP FAIBLE";
  } else if (atrPercent > 0.25) {
    volatility = "TROP ELEVEE";
  }

  const volatilityAllowed = volatility === "NORMALE";

  if (!volatilityAllowed) {
    buyScore = Math.min(buyScore, 49);
    sellScore = Math.min(sellScore, 49);
  }

  if (t5 !== t15 || t5 === "NEUTRE") {
    buyScore = Math.min(buyScore, 69);
    sellScore = Math.min(sellScore, 69);
  }

  buyScore = Math.min(100, buyScore);
  sellScore = Math.min(100, sellScore);

  let signal = "ATTENDRE";
  let score = Math.max(buyScore, sellScore);
  let reasons = ["Aucune configuration valide."];
  let targetPrice = null;
  let stopPrice = null;

  const entry = i1.price;

  if (buyScore >= settings.minScore && buyScore > sellScore) {
    signal = "ACHAT";
    score = buyScore;
    reasons = buyReasons;
    targetPrice = entry + settings.target;
    stopPrice = entry - settings.stop;
  } else if (sellScore >= settings.minScore && sellScore > buyScore) {
    signal = "VENTE";
    score = sellScore;
    reasons = sellReasons;
    targetPrice = entry - settings.target;
    stopPrice = entry + settings.stop;
  }

  const round = value => Number(value.toFixed(2));

  return {
    ok: true,
    instrument: CONFIG.SYMBOL,
    signal,
    score,
    entry: round(entry),
    targetMove: settings.target,
    stopMove: settings.stop,
    targetPrice: targetPrice === null ? null : round(targetPrice),
    stopPrice: stopPrice === null ? null : round(stopPrice),
    capital: settings.capital,
    lotSize: settings.lots,
    leverage: CONFIG.LEVERAGE,
    riskReward: Number((settings.target / settings.stop).toFixed(3)),
    market: {
      trendM1: t1,
      trendM5: t5,
      trendM15: t15,
      rsiM1: i1.rsi === null ? null : Number(i1.rsi.toFixed(2)),
      rsiM5: i5.rsi === null ? null : Number(i5.rsi.toFixed(2)),
      atrM1: i1.atr === null ? null : Number(i1.atr.toFixed(4)),
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

async function getSignal(settings) {
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

  return result;
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
    signal: AbortSignal.timeout(10000)
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
  const reasons = signal.reasons.map(reason => `• ${reason}`).join("\n");

  return [
    `🚨 TRADEPILOT AI — ${signal.instrument}`,
    "",
    `📊 SIGNAL : ${signal.signal}`,
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
  if (!env.TP_STATE) return null;

  try {
    return await env.TP_STATE.get(key);
  } catch {
    return null;
  }
}

async function writeKV(env, key, value, ttl = 86400) {
  if (!env.TP_STATE) return false;

  try {
    await env.TP_STATE.put(key, JSON.stringify(value), {
      expirationTtl: ttl
    });

    return true;
  } catch {
    return false;
  }
}

function getAlertKey(signal) {
  return [
    signal.signal,
    signal.entry,
    signal.targetPrice,
    signal.stopPrice
  ].join("_");
}

async function shouldSendAlert(env, signal) {
  const previousRaw = await readKV(env, "last_alert");

  if (!previousRaw) return true;

  try {
    const previous = JSON.parse(previousRaw);

    const sameSignal = previous.key === getAlertKey(signal);
    const recent = Date.now() - previous.time < CONFIG.COOLDOWN_MS;

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

    const signal = await getSignal(settings);

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
    // Les donnees KV invalides ne bloquent pas le diagnostic.
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

async function handleAnalyze(request) {
  const settings = getSettings(new URL(request.url));
  const signal = await getSignal(settings);

  return json(signal, signal.ok ? 200 : 503);
}

async function handleScalp(request, env) {
  const settings = getSettings(new URL(request.url));
  const signal = await getSignal(settings);

  if (!signal.ok || signal.signal === "ATTENDRE") {
    return json({
      ...signal,
      alert: { sent: false, reason: "Aucun signal valide." }
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
      alert: { sent: false, error: error.message }
    }, 502);
  }
}

async function handleTelegramTest(request, env) {
  if (!env.TELEGRAM_TEST_KEY) {
    return json({ ok: false, error: "TELEGRAM_TEST_KEY absent." }, 503);
  }

  const url = new URL(request.url);
  const suppliedKey = url.searchParams.get("key");

  if (suppliedKey !== env.TELEGRAM_TEST_KEY) {
    return json({ ok: false, error: "Cle de test invalide." }, 403);
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
    return json({ ok: false, error: error.message }, 502);
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
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    if (request.method !== "GET") {
      return json({ ok: false, error: "Methode non prise en charge." }, 405);
    }

    try {
      if (path === "/" || path === "/health") {
        return await handleHealth(env);
      }

      if (path === "/status") {
        return await handleStatus(env);
      }

      if (path === "/analyze") {
        return await handleAnalyze(request);
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
          "/analyze",
          "/scalp",
          "/telegram-test?key=VOTRE_CLE"
        ]
      }, 404);

    } catch (error) {
      return json({
        ok: false,
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

