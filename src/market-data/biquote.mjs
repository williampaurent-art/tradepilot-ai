import { getMarketAsset, getMarketTimeframe } from "./catalog.mjs";

function toTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["bars", "candles", "data", "results", "ohlc"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const key of ["bars", "candles", "data", "results", "ohlc"]) {
    const nested = payload[key];
    if (nested && typeof nested === "object") {
      for (const child of ["bars", "candles", "data", "results", "ohlc"]) {
        if (Array.isArray(nested[child])) return nested[child];
      }
    }
  }
  return null;
}

export function normalizeBiQuoteCandles(payload, timeframe, now = Date.now()) {
  const tf = getMarketTimeframe(timeframe);
  if (!tf) throw new Error("Timeframe non pris en charge.");
  const rows = extractRows(payload);
  if (!rows) throw new Error("Format OHLC BiQuote non reconnu.");

  const byTimestamp = new Map();
  for (const row of rows) {
    const candle = Array.isArray(row) ? {
      time: toTimestamp(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: row[5] == null ? null : Number(row[5]),
      isOpen: false
    } : {
      time: toTimestamp(row?.openTime ?? row?.open_time ?? row?.time ?? row?.timestamp ?? row?.t ?? row?.datetime ?? row?.date),
      open: Number(row?.open ?? row?.o),
      high: Number(row?.high ?? row?.h),
      low: Number(row?.low ?? row?.l),
      close: Number(row?.close ?? row?.c),
      volume: row?.volume == null && row?.v == null ? null : Number(row?.volume ?? row?.v),
      isOpen: row?.isOpen === true || row?.is_open === true
    };
    const valid = Number.isFinite(candle.time) &&
      Number.isFinite(candle.open) && Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) && Number.isFinite(candle.close) &&
      candle.open > 0 && candle.high >= candle.low &&
      candle.high >= Math.max(candle.open, candle.close) &&
      candle.low <= Math.min(candle.open, candle.close) &&
      (candle.volume === null || (Number.isFinite(candle.volume) && candle.volume >= 0));
    if (!valid) continue;
    if (candle.isOpen || candle.time + tf.milliseconds > now) continue;
    byTimestamp.set(candle.time, {
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume
    });
  }

  return [...byTimestamp.values()].sort((a, b) => a.time - b.time);
}

export async function fetchBiQuoteCandles(symbol, timeframe, limit = 100, options = {}) {
  const asset = getMarketAsset(symbol);
  if (!asset) throw new Error("Instrument non autorisé dans le catalogue TradePilot.");
  const tf = getMarketTimeframe(timeframe);
  if (!tf) throw new Error("Timeframe non pris en charge.");

  const safeLimit = Math.min(250, Math.max(30, Math.floor(Number(limit) || 100)));
  const baseUrl = options.baseUrl || "https://biquote.io/api";
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(asset.providerSymbol)}/ohlc`);
  url.searchParams.set("interval", tf.interval);
  url.searchParams.set("limit", String(safeLimit));

  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`Fournisseur BiQuote indisponible (HTTP ${response.status}).`);

  const payload = await response.json();
  const candles = normalizeBiQuoteCandles(payload, timeframe);
  return {
    symbol: asset.symbol,
    timeframe: timeframe.toUpperCase(),
    source: "BiQuote",
    fetchedAt: new Date().toISOString(),
    count: candles.length,
    sufficientHistory: candles.length >= 55,
    candles: candles.slice(-safeLimit)
  };
}
