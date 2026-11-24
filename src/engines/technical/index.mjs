const finite = value => Number.isFinite(value) ? value : null;
const closesOf = candles => candles.map(c => Number(c.close));
const highsOf = candles => candles.map(c => Number(c.high));
const lowsOf = candles => candles.map(c => Number(c.low));

function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.some(c =>
    !c || !Number.isFinite(Number(c.close)) || !Number.isFinite(Number(c.high)) ||
    !Number.isFinite(Number(c.low)) || Number(c.high) < Number(c.low)
  )) throw new TypeError("Une série de bougies OHLC valides est requise.");
}

export function ema(values, period) {
  if (!Array.isArray(values) || !Number.isInteger(period) || period < 1) throw new TypeError("Paramètres EMA invalides.");
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const seed = values.slice(0, period).reduce((a, b) => a + Number(b), 0) / period;
  let previous = seed;
  out[period - 1] = previous;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    previous = Number(values[i]) * alpha + previous * (1 - alpha);
    out[i] = finite(previous);
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = Number(values[i]) - Number(values[i - 1]);
    gain += Math.max(change, 0); loss += Math.max(-change, 0);
  }
  let avgGain = gain / period, avgLoss = loss / period;
  const calc = () => avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  out[period] = calc();
  for (let i = period + 1; i < values.length; i++) {
    const change = Number(values[i]) - Number(values[i - 1]);
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = finite(calc());
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (fast >= slow) throw new TypeError("La période rapide MACD doit être inférieure à la lente.");
  const fastEma = ema(values, fast), slowEma = ema(values, slow);
  const line = values.map((_, i) => fastEma[i] == null || slowEma[i] == null ? null : fastEma[i] - slowEma[i]);
  const validStart = slow - 1;
  const compact = line.slice(validStart);
  const signalCompact = ema(compact, signalPeriod);
  const signal = Array(values.length).fill(null);
  signalCompact.forEach((v, i) => { signal[validStart + i] = v; });
  const histogram = line.map((v, i) => v == null || signal[i] == null ? null : v - signal[i]);
  return { line, signal, histogram };
}

export function bollinger(values, period = 20, deviations = 2) {
  const middle = Array(values.length).fill(null), upper = [...middle], lower = [...middle];
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1).map(Number);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    middle[i] = mean; upper[i] = mean + deviations * sd; lower[i] = mean - deviations * sd;
  }
  return { middle, upper, lower };
}

export function atr(candles, period = 14) {
  const out = Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => {
    const high = Number(c.high), low = Number(c.low);
    if (i === 0) return high - low;
    const previous = Number(candles[i - 1].close);
    return Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous));
  });
  let value = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = value;
  for (let i = period + 1; i < tr.length; i++) {
    value = (value * (period - 1) + tr[i]) / period;
    out[i] = finite(value);
  }
  return out;
}

export function adx(candles, period = 14) {
  const n = candles.length, out = Array(n).fill(null);
  if (n <= period * 2) return out;
  const trs = [], plus = [], minus = [];
  for (let i = 1; i < n; i++) {
    const up = Number(candles[i].high) - Number(candles[i - 1].high);
    const down = Number(candles[i - 1].low) - Number(candles[i].low);
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(Number(candles[i].high) - Number(candles[i].low),
      Math.abs(Number(candles[i].high) - Number(candles[i - 1].close)),
      Math.abs(Number(candles[i].low) - Number(candles[i - 1].close))));
  }
  let tr = trs.slice(0, period).reduce((a,b)=>a+b,0);
  let p = plus.slice(0, period).reduce((a,b)=>a+b,0);
  let m = minus.slice(0, period).reduce((a,b)=>a+b,0);
  const dx = Array(n).fill(null);
  for (let i = period; i < trs.length; i++) {
    if (i > period) { tr = tr - tr / period + trs[i]; p = p - p / period + plus[i]; m = m - m / period + minus[i]; }
    const pdi = tr ? 100 * p / tr : 0, mdi = tr ? 100 * m / tr : 0;
    dx[i + 1] = pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
  }
  const first = period * 2;
  if (n > first) {
    let value = dx.slice(period + 1, first + 1).reduce((a,b)=>a+(b ?? 0),0) / period;
    out[first] = value;
    for (let i = first + 1; i < n; i++) { value = (value * (period - 1) + (dx[i] ?? 0)) / period; out[i] = finite(value); }
  }
  return out;
}

export function supportResistance(candles, lookback = 50, tolerancePct = 0.15) {
  const sample = candles.slice(-lookback);
  if (!sample.length) return { support: null, resistance: null };
  const price = Number(sample.at(-1).close);
  const lows = sample.map(c => Number(c.low)).sort((a,b)=>a-b);
  const highs = sample.map(c => Number(c.high)).sort((a,b)=>a-b);
  const tolerance = Math.abs(price) * tolerancePct / 100;
  const supportCandidates = lows.filter(v => v <= price && price - v <= Math.max(tolerance, Math.abs(price) * 0.02));
  const resistanceCandidates = highs.filter(v => v >= price && v - price <= Math.max(tolerance, Math.abs(price) * 0.02));
  return {
    support: supportCandidates.length ? Math.max(...supportCandidates) : Math.min(...lows),
    resistance: resistanceCandidates.length ? Math.min(...resistanceCandidates) : Math.max(...highs)
  };
}

export function analyzeTechnical(candles, options = {}) {
  validateCandles(candles);
  const minBars = options.minBars ?? 55;
  const closes = closesOf(candles);
  if (candles.length < minBars) return {
    eligible: false, reason: "Historique insuffisant", bars: candles.length, requiredBars: minBars
  };
  const e9 = ema(closes, 9), e20 = ema(closes, 20), e50 = ema(closes, 50);
  const rs = rsi(closes, 14), mc = macd(closes), bb = bollinger(closes, 20, 2);
  const at = atr(candles, 14), ad = adx(candles, 14);
  const i = candles.length - 1, price = closes[i];
  const trend = e9[i] > e20[i] && e20[i] > e50[i] ? "bullish"
    : e9[i] < e20[i] && e20[i] < e50[i] ? "bearish" : "neutral";
  const momentum = mc.histogram[i] > 0 ? "bullish" : mc.histogram[i] < 0 ? "bearish" : "neutral";
  const rsiState = rs[i] >= 70 ? "overbought" : rs[i] <= 30 ? "oversold" : "neutral";
  const direction = trend === "bullish" ? 1 : trend === "bearish" ? -1 : 0;
  const momentumDirection = momentum === "bullish" ? 1 : momentum === "bearish" ? -1 : 0;
  const rsiDirection = rs[i] > 52 && rs[i] < 70 ? 1 : rs[i] < 48 && rs[i] > 30 ? -1 : 0;
  const raw = direction * 50 + momentumDirection * 30 + rsiDirection * 20;
  const score = Math.round(Math.min(100, Math.max(0, 50 + raw / 2)));
  return {
    eligible: true, bars: candles.length, price,
    trend, momentum, rsi: Number(rs[i].toFixed(2)), rsiState,
    macd: { line: mc.line[i], signal: mc.signal[i], histogram: mc.histogram[i] },
    ema: { ema9: e9[i], ema20: e20[i], ema50: e50[i] },
    bollinger: { upper: bb.upper[i], middle: bb.middle[i], lower: bb.lower[i] },
    atr: at[i], adx: ad[i],
    levels: supportResistance(candles),
    score, bias: score >= 60 ? "bullish" : score <= 40 ? "bearish" : "neutral",
    scoreModel: "EMA 50%, MACD 30%, RSI 20%; score indicatif, pas un signal d'exécution"
  };
}
