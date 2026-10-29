
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function analyze(bars) {
  const candles = bars
    .filter((b) => !b.isOpen)
    .map((b) => ({
      time: b.openTime,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    }))
    .filter((b) =>
      [b.open, b.high, b.low, b.close].every(Number.isFinite) &&
      b.low > 0 &&
      b.high >= Math.max(b.open, b.close) &&
      b.low <= Math.min(b.open, b.close)
    )
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  if (candles.length < 30) {
    return {
      ok: false,
      error: "Pas assez de bougies clôturées.",
      received: candles.length,
      required: 30,
    };
  }

  const closes = candles.map((b) => b.close);
  const last = candles[candles.length - 1];
  const fast = sma(closes, 10);
  const slow = sma(closes, 20);
  const previousFast = sma(closes.slice(0, -1), 10);
  const previousSlow = sma(closes.slice(0, -1), 20);
  const rsi14 = rsi(closes);

  let signal = "ATTENDRE";
  let reason = "Aucun croisement confirmé avec les filtres RSI.";

  const crossUp = previousFast <= previousSlow && fast > slow;
  const crossDown = previousFast >= previousSlow && fast < slow;

  if (crossUp && rsi14 >= 50 && rsi14 < 70) {
    signal = "ACHAT";
    reason = "Croisement haussier SMA 10/20 et RSI favorable.";
  } else if (crossDown && rsi14 <= 50 && rsi14 > 30) {
    signal = "VENTE";
    reason = "Croisement baissier SMA 10/20 et RSI favorable.";
  }

  let stopLoss = null;
  let takeProfit = null;

  const recent = candles.slice(-14);
  const recentLow = Math.min(...recent.map((b) => b.low));
  const recentHigh = Math.max(...recent.map((b) => b.high));

  if (signal === "ACHAT") {
    stopLoss = recentLow;
    if (stopLoss >= last.close) {
      signal = "ATTENDRE";
      reason = "Stop-loss invalide : signal annulé.";
      stopLoss = null;
    } else {
      takeProfit = last.close + 2 * (last.close - stopLoss);
    }
  }

  if (signal === "VENTE") {
    stopLoss = recentHigh;
    if (stopLoss <= last.close) {
      signal = "ATTENDRE";
      reason = "Stop-loss invalide : signal annulé.";
      stopLoss = null;
    } else {
      takeProfit = last.close - 2 * (stopLoss - last.close);
    }
  }

  return {
    ok: true,
    instrument: "GOLD / XAUUSD",
    timeframe: "M15",
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
      "Signal indicatif, non garanti. Vérifier le spread, les frais et la fraîcheur des données. Aucun ordre n'est exécuté.",
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return respond({
        ok: true,
        service: "TradePilot AI",
        status: "online",
        endpoints: ["/health", "/gold", "/analyze"],
      });
    }

    if (url.pathname === "/gold" || url.pathname === "/analyze") {
      try {
        const upstream = await fetch(
          "https://biquote.io/api/XAUUSD/ohlc?interval=15m&limit=100",
          {
            headers: { Accept: "application/json" },
          }
        );

        if (!upstream.ok) {
          return respond({
            ok: false,
            error: "La source de données a répondu avec une erreur.",
            upstreamStatus: upstream.status,
          }, 502);
        }

        const data = await upstream.json();

        if (!Array.isArray(data.bars)) {
          return respond({
            ok: false,
            error: "Format de bougies inattendu.",
          }, 502);
        }

        return respond(analyze(data.bars));
      } catch (error) {
        return respond({
          ok: false,
          error: "Impossible de récupérer les données GOLD.",
          details: String(error),
        }, 502);
      }
    }

    return respond({
      ok: false,
      error: "Route introuvable.",
      available: ["/health", "/gold", "/analyze"],
    }, 404);
  },
};
