export const MARKET_TIMEFRAMES = Object.freeze({
  M1: { interval: "1m", milliseconds: 60_000 },
  M5: { interval: "5m", milliseconds: 300_000 },
  M15: { interval: "15m", milliseconds: 900_000 },
  H1: { interval: "1h", milliseconds: 3_600_000 },
  H4: { interval: "4h", milliseconds: 14_400_000 },
  D1: { interval: "1d", milliseconds: 86_400_000 }
});

// Symbols are catalogued independently from provider availability.
// A catalog entry is not proof that a data vendor currently covers the instrument.
const ASSETS = [
  ["EURUSD", "Forex", "EUR/USD", "Euro / US dollar"],
  ["GBPUSD", "Forex", "GBP/USD", "British pound / US dollar"],
  ["USDJPY", "Forex", "USD/JPY", "US dollar / Japanese yen"],
  ["XAUUSD", "Metals", "XAU/USD", "Gold / US dollar"],
  ["XAGUSD", "Metals", "XAG/USD", "Silver / US dollar"],
  ["NAS100", "Indices", "NAS100", "Nasdaq 100"],
  ["US30", "Indices", "US30", "Dow Jones Industrial Average"],
  ["SPX500", "Indices", "SPX500", "S&P 500"],
  ["BTCUSD", "Crypto", "BTC/USD", "Bitcoin / US dollar"],
  ["ETHUSD", "Crypto", "ETH/USD", "Ether / US dollar"]
].map(([symbol, category, displaySymbol, name]) => Object.freeze({
  symbol, category, displaySymbol, name,
  enabled: true,
  provider: "biquote",
  providerSymbol: symbol,
  providerStatus: symbol === "XAUUSD" ? "existing-integration" : "not-yet-verified"
}));

const ASSET_BY_SYMBOL = new Map(ASSETS.map(asset => [asset.symbol, asset]));

export function listMarketAssets() {
  return ASSETS.map(asset => ({ ...asset }));
}

export function getMarketAsset(symbol) {
  if (typeof symbol !== "string") return null;
  return ASSET_BY_SYMBOL.get(symbol.trim().toUpperCase()) || null;
}

export function getMarketTimeframe(timeframe) {
  if (typeof timeframe !== "string") return null;
  return MARKET_TIMEFRAMES[timeframe.trim().toUpperCase()] || null;
}
