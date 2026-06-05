# Bonereaper Paper Simulator v27

This repository contains the paper-only Bonereaper behavior clone simulator for
Polymarket BTC/ETH Up or Down 5m/15m markets.

## Version

- Main strategy ID: `portfolio-v27-min5u-defensive-budget-floor`
- Main strategy name: `v27 min-5U floor: defensive budgets and order caps cannot fall below exchange minimum`
- Small-bankroll strategy ID: `portfolio-v22-50u-min5u-realistic`
- Main script: `scripts/bonereaper-live-paper.mjs`
- Historical backup kept for reference: `scripts/bonereaper-live-paper.v14-backup.mjs`

## Safety Boundary

This is a paper-only simulator. It reads public Polymarket/Gamma/Data API data
and writes local HTML/JSON state files. It does not submit real orders and does
not connect to a live trading order placement path.

## What v27 Includes

- Minimum order notional floor aligned to 5 USDC.
- Defensive budgets and order caps cannot fall below the exchange minimum.
- BTC/ETH 5m and 15m portfolio simulation.
- Public Bonereaper activity learning as a signal, while still requiring local
  paper edge checks.
- Paper execution model with maker fill checks, visible depth, taker/maker fee
  modeling, and about 600ms execution latency.
- Risk remains warn-only for simulation continuity; no real trading calls.

## Typical Local Run

```powershell
node scripts\bonereaper-live-paper.mjs --auto-btc5m --clone --out bonereaper-live-current
```

For a 50 USDC paper account:

```powershell
node scripts\bonereaper-live-paper.mjs --auto-btc5m --clone --clone-bankroll-usdc 50 --out bonereaper-live-50u
```
