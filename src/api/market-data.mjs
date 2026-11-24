import { getMarketAsset, getMarketTimeframe, listMarketAssets } from "../market-data/catalog.mjs";
import { fetchBiQuoteCandles } from "../market-data/biquote.mjs";

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
      ok: true,
      ...result,
      providerStatus: asset.providerStatus,
      warning: asset.providerStatus === "not-yet-verified"
        ? "La couverture de cet instrument par le fournisseur doit être vérifiée avant toute utilisation en signal."
        : null
    });
  } catch (error) {
    return json({
      ok: false,
      symbol,
      timeframe,
      source: "BiQuote",
      error: error instanceof Error ? error.message : "Erreur fournisseur inconnue.",
      signalEligible: false
    }, 502);
  }
}
