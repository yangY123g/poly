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

## Current Safety State

The switch records `realOrderSwitch` in `dashboard-state.json` and each Shadow Live FAK/IOC order. The current paper mirror still has no real CLOB order adapter wired, so `realOrderSubmitAllowed` remains false and the blocker is explicit:

```text
real CLOB order adapter is not wired in this paper mirror
```

Do not treat `-Mode live` as a real trading launch until a broker adapter is added and validated.
