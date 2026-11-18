# TradePilot — Ultra Precision XAUUSD

## Product contract

- Instrument: XAUUSD only.
- Signal delivery: Telegram only for fully approved setups.
- Execution: manual by the user; no broker order placement.
- Default posture: abstain whenever any required input or validation is missing.
- No daily alert quota or target. Signal frequency must never lower the quality threshold.

## Alert gate

The scheduled alert path uses a fixed minimum technical score of 85/100 and then applies an independent hard gate:

1. Valid market analysis and fresh, continuous M1/M5/M15 data.
2. H1/H4/D1 data available.
3. Directional anticipation agrees with the candidate and has a confluence index of at least 68.
4. At least two higher timeframes align.
5. Side-specific structure/liquidity confluence is at least 75 and is marked strong.
6. Spread, entry trigger, structural plan, entry quality and trade plan are all explicitly confirmed.
7. No confirmed opposing reversal guard.
8. Live quote age is within the configured freshness limit and spread is finite.
9. Historical validation has at least 30 resolved samples, is marked historically qualified, and its 95% Wilson lower confidence bound is at least 60%.

Any failed or missing check downgrades the candidate to EARLY and prevents Telegram delivery. The virtual X10 path also receives the downgraded signal and therefore cannot open a virtual position from a blocked candidate.

## Statistical qualification and rollout

This is deliberately conservative. During the initial evidence-collection phase, Telegram may remain silent until the strategy has enough resolved observations. The sample is based on historical/observed OHLC candles, not verified MT5 executions. It does not fully model broker-specific spread history, commissions, latency or slippage. The Wilson lower bound is a descriptive uncertainty measure, not a guarantee of future performance.

Before using this as a live decision aid:
- run historical backtests with out-of-sample periods and walk-forward validation;
- include realistic spread, commission, swap and slippage assumptions;
- compare the signal feed against the exact MT5 broker symbol and contract specification;
- run shadow/paper alerts and reconcile every result;
- monitor feed outages, missing bars, duplicate alerts and Telegram delivery failures.

## Safety

- `liveTrading` remains false.
- No order API, MT5 trade operation or broker write permission is introduced.
- A Telegram message is an analysis alert, not a guaranteed profitable instruction.
- Do not increase position size based on a score or historical win rate alone.
