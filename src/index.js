
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
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function normalizeBars(bars) {
  return bars
    .filter(b => !b.isOpen)
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

  if (previousFast <= previousSlow && fast > slow &&
      rsi14 >= 50 && rsi14 < 70) {
    signal = "ACHAT";
    reason = "Croisement haussier SMA 10/20 et RSI favorable.";
  } else if (previousFast >= previousSlow && fast < slow &&
      rsi14 <= 50 && rsi14 > 30) {
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
    warning: "Signal indicatif, non garanti. Aucun ordre n'est exécuté.",
  };
}

function signalFor(candles, index, strategy, fast, slow, momentum) {
  const close = candles[index].close;

  if (strategy === "trend") {
    if (fast[index] > slow[index] &&
        fast[index - 1] <= slow[index - 1]) return 1;
    if (fast[index] < slow[index] &&
        fast[index - 1] >= slow[index - 1]) return -1;
  }

  if (strategy === "breakout") {
    const previous = candles.slice(index - 20, index);
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

function fullSMA(values, period) {
  return values.map((_, i) => {
    if (i + 1 < period) return null;
    return values.slice(i + 1 - period, i + 1)
      .reduce((sum, n) => sum + n, 0) / period;
  });
}

function fullRSI(values, period = 14) {
  return values.map((_, i) => {
    if (i < period) return null;
    let gains = 0;
    let losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - values[j - 1];
      if (d > 0) gains += d;
      else losses -= d;
    }
    if (losses === 0) return gains === 0 ? 50 : 100;
    return 100 - 100 / (1 + gains / losses);
  });
}

function backtest(candles, strategy, options = {}) {
  if (candles.length < 50) {
    throw new Error("Le backtest exige au moins 50 bougies.");
  }

  const initialCapital = Number(options.capital ?? 10000);
  const riskPercent = Number(options.riskPercent ?? 1);
  const feePercent = Number(options.feePercent ?? 0.02);

  if (!Number.isFinite(initialCapital) || initialCapital <= 0 ||
      !Number.isFinite(riskPercent) || riskPercent <= 0 ||
      riskPercent > 2 || !Number.isFinite(feePercent) ||
      feePercent < 0 || feePercent > 5) {
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
  let peak = capital;
  let maxDrawdown = 0;

  function closePosition(price) {
    const gross = (price - position.entry) *
      position.direction * position.units;
    const fees = (position.entry + price) *
      position.units * feePercent / 100;
    const pnl = gross - fees;
    capital += pnl;
    trades++;
    if (pnl > 0) wins++;
    position = null;
  }

  for (let i = 21; i < candles.length; i++) {
    const c = candles[i];

    // Approximation prudente : si stop et objectif sont touchés
    // dans la même bougie, le stop est considéré touché en premier.
    if (position) {
      const stopHit = position.direction === 1
        ? c.low <= position.stop
        : c.high >= position.stop;
      const targetHit = position.direction === 1
        ? c.high >= position.target
        : c.low <= position.target;

      if (stopHit) closePosition(position.stop);
      else if (targetHit) closePosition(position.target);
    }

    if (!position) {
      const sig = signalFor(candles, i, strategy, fast, slow, momentum);
      if (sig !== 0) {
        const entry = c.close;
        const stopDistance = entry * 0.005;
        const riskMoney = capital * riskPercent / 100;
        const units = riskMoney / stopDistance;

        position = {
          entry,
          direction: sig,
          units,
          stop: entry - sig * stopDistance,
          target: entry + sig * 2 * stopDistance,
        };
      }
    }

    peak = Math.max(peak, capital);
    maxDrawdown = Math.max(maxDrawdown,
      peak > 0 ? (peak - capital) / peak * 100 : 0);
  }

  if (position) closePosition(candles[candles.length - 1].close);

  return {
    strategy,
    startingCapital: initialCapital,
    endingCapital: Number(capital.toFixed(2)),
    netProfit: Number((capital - initialCapital).toFixed(2)),
    returnPercent: Number(((capital / initialCapital - 1) * 100).toFixed(2)),
    trades,
    winRate: trades ? Number((wins / trades * 100).toFixed(2)) : 0,
    maxDrawdownPercent: Number(maxDrawdown.toFixed(2)),
    note: "Prototype. Spread, slippage, gaps et règles du courtier non modélisés.",
  };
}

function compareStrategies(candles, options = {}) {
  return ["trend", "breakout", "reversal"]
    .map(strategy => backtest(candles, strategy, options))
    .sort((a, b) => b.returnPercent - a.returnPercent);
}

function validCandles(candles) {
  return Array.isArray(candles) &&
    candles.every(c =>
      c && [c.open, c.high, c.low, c.close].every(
        n => typeof n === "number" && Number.isFinite(n)
      ) &&
      c.low > 0 &&
      c.high >= Math.max(c.open, c.close) &&
      c.low <= Math.min(c.open, c.close)
    );
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const timeframe = (url.searchParams.get("timeframe") || "M15").toUpperCase();

    if (url.pathname === "/" || url.pathname === "/health") {
      return respond({
        ok: true,
        service: "TradePilot AI",
        status: "online",
        endpoints: ["/health", "/gold?timeframe=M15", "/analyze", "/backtest"],
        timeframes: Object.keys(TIMEFRAMES),
      });
    }

    if (url.pathname === "/backtest") {
      if (request.method !== "POST") {
        return respond({
          ok: false,
          error: "Utilise POST avec un tableau de bougies historiques.",
        }, 405);
      }

      try {
        const body = await request.json();
        if (!validCandles(body.candles) || body.candles.length < 50 ||
            body.candles.length > 10000) {
          return respond({
            ok: false,
            error: "Fournis entre 50 et 10000 bougies OHLC numériques valides.",
            format: {
              candles: [{ open: 4000, high: 4010, low: 3990, close: 4005 }],
              capital: 10000,
              riskPercent: 1,
              feePercent: 0.02,
            },
          }, 400);
        }

        const candles = body.candles;
        const results = compareStrategies(candles, {
          capital: body.capital,
          riskPercent: body.riskPercent,
          feePercent: body.feePercent,
        });

        return respond({
          ok: true,
          instrument: "GOLD / XAUUSD",
          timeframe: body.timeframe || "M15",
          candlesUsed: candles.length,
          results,
          warning: "Simulation historique uniquement, sans garantie de performance.",
        });
      } catch (error) {
        return respond({
          ok: false,
          error: "Impossible d'exécuter le backtest.",
          details: String(error),
        }, 400);
      }
    }

    if (url.pathname === "/gold" || url.pathname === "/analyze") {
      if (!TIMEFRAMES[timeframe]) {
        return respond({
          ok: false,
          error: "Timeframe non supporté.",
          available: Object.keys(TIMEFRAMES),
        }, 400);
      }

      try {
        const interval = TIMEFRAMES[timeframe];
        const upstream = await fetch(
          `https://biquote.io/api/XAUUSD/ohlc?interval=${encodeURIComponent(interval)}&limit=100`,
          { headers: { Accept: "application/json" } }
        );

        if (!upstream.ok) {
          return respond({
            ok: false,
            error: "La source de données a répondu avec une erreur.",
            upstreamStatus: upstream.status,
            timeframe,
          }, 502);
        }

        const data = await upstream.json();
        if (!Array.isArray(data.bars)) {
          return respond({
            ok: false,
            error: "Format de bougies inattendu.",
          }, 502);
        }

        return respond(analyze(data.bars, timeframe));
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
      available: ["/health", "/gold", "/analyze", "/backtest"],
    }, 404);
  },
};

