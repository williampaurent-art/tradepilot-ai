# XAUUSD M15 single-candle impulse backtest

## Locked hypothesis
- XAUUSD, M15.
- Signal: a completed candle whose body (close minus open) is at least +$5 or at most -$5.
- Entry: next M15 candle open, in the impulse direction.
- Take profit: $1. Primary stop-loss: $3.
- Maximum holding time: 4 M15 bars (one hour); otherwise close at the final close.
- If TP and SL are both touched in one M15 bar, assume SL first.
- One open trade at a time; no overlapping positions.
- Default costs: $0.20 spread round trip (half on entry and exit), $0.05 slippage each side, zero commission. Replace with the target broker's real values.

## Comparisons
The module compares stop distances $1/$2/$3/$4/$5 while keeping the $5 impulse, $1 target and entry rules fixed. It can also compare impulse thresholds $3/$4/$5/$6/$7. Results include win rate, Wilson 95% interval, expectancy per ounce, net P&L per ounce, profit factor and exit reasons.

## Data requirements
Use chronological MT5 XAUUSD M15 OHLC exported from the target broker. Remove the current unfinished candle. Include timestamps and broker-native prices. A broker CSV export is preferred because spread and execution conditions must match the account.

The public BiQuote documentation describes a rolling OHLC window of 192 M15 bars, far too short to establish a robust 90% claim. Its candles are built from mid prices and therefore do not reproduce bid/ask execution. Documentation: https://biquote.io/docs/.

## Interpretation
A $1 target versus a $3 stop has a theoretical break-even win rate of 75% before costs. Costs and time exits raise the required observed win rate. Inspect the Wilson interval, expectancy, profit factor and out-of-sample stability. No historical result guarantees future performance.

## Usage
Import runXauM15ImpulseBacktest, compareXauM15StopLosses, or compareXauM15ImpulseThresholds from momentum-backtest.mjs. Input is an array of completed OHLC candles with open, high, low, close and optional time/timestamp fields.
