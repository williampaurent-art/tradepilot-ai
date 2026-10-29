const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function sma(values, period) {
  if (values.length < period) return null;

  const recent = values.slice(-period);
  return recent.reduce((sum, value) => sum + value, 0) / period;
}

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0) return gains === 0 ? 50 : 100;

  const averageGain = gains / period;
  const averageLoss = losses / period;
  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

function normalizeCandles(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((candle) => ({
      time: candle.time ?? candle.timestamp ?? candle.datetime ?? null,
      open: Number(candle.open ?? candle.o),
      high: Number(candle.high ?? candle.h),
      low: Number(candle.low ?? candle.l),
      close: Number(candle.close ?? candle.c),
    }))
    .filter((c) =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low &&
      c.high >= c.open &&
      c.high >= c.close &&
      c.low <= c.open &&
      c.low <= c.close &&
      c.close > 0
    )
    .sort((a, b) => {
      if (!a.time || !b.time) return 0;
      return new Date(a.time).getTime() - new Date(b.time).getTime();
    });
}

function analyzeCandles(rawCandles) {
  const candles = normalizeCandles(rawCandles);

  if (candles.length < 30) {
    return {
      ok: false,
      error: "Pas assez de bougies pour analyser le marché.",
      required: 30,
      received: candles.length,
    };
  }

  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];

  const sma10 = sma(closes, 10);
  const sma20 = sma(closes, 20);
  const previousSma10 = sma(closes.slice(0, -1), 10);
  const previousSma20 = sma(closes.slice(0, -1), 20);
  const rsi14 = calculateRSI(closes, 14);

  let signal = "ATTENDRE";
  let reason = "Les conditions ne confirment pas de signal suffisamment clair.";

  const bullishCross =
    previousSma10 !== null &&
    previousSma20 !== null &&
    previousSma10 <= previousSma20 &&
    sma10 > sma20;

  const bearishCross =
    previousSma10 !== null &&
    previousSma20 !== null &&
    previousSma10 >= previousSma20 &&
    sma10 < sma20;

  if (bullishCross && rsi14 !== null && rsi14 >= 50 && rsi14 < 70) {
    signal = "ACHAT";
    reason = "Croisement haussier SMA 10/20 avec RSI entre 50 et 70.";
  } else if (
    bearishCross &&
    rsi14 !== null &&
    rsi14 <= 50 &&
    rsi14 > 30
  ) {
    signal = "VENTE";
    reason = "Croisement baissier SMA 10/20 avec RSI entre 30 et 50.";
  }

  const recent = candles.slice(-14);
  const recentLow = Math.min(...recent.map((c) => c.low));
  const recentHigh = Math.max(...recent.map((c) => c.high));

  let stopLoss = null;
  let takeProfit = null;
  let riskReward = null;

  if (signal === "ACHAT") {
    stopLoss = recentLow;
    const risk = last.close - stopLoss;

    if (risk > 0) {
      takeProfit = last.close + risk * 2;
      riskReward = "1:2";
    } else {
      signal = "ATTENDRE";
      reason = "Risque invalide : aucun achat proposé.";
    }
  } else if (signal === "VENTE") {
    stopLoss = recentHigh;
    const risk = stopLoss - last.close;

    if (risk > 0) {
      takeProfit = last.close - risk * 2;
      riskReward = "1:2";
    } else {
      signal = "ATTENDRE";
      reason = "Risque invalide : aucune vente proposée.";
    }
  }

  return {
    ok: true,
    instrument: "GOLD / XAUUSD",
    timeframe: "M15",
    candleCount: candles.length,
    lastCandleTime: last.time,
    lastClose: last.close,
    indicators: {
      SMA10: Number(sma10.toFixed(4)),
      SMA20: Number(sma20.toFixed(4)),
      RSI14: Number(rsi14.toFixed(2)),
    },
    signal,
    reason,
    stopLoss: stopLoss === null ? null : Number(stopLoss.toFixed(4)),
    takeProfit: takeProfit === null ? null : Number(takeProfit.toFixed(4)),
    riskReward,
    disclaimer:
      "Signal technique indicatif, non garanti. Vérifier la fraîcheur des bougies, le spread, les frais et le risque avant toute décision.",
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "TradePilot AI",
        status: "online",
        endpoints: {
          health: "/health",
          analyze: "/analyze",
        },
        note:
          "L'analyse nécessite des bougies M15 valides envoyées à /analyze.",
      });
    }

    if (url.pathname === "/analyze") {
      if (request.method !== "POST") {
        return json(
          {
            ok: false,
            error: "Utilisez POST avec un tableau JSON de bougies.",
            example: {
              candles: [
                {
                  time: "2026-10-27T10:00:00Z",
                  open: 4000,
                  high: 4005,
                  low: 3998,
                  close: 4003,
                },
              ],
            },
          },
          405
        );
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "JSON invalide." }, 400);
      }

      const candles = body.candles;

      if (!Array.isArray(candles)) {
        return json(
          {
            ok: false,
            error: "Le champ candles doit être un tableau de bougies OHLC.",
          },
          400
        );
      }

      return json(analyzeCandles(candles));
    }

    return json(
      {
        ok: false,
        error: "Route introuvable.",
        availableRoutes: ["/health", "/analyze"],
      },
      404
    );
  },
};
