# Bonereaper Live Switch

The live paper mirror defaults to paper/shadow mode. Real-order submission is guarded by a separate switch and remains blocked unless every gate passes.

## Versions

- Main portfolio: `portfolio-v47-live-switch-guard`
- 50U portfolio: `portfolio-v38-50u-live-switch-guard`

## Start 50U Paper Mode

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-bonereaper-live-switch.ps1 -Target 50u -Mode paper
```

## Arm 50U Live Switch

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-bonereaper-live-switch.ps1 -Target 50u -Mode live -Confirm50uLive
```

This sets:

```powershell
BONEREAPER_REAL_ORDERS=1
BONEREAPER_REAL_ORDERS_CONFIRM=I_ACCEPT_50U_REAL_ORDERS
```

The live adapter also requires installed dependencies:

```powershell
npm install
```

## Current Safety State

The switch records `realOrderSwitch` in `dashboard-state.json` and each Shadow Live FAK/IOC order. The 50U CLOB adapter is lazy-loaded and only runs when the switch is armed with `--clone-real-order-adapter clob`.

Loss-based circuit breakers are intentionally not enabled in this version. Add them only after an explicit follow-up decision.
