
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

function normalizeBars(bars) {
  if (!Array.isArray(bars)) return [];

  return bars
    .filter(b => b && !b.isOpen)
    .map(b => ({
      time: b.openTime,
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
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

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

  const closes = candles.map(b => b.close);
  const last = candles[candles.length - 1];

  const fast = sma(closes, 10);
  const slow = sma(closes, 20);
  const previousFast = sma(closes.slice(0, -1), 10);
  const previousSlow = sma(closes.slice(0, -1), 20);
  const rsi14 = rsi(closes);

  let signal = "ATTENDRE";
  let reason = "Aucun croisement confirmé avec les filtres RSI.";

  if (
    previousFast <= previousSlow &&
    fast > slow &&
    rsi14 >= 50 &&
    rsi14 < 70
  ) {
    signal = "ACHAT";
    reason = "Croisement haussier SMA 10/20 et RSI favorable.";
  } else if (
    previousFast >= previousSlow &&
    fast < slow &&
    rsi14 <= 50 &&
    rsi14 > 30
  ) {
    signal = "VENTE";
    reason = "Croisement baissier SMA 10/20 et RSI favorable.";
  }

  let stopLoss = null;
  let takeProfit = null;

  const recent = candles.slice(-14);
  const recentLow = Math.min(...recent.map(b => b.low));
  const recentHigh = Math.max(...recent.map(b => b.high));

  if (signal === "ACHAT") {
    stopLoss = recentLow;

    if (stopLoss >= last.close) {
      signal = "ATTENDRE";
      reason = "Stop-loss invalide.";
      stopLoss = null;
    } else {
      takeProfit = last.close + 2 * (last.close - stopLoss);
    }
  } else if (signal === "VENTE") {
    stopLoss = recentHigh;

    if (stopLoss <= last.close) {
      signal = "ATTENDRE";
      reason = "Stop-loss invalide.";
      stopLoss = null;
    } else {
      takeProfit = last.close - 2 * (stopLoss - last.close);
    }
  }

  return {
    ok: true,
    instrument: "GOLD / XAUUSD",
    timeframe,
    source: "biquote",
    updatedAt: new Date().toISOString(),
    lastClosedCandle: last.time,
    price: last.close,
    indicators: {
      SMA10: Number(fast.toFixed(4)),
      SMA20: Number(slow.toFixed(4)),
      RSI14: Number(rsi14.toFixed(2)),
    },
    signal,
    reason,
    stopLoss: stopLoss === null ? null : Number(stopLoss.toFixed(4)),
    takeProfit: takeProfit === null ? null : Number(takeProfit.toFixed(4)),
    riskReward: takeProfit === null ? null : "1:2",
    candlesAnalyzed: candles.length,
    warning:
      "Signal indicatif, non garanti. Aucun ordre n'est exécuté.",
  };
}

function fullSMA(values, period) {
  return values.map((_, i) => {
    if (i + 1 < period) return null;

    return values
      .slice(i + 1 - period, i + 1)
      .reduce((sum, n) => sum + n, 0) / period;
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
    if (
      fast[index] !== null &&
      slow[index] !== null &&
      fast[index - 1] !== null &&
      slow[index - 1] !== null
    ) {
      if (
        fast[index] > slow[index] &&
        fast[index - 1] <= slow[index - 1]
      ) return 1;

      if (
        fast[index] < slow[index] &&
        fast[index - 1] >= slow[index - 1]
      ) return -1;
    }
  }

  if (strategy === "breakout") {
    const previous = candles.slice(index - 20, index);

    if (previous.length < 20) return 0;

    const high = Math.max(...previous.map(c => c.high));
    const low = Math.min(...previous.map(c => c.low));

    if (close > high) return 1;
    if (close < low) return -1;
  }

  if (strategy === "reversal") {
    if (momentum[index] !== null && momentum[index] < 30) return 1;
    if (momentum[index] !== null && momentum[index] > 70) return -1;
  }

  return 0;
}

function validCandles(candles) {
  return Array.isArray(candles) &&
    candles.every(c =>
      c &&
      [c.open, c.high, c.low, c.close].every(
        n => typeof n === "number" && Number.isFinite(n)
      ) &&
      c.low > 0 &&
      c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close)
    );
}

function backtest(candles, strategy, options = {}) {
  if (candles.length < 50) {
    throw new Error("Le backtest exige au moins 50 bougies.");
  }

  const initialCapital = Number(options.capital ?? 10000);
  const riskPercent = Number(options.riskPercent ?? 1);
  const feePercent = Number(options.feePercent ?? 0.02);

  if (
    !Number.isFinite(initialCapital) ||
    initialCapital <= 0 ||
    !Number.isFinite(riskPercent) ||
    riskPercent <= 0 ||
    riskPercent > 2 ||
    !Number.isFinite(feePercent) ||
    feePercent < 0 ||
    feePercent > 5
  ) {
    throw new Error("Paramètres de capital, risque ou frais invalides.");
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
    const gross =
      (price - position.entry) * position.direction * position.units;

    const fees =
      (position.entry + price) * position.units * feePercent / 100;

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

      // Si stop et cible sont touchés dans la même bougie,
      // on retient l'hypothèse prudente : le stop est touché en premier.
      if (stopHit) {
        closePosition(position.stop);
      } else if (targetHit) {
        closePosition(position.target);
      }
    }

    if (!position) {
      const signal = signalFor(
        candles, i, strategy, fast, slow, momentum
      );

      if (signal !== 0) {
        const entry = candle.close;
        const stopDistance = entry * 0.005;
        const riskMoney = capital * riskPercent / 100;
        const units = riskMoney / stopDistance;

        position = {
          entry,
          direction: signal,
          units,
          stop: entry - signal * stopDistance,
          target: entry + signal * 2 * stopDistance,
        };
      }
    }

    peak = Math.max(peak, capital);

    maxDrawdown = Math.max(
      maxDrawdown,
      peak > 0 ? (peak - capital) / peak * 100 : 0
    );
  }

  if (position) {
    closePosition(candles[candles.length - 1].close);
  }

  return {
    strategy,
    startingCapital: initialCapital,
    endingCapital: Number(capital.toFixed(2)),
    netProfit: Number((capital - initialCapital).toFixed(2)),
    returnPercent: Number(
      ((capital / initialCapital - 1) * 100).toFixed(2)
    ),
    trades,
    wins,
    losses: trades - wins,
    winRate: trades ? Number((wins / trades * 100).toFixed(2)) : 0,
    profitFactor: grossLoss > 0
      ? Number((grossProfit / grossLoss).toFixed(2))
      : grossProfit > 0 ? null : 0,
    maxDrawdownPercent: Number(maxDrawdown.toFixed(2)),
    note:
      "Prototype : spread réel, slippage, gaps, taille de contrat et " +
      "règles du courtier non entièrement modélisés.",
  };
}

function compareStrategies(candles, options = {}) {
  return ["trend", "breakout", "reversal"]
    .map(strategy => backtest(candles, strategy, options))
    .sort((a, b) => b.returnPercent - a.returnPercent);
}

async function fetchGoldCandles(timeframe, limit = 200) {
  const interval = TIMEFRAMES[timeframe];

  const upstream = await fetch(
    `https://biquote.io/api/XAUUSD/ohlc?interval=${encodeURIComponent(interval)}&limit=${limit}`,
    { headers: { Accept: "application/json" } }
  );

  if (!upstream.ok) {
    throw new Error(
      `La source BiQuote a répondu avec le statut ${upstream.status}.`
    );
  }

  const data = await upstream.json();

  if (!Array.isArray(data.bars)) {
    throw new Error("Format de bougies inattendu depuis BiQuote.");
  }

  return normalizeBars(data.bars);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS,
      });
    }

    const url = new URL(request.url);
    const timeframe = (
      url.searchParams.get("timeframe") || "M15"
    ).toUpperCase();

    if (url.pathname === "/" || url.pathname === "/health") {
      return respond({
        ok: true,
        service: "TradePilot AI",
        status: "online",
        endpoints: [
          "/health",
          "/gold?timeframe=M15",
          "/analyze?timeframe=M15",
          "/backtest?timeframe=M15",
          "/chat",
        ],
        timeframes: Object.keys(TIMEFRAMES),
        backtestMethods: ["GET", "POST"],
        liveTrading: false,
      });
    }

    if (url.pathname === "/gold" || url.pathname === "/analyze") {
      if (request.method !== "GET") {
        return respond({
          ok: false,
          error: "Utilise GET pour cette route.",
        }, 405);
      }

      if (!TIMEFRAMES[timeframe]) {
        return respond({
          ok: false,
          error: "Timeframe non supporté.",
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

    if (url.pathname === "/backtest") {
      try {
        let body;

        if (request.method === "GET") {
          if (!TIMEFRAMES[timeframe]) {
            return respond({
              ok: false,
              error: "Timeframe non supporté.",
              available: Object.keys(TIMEFRAMES),
            }, 400);
          }

          const requestedLimit = Number(
            url.searchParams.get("limit") || 200
          );

          if (
            !Number.isInteger(requestedLimit) ||
            requestedLimit < 50 ||
            requestedLimit > 10000
          ) {
            return respond({
              ok: false,
              error: "Le paramètre limit doit être compris entre 50 et 10000.",
            }, 400);
          }

          const candles = await fetchGoldCandles(
            timeframe,
            requestedLimit
          );

          body = {
            candles,
            timeframe,
            capital: url.searchParams.get("capital") ?? 10000,
            riskPercent: url.searchParams.get("riskPercent") ?? 1,
            feePercent: url.searchParams.get("feePercent") ?? 0.02,
          };
        } else if (request.method === "POST") {
          body = await request.json();
        } else {
          return respond({
            ok: false,
            error: "Utilise GET ou POST pour le backtest.",
          }, 405);
        }

        if (
          !validCandles(body.candles) ||
          body.candles.length < 50 ||
          body.candles.length > 10000
        ) {
          return respond({
            ok: false,
            error: "Il faut entre 50 et 10000 bougies OHLC numériques valides.",
            received: Array.isArray(body.candles)
              ? body.candles.length
              : 0,
          }, 400);
        }

        const results = compareStrategies(body.candles, {
          capital: body.capital,
          riskPercent: body.riskPercent,
          feePercent: body.feePercent,
        });

        return respond({
          ok: true,
          instrument: "GOLD / XAUUSD",
          source: body.timeframe ? "biquote" : "provided-candles",
          timeframe: body.timeframe || "M15",
          candlesUsed: body.candles.length,
          results,
          warning:
            "Simulation historique uniquement. Le spread, le slippage, " +
            "les gaps et les règles du courtier ne sont pas entièrement " +
            "modélisés. Résultats non garantis.",
        });
      } catch (error) {
        return respond({
          ok: false,
          error: "Impossible d'exécuter le backtest.",
          details: String(error),
        }, 400);
      }
    }

    if (url.pathname === "/chat") {
      if (request.method !== "POST") {
        return respond({
          ok: false,
          error: "Utilise POST avec un message.",
        }, 405);
      }

      if (!env || !env.OPENAI_API_KEY) {
        return respond({
          ok: false,
          error: "Le secret OPENAI_API_KEY est absent de Cloudflare.",
        }, 500);
      }

      try {
        const body = await request.json();

        if (
          typeof body.message !== "string" ||
          !body.message.trim() ||
          body.message.length > 4000
        ) {
          return respond({
            ok: false,
            error: "Le message doit contenir entre 1 et 4000 caractères.",
          }, 400);
        }

        const aiResponse = await fetch(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4.1-mini",
              instructions:
                "Tu es TradePilot AI, un assistant spécialisé en analyse " +
                "technique et stratégies de trading XAUUSD. Réponds en " +
                "français. Explique les indicateurs, les stratégies, les " +
                "backtests et la gestion du risque. Ne prétends pas connaître " +
                "les prix en temps réel si aucune donnée ne t'a été fournie. " +
                "Ne garantis aucun profit. Distingue les faits des hypothèses. " +
                "Tu ne passes aucun ordre réel.",
              input: body.message.trim(),
              max_output_tokens: 800,
            }),
          }
        );

        const result = await aiResponse.json();

        if (!aiResponse.ok) {
          return respond({
            ok: false,
            error: "L'API OpenAI a refusé la requête.",
            details: result.error?.message || "Erreur API.",
          }, 502);
        }

        const reply = (result.output || [])
          .filter(item => item.type === "message")
          .flatMap(item => item.content || [])
          .filter(item => item.type === "output_text")
          .map(item => item.text)
          .join("\n");

        if (!reply) {
          return respond({
            ok: false,
            error: "L'IA n'a renvoyé aucune réponse textuelle.",
          }, 502);
        }

        return respond({
          ok: true,
          reply,
        });
      } catch (error) {
        return respond({
          ok: false,
          error: "Impossible de contacter l'IA.",
          details: String(error),
        }, 502);
      }
    }

    return respond({
      ok: false,
      error: "Route introuvable.",
      available: [
        "/health",
        "/gold",
        "/analyze",
        "/backtest",
        "/chat",
      ],
    }, 404);
  },
};
