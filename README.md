# Bonereaper Paper Simulator v47 / 50U v38

This repository contains the Bonereaper behavior clone simulator for Polymarket
BTC/ETH Up or Down 5m/15m markets. It defaults to paper/shadow mode.

## Version

- Main strategy ID: `portfolio-v47-live-switch-guard`
- Main strategy name: `v47 shadow live: guarded real-order switch`
- Small-bankroll strategy ID: `portfolio-v38-50u-live-switch-guard`
- Small-bankroll strategy name: `50U v38 shadow live: guarded real-order switch`
- Main script: `scripts/bonereaper-live-paper.mjs`
- Live switch script: `scripts/start-bonereaper-live-switch.ps1`
- Live switch notes: `docs/bonereaper-live-switch.md`
- Historical backup kept for reference: `scripts/bonereaper-live-paper.v14-backup.mjs`

## Safety Boundary

The simulator reads public Polymarket/Gamma/Data API data and writes local
HTML/JSON state files. Real-order submission is guarded by an explicit switch,
environment confirmation, LiveGate checks, and a hard 50U budget cap. The CLOB
adapter is limited to the 50U/small-bankroll mode and only submits strict
FOK/FAK orders after Shadow Live confirms fresh WebSocket depth.

## What v47/v38 Includes

- Main and 50U version IDs for the latest shadow-live FAK/IOC simulator.
- A guarded real-order switch with explicit `BONEREAPER_REAL_ORDERS` and
  `BONEREAPER_REAL_ORDERS_CONFIRM=I_ACCEPT_50U_REAL_ORDERS` confirmation.
- A lazy-loaded 50U-only CLOB live adapter using `@polymarket/clob-client-v2`.
- Per-order `realOrderSwitch` status in Shadow Live FAK/IOC records.
- 50U live-switch PowerShell launcher.
- BTC/ETH 5m and 15m portfolio simulation.
- Public Bonereaper activity learning as a signal, while still requiring local
  paper edge checks.
- Strict FAK/IOC-like cross fills with fresh WebSocket orderbook and visible
  depth checks.

## Typical Local Run

```powershell
node scripts\bonereaper-live-paper.mjs --auto-btc5m --clone --out bonereaper-live-current
```

For a 50 USDC paper account:

```powershell
node scripts\bonereaper-live-paper.mjs --auto-btc5m --clone --clone-bankroll-usdc 50 --out bonereaper-live-50u
```

Guarded 50U switch launcher:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-bonereaper-live-switch.ps1 -Target 50u -Mode paper
```

Install live adapter dependencies before live mode:

```powershell
npm install
```

To arm the 50U CLOB live adapter:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-bonereaper-live-switch.ps1 -Target 50u -Mode live -Confirm50uLive
```

Loss-based circuit breakers are not enabled in this version.
