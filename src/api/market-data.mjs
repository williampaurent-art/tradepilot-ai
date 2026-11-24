import { getMarketAsset, getMarketTimeframe, listMarketAssets } from "../market-data/catalog.mjs";
import { fetchBiQuoteCandles } from "../market-data/biquote.mjs";
import { analyzeTechnical } from "../engines/technical/index.mjs";

const ANALYSIS_TIMEFRAMES = ["M1", "M5", "M15", "H1", "H4"];
const WEIGHTS = Object.freeze({ M1: 10, M5: 15, M15: 25, H1: 25, H4: 25 });

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders }
  });
}

export async function handleMarketDataRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method !== "GET") {
    return json({ ok: false, error: "Méthode non prise en charge." }, 405, { allow: "GET" });
  }

  if (path === "/api/v1/markets") {
    return json({
      ok: true,
      count: listMarketAssets().length,
      markets: listMarketAssets(),
      note: "La présence au catalogue ne garantit pas encore la disponibilité des cotations chez le fournisseur."
    });
  }

  const analysisMatch = path.match(/^\/api\/v1\/markets\/([A-Z0-9._-]+)\/analysis$/i);
  if (analysisMatch) {
    const symbol = analysisMatch[1].toUpperCase();
    const asset = getMarketAsset(symbol);
    if (!asset) return json({ ok: false, error: "Instrument non pris en charge.", symbol }, 404);
    const limit = Number(url.searchParams.get("limit") || 150);
    if (!Number.isInteger(limit) || limit < 55 || limit > 250) {
      return json({ ok: false, error: "Le paramètre limit doit être un entier entre 55 et 250." }, 400);
    }

    const settled = await Promise.allSettled(ANALYSIS_TIMEFRAMES.map(async timeframe => {
      const market = await fetchBiQuoteCandles(symbol, timeframe, limit);
      const technical = analyzeTechnical(market.candles, { minBars: 55 });
      return {
        timeframe, weight: WEIGHTS[timeframe],
        source: market.source, bars: market.count,
        lastCandleAt: market.candles.at(-1)?.time ?? null,
        technical
      };
    }));

    const frames = {};
    const errors = [];
    let weightedScore = 0, totalWeight = 0;
    for (let i = 0; i < ANALYSIS_TIMEFRAMES.length; i++) {
      const timeframe = ANALYSIS_TIMEFRAMES[i];
      const result = settled[i];
      if (result.status !== "fulfilled") {
        frames[timeframe] = { available: false, error: result.reason instanceof Error ? result.reason.message : "Données indisponibles." };
        errors.push(timeframe);
        continue;
      }
      const frame = result.value;
      frames[timeframe] = { available: true, ...frame };
      weightedScore += frame.technical.score * frame.weight;
      totalWeight += frame.weight;
    }

    const score = totalWeight ? Math.round(weightedScore / totalWeight) : null;
    const availableTimeframes = Object.values(frames).filter(frame => frame.available).length;
    const allFramesAvailable = availableTimeframes === ANALYSIS_TIMEFRAMES.length;
    const bias = score === null ? "unavailable" : score >= 60 ? "bullish" : score <= 40 ? "bearish" : "neutral";
    const providerVerified = asset.providerStatus === "existing-integration" || asset.providerStatus === "verified";
    const signalEligible = allFramesAvailable && providerVerified;
    return json({
      ok: true, symbol, category: asset.category, source: "BiQuote",
      generatedAt: new Date().toISOString(),
      timeframes: frames,
      consensus: {
        score, bias, availableTimeframes, requiredTimeframes: ANALYSIS_TIMEFRAMES.length,
        weights: WEIGHTS,
        method: "M1 10%, M5 15%, M15 25%, H1 25%, H4 25%; moyenne pondérée des scores techniques"
      },
      providerStatus: asset.providerStatus,
      signalEligible,
      execution: "NO_ORDERS",
      warnings: [
        ...(!providerVerified ? ["Couverture fournisseur non vérifiée pour cet instrument."] : []),
        ...(errors.length ? ["Données manquantes sur : " + errors.join(", ") + "."] : []),
        "Le consensus est une analyse technique indicative, pas une recommandation ni un ordre de trading."
      ]
    }, 200);
  }

  const match = path.match(/^\/api\/v1\/markets\/([A-Z0-9._-]+)\/candles$/i);
  if (!match) return json({ ok: false, error: "Route Market Data inconnue." }, 404);

  const symbol = match[1].toUpperCase();
  const asset = getMarketAsset(symbol);
  if (!asset) return json({ ok: false, error: "Instrument non pris en charge.", symbol }, 404);

  const timeframe = String(url.searchParams.get("timeframe") || "M15").toUpperCase();
  if (!getMarketTimeframe(timeframe)) {
    return json({ ok: false, error: "Timeframe non pris en charge.", supported: ["M1", "M5", "M15", "H1", "H4", "D1"] }, 400);
  }

  const requestedLimit = Number(url.searchParams.get("limit") || 100);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 30 || requestedLimit > 250) {
    return json({ ok: false, error: "Le paramètre limit doit être un entier entre 30 et 250." }, 400);
  }

  try {
    const result = await fetchBiQuoteCandles(symbol, timeframe, requestedLimit);
    return json({
      ok: true, ...result, providerStatus: asset.providerStatus,
      warning: asset.providerStatus === "not-yet-verified"
        ? "La couverture de cet instrument par le fournisseur doit être vérifiée avant toute utilisation en signal."
        : null
    });
  } catch (error) {
    return json({
      ok: false, symbol, timeframe, source: "BiQuote",
      error: error instanceof Error ? error.message : "Erreur fournisseur inconnue.",
      signalEligible: false
    }, 502);
  }
}
