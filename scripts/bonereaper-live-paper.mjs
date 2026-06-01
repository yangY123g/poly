#!/usr/bin/env node
/**
 * Live paper mirror for the Bonereaper wallet.
 *
 * This process only reads public Polymarket activity endpoints and writes local
 * HTML/JSON files. It never imports the trading server and never submits orders.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import process from "node:process";

const execFileAsync = promisify(execFile);
const DATA_API_URL = "https://data-api.polymarket.com";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";
const POLYMARKET_WEB_URL = "https://polymarket.com";
const CODEX_RUNTIME_PYTHON = join(
  process.env.USERPROFILE || "",
  ".cache",
  "codex-runtimes",
  "codex-primary-runtime",
  "dependencies",
  "python",
  "python.exe",
);
const DEFAULT_WALLET = "0xeebde7a0e019a63e6b476eb425505b7b3e6eba30";
const CRYPTO_ASSETS = ["BTC", "ETH"];
const CRYPTO_HORIZONS = ["5m", "15m"];
const CRYPTO_LEGS = [
  { key: "BTC5m", asset: "BTC", horizon: "5m", durationSec: 300, budgetWeight: 0.1, parentKey: "BTC15m" },
  { key: "BTC15m", asset: "BTC", horizon: "15m", durationSec: 900, budgetWeight: 1.55, parentKey: "" },
  { key: "ETH5m", asset: "ETH", horizon: "5m", durationSec: 300, budgetWeight: 0.05, parentKey: "ETH15m" },
  { key: "ETH15m", asset: "ETH", horizon: "15m", durationSec: 900, budgetWeight: 0.46, parentKey: "" },
];
const CRYPTO_UPDOWN_RE = /^(btc|eth)-updown-(5m|15m)-(\d+)$/i;
const BTC_5M_RE = /^btc-updown-5m-(\d+)$/;
const ACTIVITY_TYPES = ["TRADE", "REDEEM"];
const OUTCOMES = ["Up", "Down"];
const POLYMARKET_MIN_ORDER_USDC = 1;
const POLYMARKET_MIN_ORDER_SHARES = 5;
const STRATEGY_VERSION_ID = "portfolio-v16-strict-fill-latency";
const STRATEGY_VERSION_NAME = "新规则版本：严格盘口成交/手续费 + 600ms 响应延迟";
const LEDGER_RESET_ID = "full-ledger-reset-v1-hourly";
const LEDGER_RESET_NAME = "总账重置：从新规则小时收益率版本重新计数";
const feeRateCache = new Map();

function parseArgs(argv) {
  const opts = {
    wallet: DEFAULT_WALLET,
    out: "bonereaper-live",
    pollMs: 500,
    limit: 500,
    backfillMinutes: 45,
    maxTrades: 3000,
    dashboardMaxTrades: 150,
    dashboardMaxHistory: 120,
    dashboardMaxOrders: 60,
    flushIntervalMs: 5000,
    fullStateFlushIntervalMs: 120000,
    timeoutMs: 12000,
    reset: false,
    slug: "",
    eventUrl: "",
    autoBtc5m: false,
    clone: true,
    cloneBudgetUsdc: 300,
    cloneOrderUsdc: 3,
    cloneEntryStartSec: 2,
    cloneEntryEndSec: 296,
    cloneMinEdge: 0.03,
    cloneComboMaxCost: 0.985,
    cloneMaxAsk: 0.97,
    cloneHedgeEnabled: false,
    cloneHedgeMaxAsk: 0,
    cloneOrderTtlSec: 75,
    cloneCooldownSec: 0,
    cloneMinSignalBps: 2.2,
    cloneHighConfidenceBps: 8,
    cloneWhaleConfidenceBps: 15,
    cloneMaxClipUsdc: 15,
    cloneMinExpectedEdge: 0.018,
    cloneProbeEnabled: true,
    cloneProbeOrderUsdc: 1.5,
    cloneProbeMinExpectedEdge: 0.008,
    cloneProbeMinSignalBps: 0,
    cloneProbeMaxPerCycle: 36,
    cloneInventoryRebalanceRatio: 0.35,
    cloneFlowConfirmEnabled: true,
    cloneFlowConfirmMinDominance: 0.75,
    cloneFlowConfirmMinRows: 12,
    cloneFlowConfirmMinUsdc: 60,
    cloneFlowConfirmMaxAgeSec: 40,
    cloneFlowConfirmOpeningWindowSec: 140,
    cloneFlowConfirmOpeningMaxAgeSec: 210,
    cloneFlowConfirmOpeningRowRatio: 0.65,
    cloneFlowConfirmMaxOpposingParentBps: 5,
    cloneFlowConfirmMinEdge: -0.006,
    cloneMaxOrdersPerWindow: 0,
    cloneHedgeSignalBps: 4,
    cloneComboEntryMaxCost: 0.985,
    cloneExitEnabled: false,
    cloneExitFlipBps: 1.5,
    cloneExitTakeProfitPct: 0.12,
    cloneExitStopLossPct: 0.18,
    cloneExitBeforeEndSec: 45,
    cloneMatchSeconds: 45,
    clonePriceTolerance: 0.04,
    cloneSlippageBps: 30,
    cloneLiquidityParticipation: 0.35,
    cloneExecutionLatencyMs: 600,
    cloneQueueDelaySec: 1,
    cloneMinFillUsdc: POLYMARKET_MIN_ORDER_USDC,
    cloneMinVisibleDepthUsdc: 2,
    cloneMakerPenetrationTicks: 1,
    cloneTakerFeeRate: 0.07,
    cloneMakerFeeRate: 0,
    cloneDailyLossLimitUsdc: 5000,
    cloneMaxDirectionExposureUsdc: 220,
    cloneMaxConsecutiveLosses: 3,
    cloneAdaptive: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      const eq = arg.indexOf("=");
      if (eq >= 0) return arg.slice(eq + 1);
      i += 1;
      return argv[i];
    };
    if (arg.startsWith("--wallet")) opts.wallet = String(readValue()).trim();
    else if (arg.startsWith("--out")) opts.out = readValue();
    else if (arg.startsWith("--poll-ms")) opts.pollMs = Number(readValue());
    else if (arg.startsWith("--limit")) opts.limit = Number(readValue());
    else if (arg.startsWith("--backfill-minutes")) opts.backfillMinutes = Number(readValue());
    else if (arg.startsWith("--max-trades")) opts.maxTrades = Number(readValue());
    else if (arg.startsWith("--dashboard-max-trades")) opts.dashboardMaxTrades = Number(readValue());
    else if (arg.startsWith("--dashboard-max-history")) opts.dashboardMaxHistory = Number(readValue());
    else if (arg.startsWith("--dashboard-max-orders")) opts.dashboardMaxOrders = Number(readValue());
    else if (arg.startsWith("--flush-interval-ms")) opts.flushIntervalMs = Number(readValue());
    else if (arg.startsWith("--full-state-flush-interval-ms")) opts.fullStateFlushIntervalMs = Number(readValue());
    else if (arg.startsWith("--timeout-ms")) opts.timeoutMs = Number(readValue());
    else if (arg === "--reset") opts.reset = true;
    else if (arg.startsWith("--slug")) opts.slug = normalizeSlug(readValue());
    else if (arg.startsWith("--event-url")) {
      opts.eventUrl = String(readValue()).trim();
      opts.slug = normalizeSlug(opts.eventUrl);
    }
    else if (arg === "--auto-btc5m") opts.autoBtc5m = true;
    else if (arg === "--clone") opts.clone = true;
    else if (arg === "--no-clone") opts.clone = false;
    else if (arg.startsWith("--clone-budget-usdc")) opts.cloneBudgetUsdc = Number(readValue());
    else if (arg.startsWith("--clone-order-usdc")) opts.cloneOrderUsdc = Number(readValue());
    else if (arg.startsWith("--clone-entry-start-sec")) opts.cloneEntryStartSec = Number(readValue());
    else if (arg.startsWith("--clone-entry-end-sec")) opts.cloneEntryEndSec = Number(readValue());
    else if (arg.startsWith("--clone-min-edge")) opts.cloneMinEdge = Number(readValue());
    else if (arg.startsWith("--clone-combo-max-cost")) opts.cloneComboMaxCost = Number(readValue());
    else if (arg.startsWith("--clone-max-ask")) opts.cloneMaxAsk = Number(readValue());
    else if (arg === "--clone-hedge") opts.cloneHedgeEnabled = true;
    else if (arg === "--no-clone-hedge") opts.cloneHedgeEnabled = false;
    else if (arg.startsWith("--clone-hedge-max-ask")) opts.cloneHedgeMaxAsk = Number(readValue());
    else if (arg.startsWith("--clone-min-signal-bps")) opts.cloneMinSignalBps = Number(readValue());
    else if (arg.startsWith("--clone-high-confidence-bps")) opts.cloneHighConfidenceBps = Number(readValue());
    else if (arg.startsWith("--clone-whale-confidence-bps")) opts.cloneWhaleConfidenceBps = Number(readValue());
    else if (arg.startsWith("--clone-max-clip-usdc")) opts.cloneMaxClipUsdc = Number(readValue());
    else if (arg.startsWith("--clone-min-expected-edge")) opts.cloneMinExpectedEdge = Number(readValue());
    else if (arg === "--clone-probe") opts.cloneProbeEnabled = true;
    else if (arg === "--no-clone-probe") opts.cloneProbeEnabled = false;
    else if (arg.startsWith("--clone-probe-order-usdc")) opts.cloneProbeOrderUsdc = Number(readValue());
    else if (arg.startsWith("--clone-probe-min-expected-edge")) opts.cloneProbeMinExpectedEdge = Number(readValue());
    else if (arg.startsWith("--clone-probe-min-signal-bps")) opts.cloneProbeMinSignalBps = Number(readValue());
    else if (arg.startsWith("--clone-probe-max-per-cycle")) opts.cloneProbeMaxPerCycle = Number(readValue());
    else if (arg.startsWith("--clone-inventory-rebalance-ratio")) opts.cloneInventoryRebalanceRatio = Number(readValue());
    else if (arg === "--clone-flow-confirm") opts.cloneFlowConfirmEnabled = true;
    else if (arg === "--no-clone-flow-confirm") opts.cloneFlowConfirmEnabled = false;
    else if (arg.startsWith("--clone-flow-confirm-min-dominance")) opts.cloneFlowConfirmMinDominance = Number(readValue());
    else if (arg.startsWith("--clone-flow-confirm-min-rows")) opts.cloneFlowConfirmMinRows = Number(readValue());
    else if (arg.startsWith("--clone-flow-confirm-min-usdc")) opts.cloneFlowConfirmMinUsdc = Number(readValue());
    else if (arg.startsWith("--clone-flow-confirm-max-age-sec")) opts.cloneFlowConfirmMaxAgeSec = Number(readValue());
    else if (arg.startsWith("--clone-flow-confirm-opening-window-sec")) opts.cloneFlowConfirmOpeningWindowSec = Number(readValue());
    else if (arg.startsWith("--clone-flow-confirm-opening-max-age-sec")) opts.cloneFlowConfirmOpeningMaxAgeSec = Number(readValue());
    else if (arg.startsWith("--clone-flow-confirm-opening-row-ratio")) opts.cloneFlowConfirmOpeningRowRatio = Number(readValue());
    else if (arg.startsWith("--clone-flow-confirm-max-opposing-parent-bps")) opts.cloneFlowConfirmMaxOpposingParentBps = Number(readValue());
    else if (arg.startsWith("--clone-flow-confirm-min-edge")) opts.cloneFlowConfirmMinEdge = Number(readValue());
    else if (arg.startsWith("--clone-max-orders-per-window")) opts.cloneMaxOrdersPerWindow = Number(readValue());
    else if (arg.startsWith("--clone-hedge-signal-bps")) opts.cloneHedgeSignalBps = Number(readValue());
    else if (arg.startsWith("--clone-combo-entry-max-cost")) opts.cloneComboEntryMaxCost = Number(readValue());
    else if (arg === "--clone-exit") opts.cloneExitEnabled = true;
    else if (arg === "--no-clone-exit") opts.cloneExitEnabled = false;
    else if (arg.startsWith("--clone-exit-flip-bps")) opts.cloneExitFlipBps = Number(readValue());
    else if (arg.startsWith("--clone-exit-take-profit-pct")) opts.cloneExitTakeProfitPct = Number(readValue());
    else if (arg.startsWith("--clone-exit-stop-loss-pct")) opts.cloneExitStopLossPct = Number(readValue());
    else if (arg.startsWith("--clone-exit-before-end-sec")) opts.cloneExitBeforeEndSec = Number(readValue());
    else if (arg.startsWith("--clone-slippage-bps")) opts.cloneSlippageBps = Number(readValue());
    else if (arg.startsWith("--clone-liquidity-participation")) opts.cloneLiquidityParticipation = Number(readValue());
    else if (arg.startsWith("--clone-execution-latency-ms")) opts.cloneExecutionLatencyMs = Number(readValue());
    else if (arg.startsWith("--clone-queue-delay-sec")) opts.cloneQueueDelaySec = Number(readValue());
    else if (arg.startsWith("--clone-min-fill-usdc")) opts.cloneMinFillUsdc = Number(readValue());
    else if (arg.startsWith("--clone-min-visible-depth-usdc")) opts.cloneMinVisibleDepthUsdc = Number(readValue());
    else if (arg.startsWith("--clone-maker-penetration-ticks")) opts.cloneMakerPenetrationTicks = Number(readValue());
    else if (arg.startsWith("--clone-taker-fee-rate")) opts.cloneTakerFeeRate = Number(readValue());
    else if (arg.startsWith("--clone-maker-fee-rate")) opts.cloneMakerFeeRate = Number(readValue());
    else if (arg.startsWith("--clone-daily-loss-limit-usdc")) opts.cloneDailyLossLimitUsdc = Number(readValue());
    else if (arg.startsWith("--clone-max-direction-exposure-usdc")) opts.cloneMaxDirectionExposureUsdc = Number(readValue());
    else if (arg.startsWith("--clone-max-consecutive-losses")) opts.cloneMaxConsecutiveLosses = Number(readValue());
    else if (arg === "--clone-adaptive") opts.cloneAdaptive = true;
    else if (arg === "--no-clone-adaptive") opts.cloneAdaptive = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  opts.out = resolve(process.cwd(), opts.out);
  opts.pollMs = clampInt(opts.pollMs, 250, 60000, 500);
  opts.limit = clampInt(opts.limit, 1, 500, 500);
  opts.backfillMinutes = clampInt(opts.backfillMinutes, 0, 1440, 45);
  opts.maxTrades = clampInt(opts.maxTrades, 100, 20000, 3000);
  opts.dashboardMaxTrades = clampInt(opts.dashboardMaxTrades, 50, 5000, 150);
  opts.dashboardMaxHistory = clampInt(opts.dashboardMaxHistory, 50, 2000, 120);
  opts.dashboardMaxOrders = clampInt(opts.dashboardMaxOrders, 50, 2000, 60);
  opts.flushIntervalMs = clampInt(opts.flushIntervalMs, 500, 30000, 5000);
  opts.fullStateFlushIntervalMs = clampInt(opts.fullStateFlushIntervalMs, opts.flushIntervalMs, 300000, 120000);
  opts.timeoutMs = clampInt(opts.timeoutMs, 1000, 60000, 12000);
  if (opts.autoBtc5m) {
    opts.slug = currentBtc5mSlug();
    opts.eventUrl = eventUrlForSlug(opts.slug);
  }
  opts.cloneBudgetUsdc = clampNum(opts.cloneBudgetUsdc, 5, 250000, 60);
  opts.cloneOrderUsdc = clampNum(opts.cloneOrderUsdc, POLYMARKET_MIN_ORDER_USDC, 500, 1);
  opts.cloneEntryStartSec = clampInt(opts.cloneEntryStartSec, 0, 299, 2);
  opts.cloneEntryEndSec = clampInt(opts.cloneEntryEndSec, opts.cloneEntryStartSec, 300, 296);
  opts.cloneMinEdge = clampNum(opts.cloneMinEdge, 0, 0.5, 0.03);
  opts.cloneComboMaxCost = clampNum(opts.cloneComboMaxCost, 0.5, 1.1, 0.985);
  opts.cloneMaxAsk = clampNum(opts.cloneMaxAsk, 0.01, 0.99, 0.97);
  opts.cloneHedgeMaxAsk = clampNum(opts.cloneHedgeMaxAsk, 0, 0.99, 0);
  opts.cloneOrderTtlSec = clampInt(opts.cloneOrderTtlSec, 5, 600, 75);
  opts.cloneCooldownSec = clampInt(opts.cloneCooldownSec, 0, 120, 0);
  opts.cloneMinSignalBps = clampNum(opts.cloneMinSignalBps, 0, 50, 2.2);
  opts.cloneHighConfidenceBps = clampNum(opts.cloneHighConfidenceBps, 0.1, 100, 8);
  opts.cloneWhaleConfidenceBps = clampNum(opts.cloneWhaleConfidenceBps, 0.1, 200, 15);
  opts.cloneMaxClipUsdc = clampNum(opts.cloneMaxClipUsdc, POLYMARKET_MIN_ORDER_USDC, 10000, 2.5);
  opts.cloneMinExpectedEdge = clampNum(opts.cloneMinExpectedEdge, -0.1, 0.5, 0.018);
  opts.cloneProbeOrderUsdc = clampNum(opts.cloneProbeOrderUsdc, POLYMARKET_MIN_ORDER_USDC, 100, 1);
  opts.cloneProbeMinExpectedEdge = clampNum(opts.cloneProbeMinExpectedEdge, -0.1, 0.5, 0.008);
  opts.cloneProbeMinSignalBps = clampNum(opts.cloneProbeMinSignalBps, 0, 50, 0);
  opts.cloneProbeMaxPerCycle = clampInt(opts.cloneProbeMaxPerCycle, 0, 120, 36);
  opts.cloneInventoryRebalanceRatio = clampNum(opts.cloneInventoryRebalanceRatio, 0, 2, 0.35);
  opts.cloneFlowConfirmMinDominance = clampNum(opts.cloneFlowConfirmMinDominance, 0.5, 1, 0.75);
  opts.cloneFlowConfirmMinRows = clampInt(opts.cloneFlowConfirmMinRows, 1, 500, 12);
  opts.cloneFlowConfirmMinUsdc = clampNum(opts.cloneFlowConfirmMinUsdc, 1, 100000, 60);
  opts.cloneFlowConfirmMaxAgeSec = clampInt(opts.cloneFlowConfirmMaxAgeSec, 1, 300, 40);
  opts.cloneFlowConfirmOpeningWindowSec = clampInt(opts.cloneFlowConfirmOpeningWindowSec, 1, 300, 140);
  opts.cloneFlowConfirmOpeningMaxAgeSec = clampInt(opts.cloneFlowConfirmOpeningMaxAgeSec, 1, 300, 210);
  opts.cloneFlowConfirmOpeningRowRatio = clampNum(opts.cloneFlowConfirmOpeningRowRatio, 0.3, 1, 0.65);
  opts.cloneFlowConfirmMaxOpposingParentBps = clampNum(opts.cloneFlowConfirmMaxOpposingParentBps, 0, 50, 5);
  opts.cloneFlowConfirmMinEdge = clampNum(opts.cloneFlowConfirmMinEdge, -0.1, 0.2, -0.006);
  opts.cloneMaxOrdersPerWindow = clampInt(opts.cloneMaxOrdersPerWindow, 0, 1000, 0);
  opts.cloneHedgeSignalBps = clampNum(opts.cloneHedgeSignalBps, 0, 100, 4);
  opts.cloneComboEntryMaxCost = clampNum(opts.cloneComboEntryMaxCost, 0.5, 1.2, 0.985);
  opts.cloneExitFlipBps = clampNum(opts.cloneExitFlipBps, 0, 50, 1.5);
  opts.cloneExitTakeProfitPct = clampNum(opts.cloneExitTakeProfitPct, 0, 5, 0.12);
  opts.cloneExitStopLossPct = clampNum(opts.cloneExitStopLossPct, 0, 1, 0.18);
  opts.cloneExitBeforeEndSec = clampInt(opts.cloneExitBeforeEndSec, 0, 120, 45);
  opts.cloneMatchSeconds = clampInt(opts.cloneMatchSeconds, 1, 300, 45);
  opts.clonePriceTolerance = clampNum(opts.clonePriceTolerance, 0, 0.5, 0.04);
  opts.cloneSlippageBps = clampNum(opts.cloneSlippageBps, 0, 500, 30);
  opts.cloneLiquidityParticipation = clampNum(opts.cloneLiquidityParticipation, 0.01, 1, 0.35);
  opts.cloneExecutionLatencyMs = clampInt(opts.cloneExecutionLatencyMs, 0, 10_000, 600);
  opts.cloneQueueDelaySec = clampInt(opts.cloneQueueDelaySec, 0, 60, 1);
  opts.cloneMinFillUsdc = clampNum(opts.cloneMinFillUsdc, POLYMARKET_MIN_ORDER_USDC, 50, POLYMARKET_MIN_ORDER_USDC);
  opts.cloneMinVisibleDepthUsdc = clampNum(opts.cloneMinVisibleDepthUsdc, 0, 500, 2);
  opts.cloneMakerPenetrationTicks = clampInt(opts.cloneMakerPenetrationTicks, 0, 10, 1);
  opts.cloneTakerFeeRate = clampNum(opts.cloneTakerFeeRate, 0, 0.5, 0.07);
  opts.cloneMakerFeeRate = clampNum(opts.cloneMakerFeeRate, 0, 0.5, 0);
  opts.cloneDailyLossLimitUsdc = clampNum(opts.cloneDailyLossLimitUsdc, 0, 100000, 5000);
  opts.cloneMaxDirectionExposureUsdc = clampNum(opts.cloneMaxDirectionExposureUsdc, 1, 250000, 35);
  opts.cloneMaxConsecutiveLosses = clampInt(opts.cloneMaxConsecutiveLosses, 0, 100, 3);
  if (!/^0x[a-fA-F0-9]{40}$/.test(opts.wallet)) throw new Error(`Invalid wallet: ${opts.wallet}`);
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/bonereaper-live-paper.mjs [options]

Options:
  --out <dir>                 Output directory. Default: bonereaper-live
  --poll-ms <n>               Poll interval. Default: 500
  --backfill-minutes <n>      Initial history window. Default: 45
  --max-trades <n>            Max local trade rows. Default: 3000
  --slug <slug>               Track one BTC 5m event slug only
  --event-url <url>           Track one Polymarket event URL
  --auto-btc5m                Auto-roll to the current BTC 5m market
  --clone / --no-clone        Enable behavior clone engine. Default: enabled
  --clone-budget-usdc <n>     Paper budget per window. Default: 10000
  --clone-order-usdc <n>      Base paper clip size. Default: 8.5
  --clone-min-signal-bps <n>  Min BTC move vs Polymarket open before entry. Default: 1.2
  --clone-high-confidence-bps <n>  Scale up after this BTC signal. Default: 8
  --clone-max-clip-usdc <n>   Max dynamic paper clip. Default: 500
  --clone-max-orders-per-window <n>  Max paper entry orders per 5m window. 0 means unlimited. Default: 0
  --clone-exit                Enable intrawindow paper sells. Default: disabled
  --clone-slippage-bps <n>    Paper taker slippage cushion. Default: 30
  --clone-daily-loss-limit-usdc <n>  Pause after daily paper loss. Default: 5000
  --no-clone-adaptive         Disable small adaptive parameter tuning
  --reset                     Ignore an existing state.json and start fresh
`);
}

function normalizeSlug(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/(?:btc|eth)-updown-(?:5m|15m)-\d+/i);
  return match ? match[0] : text;
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function finiteNum(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 4) {
  const n = num(value, 0);
  const m = 10 ** decimals;
  return Math.round(n * m) / m;
}

function ceilMoney(value, decimals = 2) {
  const n = num(value, 0);
  const m = 10 ** decimals;
  return Math.ceil((n - 1e-9) * m) / m;
}

function slugWindowStart(slug) {
  const match = String(slug || "").match(CRYPTO_UPDOWN_RE);
  return match ? Number(match[3]) : null;
}

function slugAsset(slug) {
  const match = String(slug || "").match(CRYPTO_UPDOWN_RE);
  return match ? match[1].toUpperCase() : "";
}

function slugHorizon(slug) {
  const match = String(slug || "").match(CRYPTO_UPDOWN_RE);
  return match ? match[2].toLowerCase() : "";
}

function slugWindowSeconds(slug) {
  const horizon = slugHorizon(slug);
  return horizon === "15m" ? 900 : horizon === "5m" ? 300 : 300;
}

function slugLegKey(slug) {
  const asset = slugAsset(slug);
  const horizon = slugHorizon(slug);
  return asset && horizon ? `${asset}${horizon}` : "";
}

function cryptoLegForKey(key) {
  return CRYPTO_LEGS.find((leg) => leg.key === key) || null;
}

function cryptoLegForSlug(slug) {
  return cryptoLegForKey(slugLegKey(slug));
}

function currentBtc5mSlug(nowSec = Math.floor(Date.now() / 1000)) {
  return currentCryptoSlug("BTC", "5m", nowSec);
}

function currentCrypto5mSlug(asset = "BTC", nowSec = Math.floor(Date.now() / 1000)) {
  return currentCryptoSlug(asset, "5m", nowSec);
}

function currentCryptoSlug(asset = "BTC", horizon = "5m", nowSec = Math.floor(Date.now() / 1000)) {
  const prefix = String(asset || "BTC").toLowerCase();
  const h = CRYPTO_HORIZONS.includes(String(horizon).toLowerCase()) ? String(horizon).toLowerCase() : "5m";
  const duration = h === "15m" ? 900 : 300;
  return `${prefix}-updown-${h}-${Math.floor(nowSec / duration) * duration}`;
}

function marketClockNowSec(source = {}, nowSec = Math.floor(Date.now() / 1000)) {
  return nowSec + clamp(num(source?.marketClockOffsetSec, 0), -3600, 7200);
}

function marketClockNowMs(source = {}, nowMs = Date.now()) {
  return nowMs + clamp(num(source?.marketClockOffsetSec, 0), -3600, 7200) * 1000;
}

function isBtc5m(row) {
  return slugWindowStart(row.slug || row.eventSlug) != null;
}

function isCrypto5mSlug(slug) {
  return slugWindowStart(slug) != null;
}

function eventUrlForSlug(slug) {
  return `https://polymarket.com/zh/event/${slug}`;
}

function rowKey(row) {
  return [
    row.type,
    row.transactionHash,
    row.timestamp,
    row.slug || row.eventSlug,
    row.asset,
    row.side,
    row.outcome,
    row.size,
    row.usdcSize,
  ].join("|");
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(file, value) {
  await writeAtomic(file, value);
}

async function writeAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, value, "utf8");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      if (attempt === 4) {
        await writeFile(file, value, "utf8");
        return;
      }
      await sleep(40 * (attempt + 1));
    }
  }
}

function buildUrl(base, pathname, params = {}) {
  const url = new URL(pathname, base);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function apiUrl(pathname, params) {
  return buildUrl(DATA_API_URL, pathname, params);
}

async function fetchJson(url, opts) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchJsonOnce(url, opts);
    } catch (err) {
      lastError = err;
      if (!isRetryableFetchError(err) || attempt === 2) throw err;
      await sleep(180 * (attempt + 1));
    }
  }
  throw lastError;
}

async function fetchJsonOnce(url, opts) {
  const python = resolvePythonFetcher();
  if (python) return fetchJsonWithPython(python, url, opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "btc5m-bonereaper-live-paper/1.0",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function resolvePythonFetcher() {
  for (const candidate of [process.env.BONEREAPER_PYTHON, process.env.PYTHON, CODEX_RUNTIME_PYTHON]) {
    if (!candidate) continue;
    if (!candidate.includes("\\") && !candidate.includes("/")) return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

async function fetchJsonWithPython(python, url, opts) {
  const code = [
    "import sys, urllib.request",
    "url=sys.argv[1]",
    "timeout=float(sys.argv[2])",
    "req=urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0','Accept':'application/json','Cache-Control':'no-cache','Pragma':'no-cache'})",
    "with urllib.request.urlopen(req, timeout=timeout) as r:",
    "    sys.stdout.buffer.write(r.read())",
  ].join("\n");
  const { stdout } = await execFileAsync(
    python,
    ["-c", code, String(url), String(Math.max(1, Math.ceil(opts.timeoutMs / 1000)))],
    { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs + 2500 },
  );
  return JSON.parse(stdout);
}

function isRetryableFetchError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/HTTP (400|401|403|404)/.test(message)) return false;
  return /SSL|EOF|ECONN|ETIMEDOUT|timeout|aborted|socket|fetch failed|Command failed/i.test(message);
}

function normalizeArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

async function fetchActivity(type, opts, startSec, options = {}) {
  const limit = clampInt(options.limit || opts.limit, 1, 500, opts.limit);
  const maxRows = clampInt(options.maxRows || limit, limit, 10000, limit);
  const slugFilter = Object.hasOwn(options, "slugFilter") ? options.slugFilter : opts.slug;
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += limit) {
    let page = [];
    try {
      page = await fetchActivityPage(type, opts, {
        startSec,
        endSec: options.endSec,
        limit,
        offset,
      });
    } catch (err) {
      if (options.allowPartial) {
        if (offset > 0) break;
        return rows;
      }
      throw err;
    }
    rows.push(...page);
    if (!options.pageAll || page.length < limit) break;
  }
  return rows.filter((row) => {
    if (!isBtc5m(row)) return false;
    if (slugFilter && (row.slug || row.eventSlug) !== slugFilter) return false;
    return true;
  });
}

async function fetchActivityPage(type, opts, query) {
  const url = apiUrl("/activity", {
    user: opts.wallet,
    type,
    start: query.startSec || undefined,
    end: query.endSec || undefined,
    limit: query.limit,
    offset: query.offset,
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  });
  return normalizeArray(await fetchJson(url, opts));
}

async function fetchActivitySliced(type, opts, startSec, endSec, options = {}) {
  const sliceSec = clampInt(options.sliceSec || 300, 60, 3600, 300);
  const rows = [];
  for (let sliceStart = startSec; sliceStart < endSec; sliceStart += sliceSec) {
    const sliceEnd = Math.min(endSec, sliceStart + sliceSec);
    rows.push(...(await fetchActivity(type, opts, sliceStart, {
      ...options,
      endSec: sliceEnd,
      slugFilter: "",
      pageAll: true,
      maxRows: options.maxRows || 2000,
      allowPartial: true,
    })));
  }
  return rows;
}

function updateMarketClockFromActivity(state, opts, rows, nowSec) {
  const latest = (rows || [])
    .map((row) => ({
      ts: num(row.timestamp ?? row.ts, NaN),
      slug: row.slug || row.eventSlug || "",
    }))
    .filter((row) => Number.isFinite(row.ts) && isCrypto5mSlug(row.slug))
    .sort((a, b) => b.ts - a.ts)[0];
  if (!latest) {
    opts.marketClockOffsetSec = num(state.marketClockOffsetSec, 0);
    return;
  }
  const offset = clamp(Math.round(latest.ts - nowSec), -3600, 7200);
  if (Math.abs(offset) < 15 && Math.abs(num(state.marketClockOffsetSec, 0)) < 15) return;
  state.marketClockOffsetSec = offset;
  state.marketClockUpdatedAt = isoFromSec(nowSec);
  state.marketClockSource = latest.slug;
  opts.marketClockOffsetSec = offset;
}

function createInitialState(opts) {
  return {
    wallet: opts.wallet,
    startedAt: new Date().toISOString(),
    updatedAt: null,
    status: "starting",
    lastError: "",
    pollMs: opts.pollMs,
    paperOnly: true,
    autoBtc5m: opts.autoBtc5m,
    marketClockOffsetSec: 0,
    marketClockUpdatedAt: null,
    marketClockSource: "",
    slug: opts.slug || null,
    eventUrl: opts.eventUrl || (opts.slug ? eventUrlForSlug(opts.slug) : null),
    seen: [],
    trades: [],
    windows: {},
    summary: {
      tradeRows: 0,
      buyRows: 0,
      redeemRows: 0,
      buyUsdc: 0,
      redeemUsdc: 0,
      realizedPnl: 0,
      openWindows: 0,
      totalWindows: 0,
    },
    clone: createInitialCloneState(opts),
    clonePortfolio: null,
    clonePortfolioCumulative: null,
    cloneHistory: [],
    cloneLedgerReset: null,
    cloneCumulative: emptyCloneCumulative(),
    cloneVersion: null,
    cloneVersionCumulative: emptyCloneVersionCumulative(),
    hourlyPerformance: null,
    activityBackfill: null,
  };
}

function emptyCloneCumulative(reset = null) {
  return {
    resetId: reset?.id || null,
    resetName: reset?.name || null,
    resetStartedAt: reset?.startedAt || null,
    resetStartSec: reset?.startSec || null,
    finalizedWindows: 0,
    settledWindows: 0,
    unsettledWindows: 0,
    currentSlug: null,
    currentCost: 0,
    currentPnl: 0,
    finalizedCost: 0,
    finalizedPnl: 0,
    totalCostIncludingOpen: 0,
    totalPnlIncludingOpen: 0,
    updatedAt: null,
  };
}

function emptyCloneVersionCumulative(version = null) {
  return {
    versionId: version?.id || STRATEGY_VERSION_ID,
    versionName: version?.name || STRATEGY_VERSION_NAME,
    startedAt: version?.startedAt || null,
    startSec: version?.startSec || null,
    finalizedWindows: 0,
    settledWindows: 0,
    unsettledWindows: 0,
    currentSlug: null,
    currentCost: 0,
    currentPnl: 0,
    finalizedCost: 0,
    finalizedPnl: 0,
    totalCostIncludingOpen: 0,
    totalPnlIncludingOpen: 0,
    updatedAt: null,
  };
}

function createInitialCloneState(opts, slugOverride = null) {
  const slug = slugOverride || opts.slug || "";
  const asset = slugAsset(slug) || "BTC";
  const horizon = slugHorizon(slug) || "5m";
  const legKey = slugLegKey(slug) || `${asset}${horizon}`;
  return {
    enabled: Boolean(opts.clone && slug),
    status: opts.clone && slug ? "starting" : "disabled",
    mode: "bonereaper-behavior-clone-v1",
    asset,
    horizon,
    legKey,
    strategyVersionId: STRATEGY_VERSION_ID,
    strategyVersionName: STRATEGY_VERSION_NAME,
    versionStartedAt: null,
    ledgerResetId: "",
    ledgerResetName: "",
    ledgerResetStartedAt: null,
    lastError: opts.clone && !slug ? "clone requires --slug or --event-url" : "",
    updatedAt: null,
    config: cloneConfig(opts),
    market: null,
    btc: {
      source: "",
      price: null,
      openPrice: null,
      openPriceSource: "",
      openPriceErrorSec: null,
      delta: null,
      deltaBps: null,
      updatedAt: null,
      samples: [],
    },
    orderbook: {
      source: "",
      updatedAt: null,
      Up: null,
      Down: null,
      comboAsk: null,
      comboBid: null,
    },
    orders: [],
    fills: [],
    positions: emptyClonePositions(),
    pnl: {
      cost: 0,
      marketValue: 0,
      settledValue: 0,
      unrealized: 0,
      realized: 0,
      winner: "",
      settled: false,
    },
    calibration: {
      observedBuyRows: 0,
      cloneFillRows: 0,
      matchedRows: 0,
      directionMatchRate: null,
      avgSignedTimeErrorSec: null,
      avgAbsTimeErrorSec: null,
      avgAbsPriceError: null,
      missedObservedRows: 0,
      extraCloneRows: 0,
      updatedAt: null,
    },
    learner: {
      enabled: true,
      currentObservedBuys: 0,
      currentObservedSells: 0,
      preferredOutcome: "",
      recentBuyRows30s: 0,
      medianBuyUsdc: null,
      medianWindowBuyRows: null,
      medianWindowBuyUsdc: null,
      suggested: {},
      notes: [],
      updatedAt: null,
    },
    risk: {
      paused: false,
      reason: "",
      dailyLoss: 0,
      consecutiveLosses: 0,
      directionExposure: emptyDirectionExposure(),
      updatedAt: null,
    },
    adaptive: {
      enabled: Boolean(opts.cloneAdaptive),
      effectiveConfig: cloneConfig(opts),
      adjustments: {},
      suggestions: [],
      updatedAt: null,
    },
    lastDecision: null,
  };
}

function emptyDirectionExposure() {
  return {
    Up: { cost: 0, pending: 0, total: 0 },
    Down: { cost: 0, pending: 0, total: 0 },
  };
}

function cloneConfig(opts) {
  return {
    budgetUsdc: opts.cloneBudgetUsdc,
    orderUsdc: opts.cloneOrderUsdc,
    entryStartSec: opts.cloneEntryStartSec,
    entryEndSec: opts.cloneEntryEndSec,
    minEdge: opts.cloneMinEdge,
    comboMaxCost: opts.cloneComboMaxCost,
    maxAsk: opts.cloneMaxAsk,
    hedgeEnabled: Boolean(opts.cloneHedgeEnabled),
    hedgeMaxAsk: opts.cloneHedgeMaxAsk,
    orderTtlSec: opts.cloneOrderTtlSec,
    cooldownSec: opts.cloneCooldownSec,
    minSignalBps: opts.cloneMinSignalBps,
    highConfidenceBps: opts.cloneHighConfidenceBps,
    whaleConfidenceBps: opts.cloneWhaleConfidenceBps,
    maxClipUsdc: opts.cloneMaxClipUsdc,
    minExpectedEdge: opts.cloneMinExpectedEdge,
    probeEnabled: Boolean(opts.cloneProbeEnabled),
    probeOrderUsdc: opts.cloneProbeOrderUsdc,
    probeMinExpectedEdge: opts.cloneProbeMinExpectedEdge,
    probeMinSignalBps: opts.cloneProbeMinSignalBps,
    probeMaxPerCycle: opts.cloneProbeMaxPerCycle,
    inventoryRebalanceRatio: opts.cloneInventoryRebalanceRatio,
    parentConfirmOnly: Boolean(opts.cloneParentConfirmOnly),
    allowLearnedProbe: opts.cloneAllowLearnedProbe !== false,
    allowComboEntry: opts.cloneAllowComboEntry !== false,
    flowConfirmEnabled: Boolean(opts.cloneFlowConfirmEnabled),
    flowConfirmMinDominance: opts.cloneFlowConfirmMinDominance,
    flowConfirmMinRows: opts.cloneFlowConfirmMinRows,
    flowConfirmMinUsdc: opts.cloneFlowConfirmMinUsdc,
    flowConfirmMaxAgeSec: opts.cloneFlowConfirmMaxAgeSec,
    flowConfirmOpeningWindowSec: opts.cloneFlowConfirmOpeningWindowSec,
    flowConfirmOpeningMaxAgeSec: opts.cloneFlowConfirmOpeningMaxAgeSec,
    flowConfirmOpeningRowRatio: opts.cloneFlowConfirmOpeningRowRatio,
    flowConfirmMaxOpposingParentBps: opts.cloneFlowConfirmMaxOpposingParentBps,
    flowConfirmMinEdge: opts.cloneFlowConfirmMinEdge,
    maxOrdersPerWindow: opts.cloneMaxOrdersPerWindow,
    hedgeSignalBps: opts.cloneHedgeSignalBps,
    comboEntryMaxCost: opts.cloneComboEntryMaxCost,
    exitEnabled: Boolean(opts.cloneExitEnabled),
    exitFlipBps: opts.cloneExitFlipBps,
    exitTakeProfitPct: opts.cloneExitTakeProfitPct,
    exitStopLossPct: opts.cloneExitStopLossPct,
    exitBeforeEndSec: opts.cloneExitBeforeEndSec,
    matchSeconds: opts.cloneMatchSeconds,
    priceTolerance: opts.clonePriceTolerance,
    slippageBps: opts.cloneSlippageBps,
    liquidityParticipation: opts.cloneLiquidityParticipation,
    executionLatencyMs: opts.cloneExecutionLatencyMs,
    queueDelaySec: opts.cloneQueueDelaySec,
    minFillUsdc: opts.cloneMinFillUsdc,
    minVisibleDepthUsdc: opts.cloneMinVisibleDepthUsdc,
    makerPenetrationTicks: opts.cloneMakerPenetrationTicks,
    takerFeeRate: opts.cloneTakerFeeRate,
    makerFeeRate: opts.cloneMakerFeeRate,
    dailyLossLimitUsdc: opts.cloneDailyLossLimitUsdc,
    maxDirectionExposureUsdc: opts.cloneMaxDirectionExposureUsdc,
    maxConsecutiveLosses: opts.cloneMaxConsecutiveLosses,
    adaptive: Boolean(opts.cloneAdaptive),
    targetOrderRows: 0,
  };
}

function emptyClonePositions() {
  return {
    Up: { shares: 0, cost: 0, avgPrice: null, realizedProceeds: 0, realizedPnl: 0 },
    Down: { shares: 0, cost: 0, avgPrice: null, realizedProceeds: 0, realizedPnl: 0 },
  };
}

function ensureCloneState(state, opts) {
  ensureCloneLedger(state);
  if (!state.clone) state.clone = createInitialCloneState(opts);
  state.clone.enabled = Boolean(opts.clone && opts.slug);
  state.clone.asset = slugAsset(opts.slug) || state.clone.asset || "BTC";
  state.clone.baseConfig = cloneConfig(opts);
  state.clone.config = state.clone.baseConfig;
  if (!state.clone.positions) state.clone.positions = emptyClonePositions();
  for (const outcome of OUTCOMES) {
    if (!state.clone.positions[outcome]) state.clone.positions[outcome] = { shares: 0, cost: 0, avgPrice: null };
    state.clone.positions[outcome].realizedProceeds ||= 0;
    state.clone.positions[outcome].realizedPnl ||= 0;
  }
  state.clone.orders ||= [];
  state.clone.fills ||= [];
  state.clone.btc ||= createInitialCloneState(opts).btc;
  state.clone.btc.samples ||= [];
  state.clone.pnl ||= createInitialCloneState(opts).pnl;
  state.clone.calibration ||= createInitialCloneState(opts).calibration;
  state.clone.learner ||= createInitialCloneState(opts).learner;
  state.clone.risk ||= createInitialCloneState(opts).risk;
  state.clone.adaptive ||= createInitialCloneState(opts).adaptive;
  if (!state.clone.enabled) {
    state.clone.status = "disabled";
    state.clone.lastError = opts.clone ? "clone requires --slug or --event-url" : "";
  }
  ensureCloneVersion(state, opts);
  ensureCloneLedgerReset(state, opts);
  ensureClonePortfolioState(state, opts);
}

function ensureCloneLedger(state) {
  if (!Array.isArray(state.cloneHistory)) state.cloneHistory = [];
  if (!state.cloneCumulative) state.cloneCumulative = emptyCloneCumulative(state.cloneLedgerReset);
  if (!state.cloneVersionCumulative) state.cloneVersionCumulative = emptyCloneVersionCumulative(state.cloneVersion);
  if (!state.hourlyPerformance) state.hourlyPerformance = null;
  if (!state.activityBackfill) state.activityBackfill = null;
}

function attachCloneVersion(clone, version) {
  if (!clone || !version) return;
  clone.strategyVersionId = version.id;
  clone.strategyVersionName = version.name;
  clone.versionStartedAt = version.startedAt;
}

function ensureClonePortfolioState(state, opts) {
  state.clonePortfolio ||= {
    enabled: Boolean(opts.clone && opts.autoBtc5m),
    assets: {},
    updatedAt: null,
  };
  state.clonePortfolio.enabled = Boolean(opts.clone && opts.autoBtc5m);
  state.clonePortfolio.assets ||= {};
  if (state.clone) state.clonePortfolio.assets.BTC5m = state.clone;
  const nowSec = marketClockNowSec(opts);
  for (const leg of [...CRYPTO_LEGS].sort((a, b) => b.durationSec - a.durationSec)) {
    const slug = currentCryptoSlug(leg.asset, leg.horizon, nowSec);
    const assetOpts = cloneOptsForSlug(opts, slug);
    if (!state.clonePortfolio.assets[leg.key]) {
      state.clonePortfolio.assets[leg.key] = createInitialCloneState(assetOpts, slug);
      attachCloneVersion(state.clonePortfolio.assets[leg.key], state.cloneVersion);
      attachCloneLedgerReset(state.clonePortfolio.assets[leg.key], state.cloneLedgerReset);
    }
    const clone = state.clonePortfolio.assets[leg.key];
    clone.asset = leg.asset;
    clone.horizon = leg.horizon;
    clone.legKey = leg.key;
    clone.baseConfig = cloneConfig(assetOpts);
    if (!clone.config) clone.config = clone.baseConfig;
    clone.enabled = Boolean(opts.clone && slug);
    attachCloneVersion(clone, state.cloneVersion);
    attachCloneLedgerReset(clone, state.cloneLedgerReset);
  }
}

function cloneOptsForSlug(opts, slug) {
  const leg = cryptoLegForSlug(slug);
  const weight = Number.isFinite(num(leg?.budgetWeight, NaN)) ? num(leg.budgetWeight) : 1;
  const durationSec = slugWindowSeconds(slug);
  const isFiveMinute = durationSec <= 300;
  const asset = slugAsset(slug);
  const isEth = asset === "ETH";
  const durationFactor = durationSec > 300 ? 1.25 : 1;
  const entryStartSec = Math.min(num(opts.cloneEntryStartSec), Math.max(0, durationSec - 10));
  const entryEndSec = durationSec > 300
    ? Math.max(entryStartSec, durationSec - 4)
    : Math.min(num(opts.cloneEntryEndSec), durationSec);
  return {
    ...opts,
    slug,
    eventUrl: eventUrlForSlug(slug),
    cloneBudgetUsdc: round(num(opts.cloneBudgetUsdc) * weight * durationFactor, 2),
    cloneOrderUsdc: round(Math.max(POLYMARKET_MIN_ORDER_USDC, num(opts.cloneOrderUsdc) * Math.sqrt(weight)), 2),
    cloneProbeOrderUsdc: round(Math.max(POLYMARKET_MIN_ORDER_USDC, num(opts.cloneProbeOrderUsdc) * Math.sqrt(Math.max(0.35, weight))), 2),
    cloneMaxClipUsdc: round(Math.max(POLYMARKET_MIN_ORDER_USDC, num(opts.cloneMaxClipUsdc) * Math.sqrt(weight) * durationFactor), 2),
    cloneMaxDirectionExposureUsdc: round(num(opts.cloneMaxDirectionExposureUsdc) * weight * durationFactor, 2),
    cloneEntryStartSec: entryStartSec,
    cloneEntryEndSec: entryEndSec,
    cloneOrderTtlSec: durationSec > 300 ? Math.max(num(opts.cloneOrderTtlSec), 125) : opts.cloneOrderTtlSec,
    cloneExitBeforeEndSec: durationSec > 300 ? Math.max(num(opts.cloneExitBeforeEndSec), 75) : opts.cloneExitBeforeEndSec,
    cloneProbeEnabled: isFiveMinute ? false : opts.cloneProbeEnabled,
    cloneProbeMaxPerCycle: isFiveMinute ? 0 : opts.cloneProbeMaxPerCycle,
    cloneInventoryRebalanceRatio: isFiveMinute ? 0 : opts.cloneInventoryRebalanceRatio,
    cloneComboEntryMaxCost: isFiveMinute ? 0 : opts.cloneComboEntryMaxCost,
    cloneParentConfirmOnly: isFiveMinute,
    cloneAllowLearnedProbe: !isFiveMinute,
    cloneAllowComboEntry: !isFiveMinute,
    cloneFlowConfirmEnabled: Boolean(isFiveMinute || opts.cloneFlowConfirmEnabled),
    cloneFlowConfirmMinDominance: isFiveMinute ? (isEth ? 0.82 : 0.75) : (isEth ? Math.max(num(opts.cloneFlowConfirmMinDominance), 0.68) : opts.cloneFlowConfirmMinDominance),
    cloneFlowConfirmMinRows: isFiveMinute ? (isEth ? 12 : 18) : (isEth ? Math.max(num(opts.cloneFlowConfirmMinRows), 10) : opts.cloneFlowConfirmMinRows),
    cloneFlowConfirmMinUsdc: isFiveMinute ? (isEth ? 45 : 120) : (isEth ? Math.max(num(opts.cloneFlowConfirmMinUsdc), 35) : opts.cloneFlowConfirmMinUsdc),
    cloneFlowConfirmMaxAgeSec: isFiveMinute ? (isEth ? 30 : 42) : opts.cloneFlowConfirmMaxAgeSec,
    cloneFlowConfirmOpeningWindowSec: isFiveMinute ? (isEth ? 95 : 140) : opts.cloneFlowConfirmOpeningWindowSec,
    cloneFlowConfirmOpeningMaxAgeSec: isFiveMinute ? (isEth ? 130 : 210) : opts.cloneFlowConfirmOpeningMaxAgeSec,
    cloneFlowConfirmOpeningRowRatio: isFiveMinute ? (isEth ? 0.8 : 0.65) : opts.cloneFlowConfirmOpeningRowRatio,
    cloneFlowConfirmMaxOpposingParentBps: isFiveMinute ? (isEth ? 3.5 : 5) : opts.cloneFlowConfirmMaxOpposingParentBps,
    cloneFlowConfirmMinEdge: isFiveMinute ? (isEth ? 0.004 : -0.006) : (isEth ? Math.max(num(opts.cloneFlowConfirmMinEdge), 0.002) : opts.cloneFlowConfirmMinEdge),
    cloneMinSignalBps: isFiveMinute ? Math.max(num(opts.cloneMinSignalBps), isEth ? 4.4 : 3.2) : (isEth ? Math.max(num(opts.cloneMinSignalBps), 2.8) : opts.cloneMinSignalBps),
    cloneMinExpectedEdge: isFiveMinute ? Math.max(num(opts.cloneMinExpectedEdge), isEth ? 0.038 : 0.024) : (isEth ? Math.max(num(opts.cloneMinExpectedEdge), 0.026) : opts.cloneMinExpectedEdge),
    cloneMaxAsk: isFiveMinute ? Math.min(num(opts.cloneMaxAsk), isEth ? 0.88 : 0.94) : (isEth ? Math.min(num(opts.cloneMaxAsk), 0.93) : opts.cloneMaxAsk),
    cloneMinVisibleDepthUsdc: isEth ? Math.max(num(opts.cloneMinVisibleDepthUsdc), 2.5) : opts.cloneMinVisibleDepthUsdc,
  };
}

function attachCloneLedgerReset(clone, reset) {
  if (!clone || !reset) return;
  clone.ledgerResetId = reset.id;
  clone.ledgerResetName = reset.name;
  clone.ledgerResetStartedAt = reset.startedAt;
}

function ensureCloneVersion(state, opts) {
  const currentId = state.cloneVersion?.id || "";
  if (currentId !== STRATEGY_VERSION_ID) {
    if (state.clone?.market?.slug) archiveCloneWindow(state, state.clone, "strategy-version-reset");
    const nowSec = Math.floor(Date.now() / 1000);
    state.cloneVersion = {
      id: STRATEGY_VERSION_ID,
      name: STRATEGY_VERSION_NAME,
      startedAt: isoFromSec(nowSec),
      startSec: nowSec,
      resetReason: "start isolated accounting after settlement-hold and flow-scale rules",
    };
    state.cloneVersionCumulative = emptyCloneVersionCumulative(state.cloneVersion);
    state.clonePortfolio = null;
    state.clonePortfolioCumulative = null;
    state.clone = createInitialCloneState(opts);
    attachCloneVersion(state.clone, state.cloneVersion);
    attachCloneLedgerReset(state.clone, state.cloneLedgerReset);
    return true;
  }
  attachCloneVersion(state.clone, state.cloneVersion);
  return false;
}

function ensureCloneLedgerReset(state, opts) {
  const currentId = state.cloneLedgerReset?.id || "";
  if (currentId !== LEDGER_RESET_ID) {
    if (state.clone?.market?.slug) archiveCloneWindow(state, state.clone, "ledger-reset");
    const nowSec = Math.floor(Date.now() / 1000);
    state.cloneLedgerReset = {
      id: LEDGER_RESET_ID,
      name: LEDGER_RESET_NAME,
      startedAt: isoFromSec(nowSec),
      startSec: nowSec,
      resetReason: "user requested old total ledger to restart from zero",
    };
    state.cloneCumulative = emptyCloneCumulative(state.cloneLedgerReset);
    state.clonePortfolio = null;
    state.clonePortfolioCumulative = null;
    state.clone = createInitialCloneState(opts);
    attachCloneVersion(state.clone, state.cloneVersion);
    attachCloneLedgerReset(state.clone, state.cloneLedgerReset);
    return true;
  }
  attachCloneLedgerReset(state.clone, state.cloneLedgerReset);
  return false;
}

function applyActivity(state, row) {
  const key = rowKey(row);
  if (state.seen.includes(key)) return false;
  state.seen.push(key);
  const slug = row.slug || row.eventSlug;
  const windowStart = slugWindowStart(slug);
  const ts = num(row.timestamp, Math.floor(Date.now() / 1000));
  const window = getWindow(state, slug, row, windowStart);

  if (row.type === "TRADE") {
    const trade = {
      id: key,
      ts,
      isoTime: new Date(ts * 1000).toISOString(),
      slug,
      action: row.side || "TRADE",
      direction: row.outcome || "",
      price: round(row.price, 6),
      amountUsdc: round(row.usdcSize, 6),
      shares: round(row.size, 6),
      tx: row.transactionHash || "",
      reason: "live public activity mirror",
    };
    state.trades.push(trade);
    window.tradeRows += 1;
    if (row.side === "BUY") {
      window.buyRows += 1;
      window.buyUsdc = round(window.buyUsdc + num(row.usdcSize), 6);
      window.buyShares = round(window.buyShares + num(row.size), 6);
      window.direction = window.direction || row.outcome || "";
      if (!window.firstBuyTs || ts < window.firstBuyTs) window.firstBuyTs = ts;
      if (!window.lastBuyTs || ts > window.lastBuyTs) window.lastBuyTs = ts;
      window.avgBuyPrice = window.buyShares > 0 ? round(window.buyUsdc / window.buyShares, 6) : null;
    } else if (row.side === "SELL") {
      window.sellRows += 1;
      window.sellUsdc = round(window.sellUsdc + num(row.usdcSize), 6);
      window.sellShares = round(window.sellShares + num(row.size), 6);
    }
    return true;
  }

  if (row.type === "REDEEM") {
    if (!state.windows[slug] || state.windows[slug].buyRows <= 0) {
      return false;
    }
    const amount = num(row.usdcSize);
    if (row.outcome) window.direction = row.outcome;
    window.redeemRows += 1;
    window.redeemUsdc = round(window.redeemUsdc + amount, 6);
    window.settled = true;
    window.realizedPnl = round(window.sellUsdc + window.redeemUsdc - window.buyUsdc, 6);
    state.trades.push({
      id: key,
      ts,
      isoTime: new Date(ts * 1000).toISOString(),
      slug,
      action: "REDEEM",
      direction: window.direction || "",
      price: 1,
      amountUsdc: round(amount, 6),
      shares: round(row.size, 6),
      tx: row.transactionHash || "",
      pnl: window.realizedPnl,
      reason: "live redeem/settlement observed",
    });
    return true;
  }

  return false;
}

function getWindow(state, slug, row, windowStart) {
  if (!state.windows[slug]) {
    state.windows[slug] = {
      slug,
      asset: slugAsset(slug) || "",
      title: row.title || "",
      windowStart,
      windowEnd: windowStart ? windowStart + slugWindowSeconds(slug) : null,
      direction: row.outcome || "",
      tradeRows: 0,
      buyRows: 0,
      sellRows: 0,
      redeemRows: 0,
      buyUsdc: 0,
      sellUsdc: 0,
      redeemUsdc: 0,
      buyShares: 0,
      sellShares: 0,
      avgBuyPrice: null,
      firstBuyTs: null,
      lastBuyTs: null,
      settled: false,
      realizedPnl: 0,
    };
  }
  return state.windows[slug];
}

function parseJsonish(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isoFromSec(sec) {
  return new Date(sec * 1000).toISOString();
}

function isoSecondFromSec(sec) {
  return isoFromSec(sec).replace(".000Z", "Z");
}

async function fetchCloneMarket(slug, opts) {
  const event = await fetchJson(buildUrl(GAMMA_API_URL, `/events/slug/${encodeURIComponent(slug)}`), opts);
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const market = markets.find((row) => row.slug === slug) || markets[0] || {};
  const outcomes = parseJsonish(market.outcomes, OUTCOMES).map(String);
  const tokenIds = parseJsonish(market.clobTokenIds, []).map(String);
  const prices = parseJsonish(market.outcomePrices, []).map(Number);
  const outcomeTokenIds = {};
  const outcomePrices = {};
  outcomes.forEach((outcome, index) => {
    outcomeTokenIds[outcome] = tokenIds[index] || "";
    outcomePrices[outcome] = Number.isFinite(prices[index]) ? prices[index] : null;
  });
  const windowStart = slugWindowStart(slug);
  const windowSeconds = slugWindowSeconds(slug);
  const windowEnd = windowStart ? windowStart + windowSeconds : null;
  const nowSec = marketClockNowSec(opts);
  const clockLive = Number.isFinite(windowStart) && Number.isFinite(windowEnd)
    && nowSec >= windowStart
    && nowSec < windowEnd - 2;
  const asset = slugAsset(slug) || "BTC";
  const horizon = slugHorizon(slug) || "5m";
  const rawClosed = Boolean(event?.closed || market.closed);
  const resolvedOutcome = clockLive ? "" : inferResolvedOutcome(event, market, outcomes, outcomePrices);
  return {
    slug,
    asset,
    horizon,
    title: event?.title || market.question || slug,
    conditionId: market.conditionId || "",
    windowStart,
    windowEnd,
    closed: clockLive ? false : rawClosed,
    active: clockLive ? true : event?.active !== false && market.active !== false,
    acceptingOrders: clockLive ? true : market.acceptingOrders !== false && !rawClosed,
    enableOrderBook: event?.enableOrderBook !== false && market.enableOrderBook !== false,
    outcomes,
    outcomeTokenIds,
    outcomePrices,
    gamma: {
      bestBid: num(market.bestBid, null),
      bestAsk: num(market.bestAsk, null),
      lastTradePrice: num(market.lastTradePrice, null),
      endDate: event?.endDate || "",
      closedTime: event?.closedTime || "",
    },
    resolvedOutcome,
    fetchedAt: new Date().toISOString(),
    fetchedAtSec: Math.floor(Date.now() / 1000),
  };
}

function inferResolvedOutcome(event, market, outcomes, outcomePrices) {
  if (!event?.closed && !market?.closed && !event?.closedTime) return "";
  let best = "";
  let bestPrice = -Infinity;
  for (const outcome of outcomes || OUTCOMES) {
    const price = num(outcomePrices?.[outcome], NaN);
    if (Number.isFinite(price) && price > bestPrice) {
      best = outcome;
      bestPrice = price;
    }
  }
  return bestPrice >= 0.99 ? best : "";
}

async function fetchBtcPrice(market, opts) {
  const symbol = market?.asset || slugAsset(market?.slug) || "BTC";
  const errors = [];
  let poly = null;
  let candle = null;

  const [polyResult, candleResult] = await Promise.allSettled([
    fetchPolymarketCryptoPrice(market, opts),
    fetchPolymarketChainlinkCandles(opts, symbol),
  ]);
  if (polyResult.status === "fulfilled") poly = polyResult.value;
  else errors.push(`polymarket ${symbol} crypto-price: ${shortError(polyResult.reason)}`);
  if (candleResult.status === "fulfilled") candle = candleResult.value;
  else errors.push(`polymarket ${symbol} chainlink-candles: ${shortError(candleResult.reason)}`);

  const closePrice = finiteNum(poly?.closePrice);
  const candlePrice = finiteNum(candle?.price);
  const openPrice = finiteNum(poly?.openPrice);
  const price = closePrice ?? candlePrice ?? openPrice;
  if (Number.isFinite(price) && price > 0) {
    const sources = [];
    if (closePrice != null) sources.push("polymarket-crypto-close");
    else if (candlePrice != null) sources.push("polymarket-chainlink-candle");
    else sources.push("polymarket-crypto-open");
    if (openPrice != null) sources.push("polymarket-crypto-open");
    return {
      source: sources.join("+"),
      priceSource: closePrice != null ? "polymarket-crypto-close" : candlePrice != null ? "polymarket-chainlink-candle" : "polymarket-crypto-open",
      price,
      openPrice,
      closePrice,
      completed: Boolean(poly?.completed),
      incomplete: Boolean(poly?.incomplete),
      cached: Boolean(poly?.cached),
      cryptoTimestampMs: finiteNum(poly?.timestampMs),
      candle: candle?.candle || null,
      candleUpdatedAt: candle?.updatedAt || null,
      errors,
      updatedAt: new Date().toISOString(),
      ts: Math.floor(Date.now() / 1000),
    };
  }

  const external = await fetchExternalBtcSpot(opts, symbol);
  return {
    ...external,
    priceSource: `fallback-${external.source}`,
    openPrice,
    closePrice,
    completed: Boolean(poly?.completed),
    incomplete: Boolean(poly?.incomplete),
    cached: Boolean(poly?.cached),
    cryptoTimestampMs: finiteNum(poly?.timestampMs),
    candle: candle?.candle || null,
    candleUpdatedAt: candle?.updatedAt || null,
    errors,
  };
}

async function fetchPolymarketCryptoPrice(market, opts) {
  const symbol = market?.asset || slugAsset(market?.slug) || "BTC";
  const start = finiteNum(market?.windowStart);
  const end = finiteNum(market?.windowEnd);
  const horizon = market?.horizon || slugHorizon(market?.slug) || "5m";
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`missing ${symbol} ${horizon} window start/end`);
  const payload = await fetchJson(buildUrl(POLYMARKET_WEB_URL, "/api/crypto/crypto-price", {
    symbol,
    eventStartTime: isoSecondFromSec(start),
    variant: "fiveminute",
    endDate: isoSecondFromSec(end),
    _: Date.now(),
  }), opts);
  return {
    source: "polymarket-crypto-price",
    openPrice: finiteNum(payload?.openPrice),
    closePrice: finiteNum(payload?.closePrice),
    timestampMs: finiteNum(payload?.timestamp),
    completed: Boolean(payload?.completed),
    incomplete: Boolean(payload?.incomplete),
    cached: Boolean(payload?.cached),
  };
}

function settlementWinnerFromPrices(openPrice, closePrice) {
  const open = finiteNum(openPrice);
  const close = finiteNum(closePrice);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return "";
  if (close > open) return "Up";
  if (close < open) return "Down";
  return "";
}

async function fetchPolymarketSettlement(slug, opts) {
  const windowStart = slugWindowStart(slug);
  const symbol = slugAsset(slug) || "BTC";
  if (!Number.isFinite(windowStart)) throw new Error(`not a crypto 5m slug: ${slug}`);
  const windowEnd = windowStart + slugWindowSeconds(slug);
  const price = await fetchPolymarketCryptoPrice({ slug, asset: symbol, windowStart, windowEnd }, opts);
  const winner = price.completed ? settlementWinnerFromPrices(price.openPrice, price.closePrice) : "";
  return {
    source: "polymarket-crypto-price",
    checkedAt: new Date().toISOString(),
    windowStart,
    windowEnd,
    openPrice: Number.isFinite(finiteNum(price.openPrice)) ? round(price.openPrice, 8) : null,
    closePrice: Number.isFinite(finiteNum(price.closePrice)) ? round(price.closePrice, 8) : null,
    completed: Boolean(price.completed),
    incomplete: Boolean(price.incomplete),
    cached: Boolean(price.cached),
    timestampMs: finiteNum(price.timestampMs),
    winner,
  };
}

async function fetchPolymarketChainlinkCandles(opts, symbol = "BTC") {
  const payload = await fetchJson(buildUrl(POLYMARKET_WEB_URL, "/api/chainlink-candles", {
    symbol,
    interval: "5m",
    limit: 30,
    _: Date.now(),
  }), opts);
  const candles = normalizeArray(payload?.candles || payload)
    .map((row) => ({
      time: finiteNum(row.time ?? row.t),
      open: finiteNum(row.open ?? row.o),
      high: finiteNum(row.high ?? row.h),
      low: finiteNum(row.low ?? row.l),
      close: finiteNum(row.close ?? row.c),
    }))
    .filter((row) => Number.isFinite(row.time) && Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.time - b.time);
  const candle = candles[candles.length - 1] || null;
  if (!candle) throw new Error("empty Chainlink candle payload");
  return {
    source: "polymarket-chainlink-candles",
    price: candle.close,
    candle,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchExternalBtcSpot(opts, symbol = "BTC") {
  const upper = String(symbol || "BTC").toUpperCase();
  const coinbaseSymbol = `${upper}-USD`;
  const krakenPair = upper === "BTC" ? "XBTUSD" : `${upper}USD`;
  const sources = [
    {
      name: "coinbase",
      url: `https://api.coinbase.com/v2/prices/${coinbaseSymbol}/spot`,
      parse: (payload) => num(payload?.data?.amount, null),
    },
    {
      name: "kraken",
      url: `https://api.kraken.com/0/public/Ticker?pair=${krakenPair}`,
      parse: (payload) => {
        const result = payload?.result || {};
        const first = result[Object.keys(result)[0]];
        return num(first?.c?.[0], null);
      },
    },
    {
      name: "binance",
      url: `https://api.binance.com/api/v3/ticker/price?symbol=${upper}USDT`,
      parse: (payload) => num(payload?.price, null),
    },
  ];
  const errors = [];
  for (const source of sources) {
    try {
      const payload = await fetchJson(source.url, opts);
      const price = source.parse(payload);
      if (Number.isFinite(price) && price > 0) {
        return { source: source.name, price, updatedAt: new Date().toISOString(), ts: Math.floor(Date.now() / 1000) };
      }
    } catch (err) {
      errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`${upper} spot unavailable (${errors.join("; ")})`);
}

function normalizeBookLevels(levels, reverse = false) {
  const rows = Array.isArray(levels) ? levels : [];
  const normalized = rows
    .map((row) => ({
      price: round(row.price ?? row.p, 6),
      size: round(row.size ?? row.s, 6),
    }))
    .filter((row) => Number.isFinite(row.price) && row.price > 0 && Number.isFinite(row.size) && row.size > 0);
  normalized.sort((a, b) => reverse ? b.price - a.price : a.price - b.price);
  return normalized.slice(0, 12);
}

async function fetchOrderBook(tokenId, opts) {
  const payload = await fetchJson(buildUrl(CLOB_API_URL, "/book", { token_id: tokenId }), opts);
  const feeRate = await fetchTokenFeeRate(tokenId, opts);
  const bids = normalizeBookLevels(payload?.bids, true);
  const asks = normalizeBookLevels(payload?.asks, false);
  const bid = bids[0]?.price ?? null;
  const ask = asks[0]?.price ?? null;
  const mid = Number.isFinite(bid) && Number.isFinite(ask) ? round((bid + ask) / 2, 6) : null;
  return {
    source: "clob",
    tokenId,
    bid,
    ask,
    mid,
    spread: Number.isFinite(bid) && Number.isFinite(ask) ? round(ask - bid, 6) : null,
    takerFeeRate: feeRate,
    makerFeeRate: 0,
    minOrderSize: Math.max(POLYMARKET_MIN_ORDER_SHARES, finiteNum(payload?.min_order_size, POLYMARKET_MIN_ORDER_SHARES)),
    tickSize: finiteNum(payload?.tick_size),
    bids,
    asks,
    rawTimestamp: payload?.timestamp || null,
  };
}

async function fetchTokenFeeRate(tokenId, opts) {
  const cached = feeRateCache.get(tokenId);
  const now = Date.now();
  if (cached && now - cached.ts < 60_000) return cached.value;
  try {
    const payload = await fetchJson(`${CLOB_API_URL}/fee-rate/${tokenId}`, opts);
    const raw = finiteNum(payload?.base_fee ?? payload?.feeRate ?? payload?.fee_rate);
    const normalized = normalizeFeeRate(raw);
    if (Number.isFinite(normalized)) {
      feeRateCache.set(tokenId, { value: normalized, ts: now });
      return normalized;
    }
  } catch {
    // Fall back to the configured crypto taker fee rate.
  }
  return null;
}

function normalizeFeeRate(raw) {
  const value = finiteNum(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value > 1) return round(value / 10000, 6);
  return round(value, 6);
}

function fallbackQuoteFromGamma(market, outcome) {
  const price = market?.outcomePrices?.[outcome];
  if (!Number.isFinite(price)) {
    return {
      source: "gamma-unavailable",
      tokenId: market?.outcomeTokenIds?.[outcome] || "",
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      takerFeeRate: null,
      makerFeeRate: 0,
      minOrderSize: POLYMARKET_MIN_ORDER_SHARES,
      tickSize: null,
      bids: [],
      asks: [],
    };
  }
  const bid = round(clamp(price - 0.01, 0.01, 0.99), 6);
  const ask = round(clamp(price + 0.01, 0.01, 0.99), 6);
  return {
    source: "gamma-price-fallback",
    tokenId: market?.outcomeTokenIds?.[outcome] || "",
    bid,
    ask,
    mid: round(price, 6),
    spread: round(ask - bid, 6),
    takerFeeRate: null,
    makerFeeRate: 0,
    minOrderSize: POLYMARKET_MIN_ORDER_SHARES,
    tickSize: null,
    bids: [{ price: bid, size: 0 }],
    asks: [{ price: ask, size: 0 }],
  };
}

async function fetchOrderBooks(market, opts) {
  const quotes = {};
  const errors = [];
  if (market?.closed || market?.acceptingOrders === false) {
    for (const outcome of OUTCOMES) quotes[outcome] = fallbackQuoteFromGamma(market, outcome);
    return {
      source: "gamma-price-fallback-closed",
      updatedAt: new Date().toISOString(),
      Up: quotes.Up,
      Down: quotes.Down,
      comboAsk: Number.isFinite(quotes.Up?.ask) && Number.isFinite(quotes.Down?.ask) ? round(quotes.Up.ask + quotes.Down.ask, 6) : null,
      comboBid: Number.isFinite(quotes.Up?.bid) && Number.isFinite(quotes.Down?.bid) ? round(quotes.Up.bid + quotes.Down.bid, 6) : null,
    };
  }
  await Promise.all(OUTCOMES.map(async (outcome) => {
    const tokenId = market?.outcomeTokenIds?.[outcome];
    if (!tokenId) {
      quotes[outcome] = fallbackQuoteFromGamma(market, outcome);
      return;
    }
    try {
      quotes[outcome] = await fetchOrderBook(tokenId, opts);
    } catch (err) {
      errors.push(`${outcome}: ${shortError(err)}`);
      quotes[outcome] = fallbackQuoteFromGamma(market, outcome);
    }
  }));
  const comboAsk = Number.isFinite(quotes.Up?.ask) && Number.isFinite(quotes.Down?.ask)
    ? round(quotes.Up.ask + quotes.Down.ask, 6)
    : null;
  const comboBid = Number.isFinite(quotes.Up?.bid) && Number.isFinite(quotes.Down?.bid)
    ? round(quotes.Up.bid + quotes.Down.bid, 6)
    : null;
  return {
    source: errors.length ? `fallback (${errors.join("; ")})` : "clob",
    updatedAt: new Date().toISOString(),
    Up: quotes.Up,
    Down: quotes.Down,
    comboAsk,
    comboBid,
  };
}

function shortError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const http = message.match(/HTTP Error \d+:[^\r\n]*/);
  if (http) return http[0];
  const first = message.split(/\r?\n/).find(Boolean) || message;
  return first.length > 140 ? `${first.slice(0, 137)}...` : first;
}

async function refreshCloneEngine(state, opts) {
  ensureCloneState(state, opts);
  const nowSec = marketClockNowSec(state);
  opts.marketClockOffsetSec = num(state.marketClockOffsetSec, num(opts.marketClockOffsetSec, 0));
  ensureClonePortfolioState(state, opts);

  const orderedLegs = [...CRYPTO_LEGS].sort((a, b) => a.durationSec - b.durationSec);
  for (const leg of orderedLegs) {
    const slug = currentCryptoSlug(leg.asset, leg.horizon, nowSec);
    const assetOpts = cloneOptsForSlug(opts, slug);
    let clone = leg.key === "BTC5m" ? state.clone : state.clonePortfolio.assets[leg.key];
    if (!clone || clone.market?.slug !== slug) {
      if (clone?.market?.slug) archiveCloneWindow(state, clone, "auto-roll");
      clone = createInitialCloneState(assetOpts, slug);
      attachCloneVersion(clone, state.cloneVersion);
      attachCloneLedgerReset(clone, state.cloneLedgerReset);
      if (leg.key === "BTC5m") state.clone = clone;
      state.clonePortfolio.assets[leg.key] = clone;
    }
    const isFiveMinute = leg.durationSec <= 300;
    const lastRefreshSec = num(clone.lastRefreshSec, 0);
    if (!isFiveMinute && lastRefreshSec && nowSec - lastRefreshSec < 8) continue;
    await refreshOneCloneEngine(state, clone, assetOpts, nowSec);
    clone.lastRefreshSec = nowSec;
  }
  state.clonePortfolio.assets.BTC5m = state.clone;
  if (!state.settlementRefresh || nowSec - num(state.settlementRefresh.lastRunSec, 0) >= 60) {
    await refreshArchivedSettlements(state, opts, nowSec);
    await refreshObservedWindowSettlements(state, opts, nowSec);
    state.settlementRefresh = {
      lastRunSec: nowSec,
      lastRunAt: isoFromSec(nowSec),
    };
  }
  updateClonePortfolioSummary(state, nowSec);
  recomputeCloneCumulative(state);
}

async function refreshOneCloneEngine(state, clone, opts, nowSec) {
  clone.updatedAt = new Date().toISOString();
  if (!clone.enabled) return;
  try {
    sanitizeCloneMinimumTradeArtifacts(clone, nowSec);
    if (!clone.market || clone.market.slug !== opts.slug || nowSec - num(clone.market.fetchedAtSec, 0) >= 30) {
      clone.market = await fetchCloneMarket(opts.slug, opts);
      clone.asset = clone.market.asset || slugAsset(opts.slug) || clone.asset || "BTC";
      clone.horizon = clone.market.horizon || slugHorizon(opts.slug) || clone.horizon || "5m";
      clone.legKey = slugLegKey(opts.slug) || clone.legKey || `${clone.asset}${clone.horizon}`;
    }
    clone.btc = updateCloneBtcState(clone.btc, await fetchBtcPrice(clone.market, opts), clone.market, nowSec);
    clone.orderbook = await fetchOrderBooks(clone.market, opts);
    applyAdaptiveConfig(state, clone, nowSec);
    applyParentTrendFilter(state, clone);
    enforceCloneBudgetCaps(clone, nowSec);
    fillOpenCloneOrders(clone, nowSec);
    updateCloneAdverseSelection(clone, nowSec);
    updateClonePnl(state, clone);
    if (clone.config?.exitEnabled) {
      generateCloneExits(clone, nowSec);
      updateClonePnl(state, clone);
    }
    evaluateCloneRisk(state, clone);
    generateCloneOrders(clone, nowSec);
    updateClonePnl(state, clone);
    updateCloneAdverseSelection(clone, nowSec);
    evaluateCloneRisk(state, clone);
    updateCloneCalibration(state, clone, opts);
    if (clone.market?.closed || clone.pnl?.settled) archiveCloneWindow(state, clone, clone.pnl?.settled ? "settled" : "closed");
    clone.status = clone.market?.closed ? "closed" : clone.lastDecision?.status || "ok";
    clone.lastError = clone.orderbook?.source?.startsWith("fallback") ? clone.orderbook.source : "";
  } catch (err) {
    clone.status = "error";
    clone.lastError = err instanceof Error ? err.message : String(err);
  }
}

function updateCloneBtcState(previous, spot, market, nowSec) {
  const spotPrice = finiteNum(spot.price);
  const btc = {
    ...previous,
    source: spot.source,
    priceSource: spot.priceSource || spot.source,
    price: Number.isFinite(spotPrice) ? round(spotPrice, 6) : null,
    updatedAt: spot.updatedAt,
    polymarketOpenPrice: Number.isFinite(finiteNum(spot.openPrice)) ? round(spot.openPrice, 8) : null,
    polymarketClosePrice: Number.isFinite(finiteNum(spot.closePrice)) ? round(spot.closePrice, 8) : null,
    completed: Boolean(spot.completed),
    incomplete: Boolean(spot.incomplete),
    cached: Boolean(spot.cached),
    cryptoTimestampMs: finiteNum(spot.cryptoTimestampMs),
    candle: spot.candle || null,
    priceErrors: Array.isArray(spot.errors) ? spot.errors : [],
  };
  const start = num(market?.windowStart, null);
  btc.samples = Array.isArray(previous?.samples) ? previous.samples.slice(-120) : [];
  if (Number.isFinite(spotPrice)) {
    btc.samples.push({ ts: nowSec, isoTime: isoFromSec(nowSec), price: round(spotPrice, 6), source: spot.source });
  }
  if (Number.isFinite(finiteNum(spot.openPrice)) && spot.openPrice > 0) {
    btc.openPrice = round(spot.openPrice, 8);
    btc.openPriceSource = "polymarket-crypto-price";
    btc.openPriceErrorSec = 0;
  }
  if (Number.isFinite(start) && btc.samples.length) {
    const nearest = btc.samples
      .filter((row) => Math.abs(num(row.ts) - start) <= 20)
      .sort((a, b) => Math.abs(num(a.ts) - start) - Math.abs(num(b.ts) - start))[0];
    if (!Number.isFinite(finiteNum(spot.openPrice)) && nearest) {
      btc.openPrice = nearest.price;
      btc.openPriceSource = "nearest-sample-to-window-open";
      btc.openPriceErrorSec = num(nearest.ts) - start;
    } else if (!Number.isFinite(btc.openPrice) && nowSec >= start - 10 && Number.isFinite(spotPrice)) {
      btc.openPrice = round(spotPrice, 6);
      btc.openPriceSource = nowSec <= start + 20 ? "first-seen-near-window-open" : "first-seen-late";
      btc.openPriceErrorSec = nowSec - start;
    }
  }
  if (Number.isFinite(btc.openPrice) && btc.openPrice > 0 && Number.isFinite(spotPrice)) {
    btc.delta = round(spotPrice - btc.openPrice, 6);
    btc.deltaBps = round(((spotPrice - btc.openPrice) / btc.openPrice) * 10000, 4);
  }
  return btc;
}

function fairUpFromBtc(btc, market, nowSec) {
  if (!Number.isFinite(btc?.deltaBps)) return 0.5;
  const remaining = Math.max(1, num(market?.windowEnd, nowSec) - nowSec);
  const duration = slugWindowSeconds(market?.slug);
  const timeScale = clamp(Math.sqrt(remaining / duration), 0.15, 1);
  const scaleBps = 1.5 + 7.5 * timeScale;
  const z = clamp(btc.deltaBps / scaleBps, -7, 7);
  return clamp(1 / (1 + Math.exp(-z)), 0.02, 0.98);
}

function cloneSignalModel(clone, nowSec) {
  const btc = clone.btc || {};
  const market = clone.market || {};
  const cfg = clone.config || {};
  const deltaBps = num(btc.deltaBps, 0);
  const velocityBps = btcVelocityBps(btc, nowSec);
  const bookLeanBps = orderbookLeanBps(clone.orderbook);
  const remaining = Math.max(1, num(market.windowEnd, nowSec) - nowSec);
  const duration = slugWindowSeconds(market.slug);
  const timeScale = clamp(Math.sqrt(remaining / duration), 0.12, 1);
  const signalBps = round(deltaBps + velocityBps * 0.45 + bookLeanBps * 0.25, 4);
  const scaleBps = 1.2 + 6.8 * timeScale;
  const z = clamp(signalBps / scaleBps, -7, 7);
  const fairUp = clamp(1 / (1 + Math.exp(-z)), 0.01, 0.99);
  const preferred = signalBps >= num(cfg.minSignalBps) ? "Up" : signalBps <= -num(cfg.minSignalBps) ? "Down" : "";
  const confidence = clamp((Math.abs(signalBps) - num(cfg.minSignalBps)) / Math.max(0.1, num(cfg.whaleConfidenceBps) - num(cfg.minSignalBps)), 0, 1);
  return {
    fairUp,
    fair: { Up: fairUp, Down: 1 - fairUp },
    preferred,
    signalBps,
    deltaBps,
    velocityBps,
    bookLeanBps,
    confidence,
    remainingSec: remaining,
  };
}

function btcVelocityBps(btc, nowSec) {
  const samples = Array.isArray(btc?.samples) ? btc.samples : [];
  const latest = samples[samples.length - 1];
  if (!latest || !Number.isFinite(num(latest.price, NaN))) return 0;
  const older = [...samples].reverse().find((row) => (
    Number.isFinite(num(row.ts, NaN))
    && Number.isFinite(num(row.price, NaN))
    && nowSec - num(row.ts) >= 8
    && nowSec - num(row.ts) <= 45
  ));
  if (!older || num(older.price) <= 0) return 0;
  const seconds = Math.max(1, num(latest.ts, nowSec) - num(older.ts));
  const bps = ((num(latest.price) - num(older.price)) / num(older.price)) * 10000;
  return round(bps * Math.min(1, 20 / seconds), 4);
}

function orderbookLeanBps(orderbook) {
  const upMid = Number.isFinite(orderbook?.Up?.mid) ? orderbook.Up.mid : null;
  const downMid = Number.isFinite(orderbook?.Down?.mid) ? orderbook.Down.mid : null;
  if (upMid == null || downMid == null) return 0;
  const normalizedUp = upMid + downMid > 0 ? upMid / (upMid + downMid) : 0.5;
  const upDepth = visibleAskDepthUsdc(orderbook.Up, orderbook.Up?.ask ?? 1);
  const downDepth = visibleAskDepthUsdc(orderbook.Down, orderbook.Down?.ask ?? 1);
  const depthLean = upDepth + downDepth > 0 ? (downDepth - upDepth) / (upDepth + downDepth) : 0;
  return round((normalizedUp - 0.5) * 10 + depthLean * 1.5, 4);
}

function positionInventory(clone) {
  const up = clone.positions?.Up || {};
  const down = clone.positions?.Down || {};
  return {
    Up: {
      shares: num(up.shares),
      cost: num(up.cost),
      pending: pendingByDirection(clone, "Up"),
      avgPrice: num(up.avgPrice, null),
    },
    Down: {
      shares: num(down.shares),
      cost: num(down.cost),
      pending: pendingByDirection(clone, "Down"),
      avgPrice: num(down.avgPrice, null),
    },
  };
}

function inventoryMultiplier(clone, outcome) {
  const inv = positionInventory(clone);
  const other = outcome === "Up" ? "Down" : "Up";
  const own = inv[outcome].cost + inv[outcome].pending;
  const opposing = inv[other].cost + inv[other].pending;
  const total = Math.max(1, own + opposing);
  const skew = (opposing - own) / total;
  return clamp(1 + skew * num(clone.config?.inventoryRebalanceRatio, 0.35), 0.35, 1.8);
}

function directionOpenPnl(clone, outcome) {
  const position = clone.positions?.[outcome] || {};
  const shares = num(position.shares);
  const cost = num(position.cost);
  if (shares <= 0 || cost <= 0) return 0;
  const quote = clone.orderbook?.[outcome] || {};
  const mark = Number.isFinite(quote.bid) ? num(quote.bid) : Number.isFinite(quote.mid) ? num(quote.mid) : 0;
  const exitFee = shares * feePerShare(mark, num(clone.config?.takerFeeRate, 0.07));
  return round(Math.max(0, shares * mark - exitFee) - cost, 6);
}

function losingDirectionCap(clone, outcome, directionTotal) {
  const cfg = clone.config || {};
  const pnl = directionOpenPnl(clone, outcome);
  const adverse = clone.adverseSelection?.byDirection?.[outcome] || {};
  const adverseRate = num(adverse.rate);
  const baseCap = Math.max(num(cfg.maxClipUsdc, 1) * 3, num(cfg.budgetUsdc) * 0.34, POLYMARKET_MIN_ORDER_USDC);
  const tightenedCap = adverseRate >= 0.45 ? baseCap * 0.55 : baseCap;
  const hardLoss = pnl < -Math.max(num(cfg.orderUsdc, 1) * 4, directionTotal * 0.08);
  return hardLoss && directionTotal >= tightenedCap;
}

function minCloneOrderNotional(clone, outcome, effectivePrice) {
  const cfg = clone.config || {};
  const quote = clone.orderbook?.[outcome] || {};
  const minUsdc = Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.minFillUsdc, POLYMARKET_MIN_ORDER_USDC));
  const minShares = Math.max(POLYMARKET_MIN_ORDER_SHARES, num(quote.minOrderSize, POLYMARKET_MIN_ORDER_SHARES));
  const price = Number.isFinite(effectivePrice) && effectivePrice > 0 ? effectivePrice : 0;
  return round(Math.max(minUsdc, minShares * price), 6);
}

function dynamicCloneNotional(clone, candidate, limitPrice, elapsed, minNotional = POLYMARKET_MIN_ORDER_USDC) {
  const cfg = clone.config || {};
  const probeLike = candidate.kind === "probe" || candidate.kind === "learned-probe";
  const base = probeLike ? num(cfg.probeOrderUsdc, 1) : num(cfg.orderUsdc, 1);
  const signalAbs = Math.abs(num(candidate.signalBps));
  const confidence = clamp((signalAbs - num(cfg.minSignalBps)) / Math.max(0.1, num(cfg.highConfidenceBps) - num(cfg.minSignalBps)), 0, 1);
  const whale = clamp((signalAbs - num(cfg.highConfidenceBps)) / Math.max(0.1, num(cfg.whaleConfidenceBps) - num(cfg.highConfidenceBps)), 0, 1);
  const expectedEdge = num(candidate.edge);
  const expectedReturn = Number.isFinite(limitPrice) && limitPrice > 0 ? expectedEdge / limitPrice : 0;
  const edgeFactor = clamp(1 + expectedReturn * 8, 0.45, 3.2);
  const confidenceFactor = 0.7 + confidence * 3.2 + whale * 4.5;
  const flowRows = num(cfg.observedRecentBuyRows30s) + Math.max(0, num(cfg.observedBurstPeak1s) - 1);
  const flowFactor = candidate.kind === "learned-probe"
    ? clamp(1 + flowRows / 8, 1, 3.5)
    : 1;
  const observedSizeFactor = Number.isFinite(num(cfg.observedMedianBuyUsdc, NaN)) && num(cfg.observedMedianBuyUsdc) > 0
    ? clamp(num(cfg.observedMedianBuyUsdc) / Math.max(1, base), 0.8, 3)
    : 1;
  const inventoryFactor = inventoryMultiplier(clone, candidate.outcome);
  const hedgeFactor = candidate.kind === "hedge" ? 0.45 : probeLike ? 0.75 : 1;
  const flowCarryFactor = candidate.kind === "flow-carry" ? 0.55 : candidate.kind === "flow-confirm" ? 0.85 : 1;
  const ladderFactor = candidate.style === "maker-ladder" ? 0.55 : 1;
  const duration = slugWindowSeconds(clone.market?.slug);
  const timeFactor = 0.8 + clamp(elapsed / duration, 0, 1) * 0.45;
  const recentPnl = num(clone.pnl?.unrealized, 0);
  const pnlFactor = recentPnl < -base * 4 ? 0.65 : recentPnl > base * 6 ? 1.25 : 1;
  const highFrequency = num(cfg.targetOrderRows) >= 70 || num(cfg.observedWindowBuyRows) >= 35 || num(cfg.observedRecentBuyRows30s) >= 4;
  const microFillFactor = highFrequency && probeLike ? 0.42 : highFrequency ? 0.62 : 1;
  const childDecay = num(candidate.childIndex) > 0 ? 0.82 : 1;
  const raw = base * edgeFactor * confidenceFactor * flowFactor * observedSizeFactor * inventoryFactor * hedgeFactor * flowCarryFactor * ladderFactor * timeFactor * pnlFactor * microFillFactor * childDecay;
  const minClip = Math.max(POLYMARKET_MIN_ORDER_USDC, num(minNotional, POLYMARKET_MIN_ORDER_USDC));
  const maxClip = candidate.kind === "probe"
    ? Math.min(num(cfg.maxClipUsdc, 2.5), Math.max(num(cfg.probeOrderUsdc, 1) * 2, minClip))
    : Math.max(num(cfg.maxClipUsdc, 2.5), minClip);
  return ceilMoney(clamp(raw, minClip, maxClip), 2);
}

function feeRateForOrder(clone, outcome, style) {
  const quote = clone.orderbook?.[outcome];
  const cfg = clone.config || {};
  const fallback = style === "maker-ladder" ? num(cfg.makerFeeRate, 0) : num(cfg.takerFeeRate, 0.07);
  return style === "maker-ladder"
    ? num(quote?.makerFeeRate, fallback)
    : num(quote?.takerFeeRate, fallback);
}

function feePerShare(price, feeRate) {
  const p = num(price, NaN);
  const rate = num(feeRate, 0);
  if (!Number.isFinite(p) || p <= 0 || rate <= 0) return 0;
  return Math.max(0, rate * p * (1 - p));
}

function effectiveBuyPrice(price, feeRate) {
  return round(num(price) + feePerShare(price, feeRate), 6);
}

function cloneSpent(clone) {
  return round(OUTCOMES.reduce((total, outcome) => total + num(clone.positions?.[outcome]?.cost), 0), 6);
}

function cloneBuyCost(clone) {
  return round((clone.fills || [])
    .filter((fill) => fill.action === "BUY")
    .reduce((total, fill) => total + num(fill.amountUsdc), 0), 6);
}

function cloneSellProceeds(clone) {
  return round((clone.fills || [])
    .filter((fill) => fill.action === "SELL")
    .reduce((total, fill) => total + num(fill.amountUsdc), 0), 6);
}

function clonePending(clone) {
  return round((clone.orders || [])
    .filter((order) => ["OPEN", "PARTIAL"].includes(order.status))
    .reduce((total, order) => total + num(order.limitPrice) * remainingOrderShares(order), 0), 6);
}

function enforceCloneBudgetCaps(clone, nowSec) {
  const cfg = clone.config || {};
  const budget = num(cfg.budgetUsdc, Infinity);
  if (!Number.isFinite(budget)) return;
  const spent = cloneSpent(clone);
  const allowedPending = Math.max(0, budget - spent);
  if (clonePending(clone) <= allowedPending + 0.000001) return;
  for (const order of clone.orders || []) {
    if (!["OPEN", "PARTIAL"].includes(order.status)) continue;
    order.status = num(order.filledShares) > 0 ? "EXPIRED_PARTIAL" : "EXPIRED";
    order.updatedAt = isoFromSec(nowSec);
    order.cancelReason = "expired because small window budget cap was reached";
  }
  clone.lastDecision = {
    ts: nowSec,
    isoTime: isoFromSec(nowSec),
    status: "budget-full",
    spent,
    pending: clonePending(clone),
    reason: "paper budget reached",
  };
}

function remainingOrderShares(order) {
  const filled = num(order.filledShares);
  const remaining = Number.isFinite(Number(order.remainingShares)) ? num(order.remainingShares) : num(order.shares) - filled;
  return Math.max(0, remaining);
}

function pendingByDirection(clone, outcome) {
  return round((clone.orders || [])
    .filter((order) => order.direction === outcome && ["OPEN", "PARTIAL"].includes(order.status))
    .reduce((total, order) => total + num(order.limitPrice) * remainingOrderShares(order), 0), 6);
}

function visibleAskDepthUsdc(quote, limitPrice) {
  const levels = Array.isArray(quote?.asks) ? quote.asks : [];
  return round(levels
    .filter((level) => Number.isFinite(num(level.price, NaN)) && num(level.price) <= limitPrice)
    .reduce((total, level) => total + num(level.price) * num(level.size), 0), 6);
}

function orderbookTickSize(quote) {
  return Math.max(0.001, num(quote?.tickSize, 0.01));
}

function makerFillLimitPrice(order, quote, cfg) {
  const ticks = Math.max(0, num(cfg?.makerPenetrationTicks, 1));
  return round(num(order.limitPrice) - orderbookTickSize(quote) * ticks, 6);
}

function cloneFillLimitPrice(order, quote, cfg) {
  if (order?.style === "maker-ladder") return makerFillLimitPrice(order, quote, cfg);
  return num(order?.limitPrice, NaN);
}

function visibleAskLevelsAtOrBelow(quote, limitPrice) {
  return (Array.isArray(quote?.asks) ? quote.asks : [])
    .map((level) => ({ price: num(level.price), size: num(level.size) }))
    .filter((level) => (
      Number.isFinite(level.price)
      && Number.isFinite(level.size)
      && level.price > 0
      && level.size > 0
      && level.price <= limitPrice
    ))
    .sort((a, b) => a.price - b.price);
}

function median(values) {
  const rows = values
    .map((value) => num(value, NaN))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function p75(values) {
  const rows = values
    .map((value) => num(value, NaN))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!rows.length) return null;
  return rows[Math.min(rows.length - 1, Math.floor(rows.length * 0.75))];
}

function takerLimitPrice(ask, cfg) {
  if (!Number.isFinite(num(ask, NaN))) return null;
  const slipped = ask * (1 + num(cfg.slippageBps) / 10000);
  return round(clamp(Math.ceil(slipped * 100) / 100, 0.01, num(cfg.maxAsk, 0.99)), 2);
}

function evaluateCloneRisk(state, clone) {
  const cfg = clone.config || {};
  const today = new Date().toISOString().slice(0, 10);
  const ledgerRows = cloneLedgerRows(state);
  const todaysRows = ledgerRows.filter((row) => String(row.archivedAt || "").slice(0, 10) === today);
  const finalizedLoss = todaysRows.reduce((total, row) => total + Math.min(0, num(row.pnl)), 0);
  const currentLoss = Math.min(0, num(clone.pnl?.settled ? clone.pnl?.realized : clone.pnl?.unrealized));
  const dailyLoss = round(finalizedLoss + currentLoss, 6);
  const sorted = [...ledgerRows].sort((a, b) => num(b.windowStart) - num(a.windowStart));
  let consecutiveLosses = 0;
  for (const row of sorted) {
    if (num(row.pnl) < 0) consecutiveLosses += 1;
    else break;
  }
  const directionExposure = emptyDirectionExposure();
  for (const outcome of OUTCOMES) {
    directionExposure[outcome].cost = round(num(clone.positions?.[outcome]?.cost), 6);
    directionExposure[outcome].pending = pendingByDirection(clone, outcome);
    directionExposure[outcome].total = round(directionExposure[outcome].cost + directionExposure[outcome].pending, 6);
  }
  const reasons = [];
  if (num(cfg.dailyLossLimitUsdc) > 0 && Math.abs(dailyLoss) >= num(cfg.dailyLossLimitUsdc)) {
    reasons.push(`daily loss ${round(dailyLoss, 2)} reached limit ${cfg.dailyLossLimitUsdc}`);
  }
  if (num(cfg.maxConsecutiveLosses) > 0 && consecutiveLosses >= num(cfg.maxConsecutiveLosses)) {
    reasons.push(`consecutive losses ${consecutiveLosses} reached limit ${cfg.maxConsecutiveLosses}`);
  }
  clone.risk = {
    paused: false,
    warnOnly: true,
    reason: reasons.join("; "),
    dailyLoss,
    consecutiveLosses,
    directionExposure,
    updatedAt: new Date().toISOString(),
  };
  return clone.risk;
}

function learnBonereaperStrategy(state, clone, nowSec) {
  const slug = clone.market?.slug || state.slug || "";
  const windowStart = num(clone.market?.windowStart, slugWindowStart(slug));
  const currentRows = (state.trades || []).filter((row) => row.slug === slug);
  const buys = currentRows
    .filter((row) => row.action === "BUY")
    .sort((a, b) => num(a.ts) - num(b.ts));
  const sells = currentRows
    .filter((row) => row.action === "SELL")
    .sort((a, b) => num(a.ts) - num(b.ts));
  const recentBuys = buys.filter((row) => nowSec - num(row.ts) <= 30);
  const byOutcome = {};
  for (const outcome of OUTCOMES) {
    const rows = buys.filter((row) => row.direction === outcome);
    const usdc = rows.reduce((total, row) => total + num(row.amountUsdc), 0);
    const shares = rows.reduce((total, row) => total + num(row.shares), 0);
    byOutcome[outcome] = {
      rows: rows.length,
      usdc: round(usdc, 6),
      shares: round(shares, 6),
      avgPrice: shares > 0 ? round(usdc / shares, 6) : null,
    };
  }
  const preferredOutcome = byOutcome.Up.usdc > byOutcome.Down.usdc ? "Up" : byOutcome.Down.usdc > byOutcome.Up.usdc ? "Down" : "";
  const elapsedRows = Number.isFinite(windowStart)
    ? buys.map((row) => num(row.ts) - windowStart).filter((value) => Number.isFinite(value))
    : [];
  const seconds = new Map();
  for (const row of buys) seconds.set(num(row.ts), num(seconds.get(num(row.ts))) + 1);
  const burstPeak1s = seconds.size ? Math.max(...seconds.values()) : 0;
  const windows = Object.values(state.windows || {})
    .filter((row) => row.slug !== slug && (slugAsset(row.slug) || "BTC") === (clone.asset || slugAsset(slug) || "BTC") && num(row.buyRows) > 0 && isCrypto5mSlug(row.slug))
    .sort((a, b) => num(b.windowStart) - num(a.windowStart))
    .slice(0, 48);
  const medianBuyUsdc = median(buys.map((row) => row.amountUsdc));
  const p75BuyUsdc = p75(buys.map((row) => row.amountUsdc));
  const totalBuyUsdc = byOutcome.Up.usdc + byOutcome.Down.usdc;
  const preferredUsdc = preferredOutcome ? byOutcome[preferredOutcome].usdc : 0;
  const preferredRows = preferredOutcome ? byOutcome[preferredOutcome].rows : 0;
  const flowDominance = totalBuyUsdc > 0 ? preferredUsdc / totalBuyUsdc : 0;
  const medianWindowBuyRows = median(windows.map((row) => row.buyRows));
  const medianWindowBuyUsdc = median(windows.map((row) => row.buyUsdc));
  const p75WindowBuyRows = p75(windows.map((row) => row.buyRows));
  const firstBuyElapsedSec = elapsedRows.length ? Math.min(...elapsedRows) : null;
  const lastBuyElapsedSec = elapsedRows.length ? Math.max(...elapsedRows) : null;
  const lastBuyAgeSec = buys.length ? nowSec - num(buys[buys.length - 1].ts) : null;
  const windowDuration = slugWindowSeconds(slug);
  const suggested = {};
  const notes = [];
  if (elapsedRows.length) {
    suggested.entryStartSec = Math.max(0, Math.floor(Math.min(...elapsedRows) - 8));
    suggested.entryEndSec = Math.min(windowDuration, Math.ceil(Math.max(...elapsedRows) + 18));
    notes.push(`当前窗口观察入场 ${round(firstBuyElapsedSec, 1)}s-${round(lastBuyElapsedSec, 1)}s`);
  } else if (windows.length) {
    const firsts = windows.map((row) => Number.isFinite(num(row.firstBuyTs, NaN)) ? num(row.firstBuyTs) - num(row.windowStart) : NaN);
    const lasts = windows.map((row) => Number.isFinite(num(row.lastBuyTs, NaN)) ? num(row.lastBuyTs) - num(row.windowStart) : NaN);
    const firstP50 = median(firsts);
    const lastP75 = p75(lasts);
    if (Number.isFinite(firstP50)) suggested.entryStartSec = Math.max(0, Math.floor(firstP50 - 12));
    if (Number.isFinite(lastP75)) suggested.entryEndSec = Math.min(windowDuration, Math.ceil(lastP75 + 20));
  }
  if (buys.length) {
    suggested.probeMaxPerCycle = Math.max(18, Math.min(100, Math.ceil(Math.max(recentBuys.length * 2.4, burstPeak1s * 8, buys.length * 0.9, num(p75WindowBuyRows, 12) * 0.75))));
    suggested.targetOrderRows = Math.max(30, Math.min(180, Math.ceil(Math.max(buys.length * 1.2, recentBuys.length * 3.2, burstPeak1s * 14, num(p75WindowBuyRows, 12) * 0.9))));
    suggested.preferredOutcome = preferredOutcome;
    notes.push(`当前窗口买入 ${buys.length} 笔，近30秒 ${recentBuys.length} 笔，1秒峰值 ${burstPeak1s} 笔`);
  } else if (Number.isFinite(p75WindowBuyRows)) {
    suggested.probeMaxPerCycle = Math.max(18, Math.min(80, Math.ceil(p75WindowBuyRows * 0.7)));
    suggested.targetOrderRows = Math.max(30, Math.min(160, Math.ceil(p75WindowBuyRows * 0.9)));
  }
  if (Number.isFinite(medianBuyUsdc)) suggested.medianBuyUsdc = round(medianBuyUsdc, 6);
  if (Number.isFinite(p75BuyUsdc)) suggested.p75BuyUsdc = round(p75BuyUsdc, 6);
  clone.learner = {
    enabled: true,
    slug,
    currentObservedBuys: buys.length,
    currentObservedSells: sells.length,
    preferredOutcome,
    byOutcome,
    currentBuyUsdc: round(byOutcome.Up.usdc + byOutcome.Down.usdc, 6),
    firstBuyElapsedSec: Number.isFinite(firstBuyElapsedSec) ? round(firstBuyElapsedSec, 3) : null,
    lastBuyElapsedSec: Number.isFinite(lastBuyElapsedSec) ? round(lastBuyElapsedSec, 3) : null,
    lastBuyAgeSec: Number.isFinite(lastBuyAgeSec) ? round(lastBuyAgeSec, 3) : null,
    recentBuyRows30s: recentBuys.length,
    burstPeak1s,
    totalBuyUsdc: round(totalBuyUsdc, 6),
    preferredUsdc: round(preferredUsdc, 6),
    preferredRows,
    flowDominance: round(flowDominance, 6),
    medianBuyUsdc: Number.isFinite(medianBuyUsdc) ? round(medianBuyUsdc, 6) : null,
    p75BuyUsdc: Number.isFinite(p75BuyUsdc) ? round(p75BuyUsdc, 6) : null,
    medianWindowBuyRows: Number.isFinite(medianWindowBuyRows) ? round(medianWindowBuyRows, 3) : null,
    medianWindowBuyUsdc: Number.isFinite(medianWindowBuyUsdc) ? round(medianWindowBuyUsdc, 6) : null,
    p75WindowBuyRows: Number.isFinite(p75WindowBuyRows) ? round(p75WindowBuyRows, 3) : null,
    suggested,
    notes,
    updatedAt: isoFromSec(nowSec),
  };
  return clone.learner;
}

function applyAdaptiveConfig(state, clone, nowSec = Math.floor(Date.now() / 1000)) {
  const base = clone.baseConfig || clone.config || {};
  const cfg = { ...base };
  const suggestions = [];
  const adjustments = {};
  const enabled = Boolean(base.adaptive);
  const learner = learnBonereaperStrategy(state, clone, nowSec);
  if (enabled) {
    const history = (state.cloneHistory || []).filter((row) => (
      String(row.strategyVersionId || "") === String(clone.strategyVersionId || STRATEGY_VERSION_ID)
      && (!clone.ledgerResetId || String(row.ledgerResetId || "") === String(clone.ledgerResetId))
      && ((row.asset || slugAsset(row.slug) || "BTC") === (clone.asset || "BTC"))
    ));
    const recent = history.slice(0, 8);
    const recentAvgPnl = recent.length ? recent.reduce((total, row) => total + num(row.pnl), 0) / recent.length : 0;
    const recentLosses = recent.filter((row) => num(row.pnl) < 0).length;
    const backtestRows = history.filter((row) => num(row.cost) > 0).slice(0, 24);
    const backtestPnl = backtestRows.reduce((total, row) => total + num(row.pnl), 0);
    const backtestCost = backtestRows.reduce((total, row) => total + num(row.cost), 0);
    const backtestWinRate = backtestRows.length
      ? backtestRows.filter((row) => num(row.pnl) > 0).length / backtestRows.length
      : 0;
    const backtestPositive = backtestRows.length >= 12
      && backtestPnl > Math.max(50, backtestCost * 0.02)
      && backtestWinRate >= 0.5;
    let lossStreak = 0;
    for (const row of history) {
      if (num(row.pnl) < 0) lossStreak += 1;
      else break;
    }
    const cal = clone.calibration || {};
    const directionRate = num(cal.directionMatchRate, NaN);
    const signedTime = num(cal.avgSignedTimeErrorSec, 0);
    const extra = num(cal.extraCloneRows);
    const missed = num(cal.missedObservedRows);
    if (Number.isFinite(directionRate) && directionRate < 0.25 && missed > extra) {
      cfg.minEdge = round(Math.max(0.005, num(cfg.minEdge) - 0.005), 4);
      adjustments.minEdge = cfg.minEdge;
      suggestions.push("lowered minEdge because observed buys are being missed");
    } else if (extra > missed * 0.8 && extra > 10) {
      cfg.minEdge = round(Math.min(0.08, num(cfg.minEdge) + 0.005), 4);
      adjustments.minEdge = cfg.minEdge;
      suggestions.push("raised minEdge because clone is over-trading");
    }
    if (signedTime > 8) {
      cfg.entryStartSec = Math.max(2, num(cfg.entryStartSec) - 5);
      adjustments.entryStartSec = cfg.entryStartSec;
      suggestions.push("moved entry earlier because clone fills are late");
    } else if (signedTime < -8) {
      cfg.entryStartSec = Math.min(90, num(cfg.entryStartSec) + 5);
      adjustments.entryStartSec = cfg.entryStartSec;
      suggestions.push("moved entry later because clone fills are early");
    }
    if (recent.length >= 3 && recentAvgPnl < 0) {
      cfg.orderUsdc = round(Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.orderUsdc) * 0.9), 2);
      adjustments.orderUsdc = cfg.orderUsdc;
      suggestions.push("reduced order size after recent losing windows");
    }
    cfg.hedgeEnabled = false;
    cfg.hedgeMaxAsk = 0;
    cfg.exitEnabled = false;
    adjustments.hedgeEnabled = false;
    adjustments.hedgeMaxAsk = 0;
    adjustments.exitEnabled = false;
    suggestions.push("disabled cheap counter-trend hedge");
    suggestions.push("settlement-hold mode: do not sell intrawindow; wait for final result like Bonereaper");
    const currentObservedUsdc = num(learner?.currentBuyUsdc);
    const medianWindowUsdc = num(learner?.medianWindowBuyUsdc);
    const medianBuyUsdc = num(learner?.medianBuyUsdc);
    const p75BuyUsdc = num(learner?.p75BuyUsdc);
    const observedRows = num(learner?.currentObservedBuys);
    const recentFlowRows = num(learner?.recentBuyRows30s);
    const burstPeak = num(learner?.burstPeak1s);
    const flowReferenceUsdc = Math.max(currentObservedUsdc, medianWindowUsdc, 0);
    const losingMode = lossStreak >= 3 || (recent.length >= 5 && recentLosses >= 4 && recentAvgPnl < 0);
    const flowScale = losingMode ? 0.035 : backtestPositive ? 0.12 : 0.07;
    const learnedTargetRows = num(learner?.suggested?.targetOrderRows, NaN);
    const targetOrderRows = Number.isFinite(learnedTargetRows)
      ? clamp(learnedTargetRows, 30, losingMode ? 110 : backtestPositive ? 190 : 160)
      : clamp(Math.max(observedRows * 1.1, num(learner?.p75WindowBuyRows, 0) * 0.85), 30, 150);
    const targetBudget = flowReferenceUsdc > 0
      ? clamp(
        Math.max(
          90,
          currentObservedUsdc * flowScale,
          medianWindowUsdc * flowScale * 0.65,
          targetOrderRows * (losingMode ? 1.2 : 1.85),
        ),
        60,
        losingMode ? 260 : backtestPositive ? 800 : 520,
      )
      : num(cfg.budgetUsdc);
    const targetOrder = Number.isFinite(medianBuyUsdc) && medianBuyUsdc > 0
      ? clamp(medianBuyUsdc * (losingMode ? 0.18 : 0.32), losingMode ? POLYMARKET_MIN_ORDER_USDC : 2.5, losingMode ? 5 : 9)
      : num(cfg.orderUsdc);
    const targetProbe = Number.isFinite(medianBuyUsdc) && medianBuyUsdc > 0
      ? clamp(medianBuyUsdc * (losingMode ? 0.12 : 0.18), losingMode ? POLYMARKET_MIN_ORDER_USDC : 1.5, losingMode ? 2.5 : 4.5)
      : num(cfg.probeOrderUsdc);
    const targetClip = Math.max(
      targetOrder * 2.2,
      Number.isFinite(p75BuyUsdc) && p75BuyUsdc > 0 ? p75BuyUsdc * (losingMode ? 0.22 : 0.38) : 0,
      POLYMARKET_MIN_ORDER_USDC,
    );
    cfg.budgetUsdc = round(targetBudget, 2);
    cfg.maxDirectionExposureUsdc = round(Math.max(cfg.budgetUsdc * 0.72, targetClip * 3), 2);
    cfg.maxClipUsdc = round(clamp(targetClip, POLYMARKET_MIN_ORDER_USDC, losingMode ? 10 : backtestPositive ? 28 : 18), 2);
    cfg.orderUsdc = round(targetOrder, 2);
    cfg.probeOrderUsdc = round(targetProbe, 2);
    cfg.minExpectedEdge = round(Math.max(num(cfg.minExpectedEdge), losingMode ? 0.022 : 0.014), 4);
    cfg.probeMinExpectedEdge = round(Math.max(num(cfg.probeMinExpectedEdge, 0.008), losingMode ? 0.012 : 0.006), 4);
    cfg.minSignalBps = round(Math.max(num(cfg.minSignalBps), losingMode ? 2.6 : 1.8), 3);
    cfg.liquidityParticipation = round(clamp(num(cfg.liquidityParticipation), 0.58, losingMode ? 0.62 : 0.88), 3);
    cfg.observedMedianBuyUsdc = Number.isFinite(medianBuyUsdc) ? round(medianBuyUsdc, 6) : null;
    cfg.observedP75BuyUsdc = Number.isFinite(p75BuyUsdc) ? round(p75BuyUsdc, 6) : null;
    cfg.observedWindowBuyUsdc = round(currentObservedUsdc, 6);
    cfg.observedWindowBuyRows = observedRows;
    cfg.observedRecentBuyRows30s = recentFlowRows;
    cfg.observedBurstPeak1s = burstPeak;
    cfg.targetOrderRows = round(targetOrderRows, 0);
    Object.assign(adjustments, {
      budgetUsdc: cfg.budgetUsdc,
      maxDirectionExposureUsdc: cfg.maxDirectionExposureUsdc,
      maxClipUsdc: cfg.maxClipUsdc,
      orderUsdc: cfg.orderUsdc,
      probeOrderUsdc: cfg.probeOrderUsdc,
      minExpectedEdge: cfg.minExpectedEdge,
      probeMinExpectedEdge: cfg.probeMinExpectedEdge,
      minSignalBps: cfg.minSignalBps,
      liquidityParticipation: cfg.liquidityParticipation,
      observedWindowBuyUsdc: cfg.observedWindowBuyUsdc,
      observedWindowBuyRows: cfg.observedWindowBuyRows,
      targetOrderRows: cfg.targetOrderRows,
    });
    suggestions.push(`scaled paper budget from Bonereaper live flow at ${round(flowScale * 100, 1)}% of observed activity`);
    if (lossStreak >= 3 || (recent.length >= 5 && recentLosses >= 4 && recentAvgPnl < -120)) {
      const activeFlowFloor = observedRows >= 20 || currentObservedUsdc >= 200;
      cfg.orderUsdc = round(Math.max(activeFlowFloor ? 2.5 : POLYMARKET_MIN_ORDER_USDC, Math.min(num(cfg.orderUsdc), num(base.orderUsdc) * 0.8)), 2);
      cfg.probeOrderUsdc = round(Math.max(activeFlowFloor ? 1.5 : POLYMARKET_MIN_ORDER_USDC, Math.min(num(cfg.probeOrderUsdc), num(base.probeOrderUsdc, 1.5))), 2);
      cfg.maxClipUsdc = round(Math.max(activeFlowFloor ? 6 : POLYMARKET_MIN_ORDER_USDC, Math.min(num(cfg.maxClipUsdc), num(base.maxClipUsdc) * 0.75)), 2);
      cfg.minExpectedEdge = round(Math.max(num(cfg.minExpectedEdge), num(base.minExpectedEdge) + 0.024), 4);
      cfg.minSignalBps = round(Math.max(num(cfg.minSignalBps), num(base.minSignalBps) + 1.0), 3);
      cfg.comboEntryMaxCost = round(Math.min(num(cfg.comboEntryMaxCost), 0.985), 4);
      cfg.hedgeEnabled = false;
      cfg.hedgeMaxAsk = 0;
      cfg.exitEnabled = false;
      cfg.liquidityParticipation = round(Math.min(num(cfg.liquidityParticipation), activeFlowFloor ? 0.58 : 0.42), 3);
      Object.assign(adjustments, {
        orderUsdc: cfg.orderUsdc,
        probeOrderUsdc: cfg.probeOrderUsdc,
        maxClipUsdc: cfg.maxClipUsdc,
        minExpectedEdge: cfg.minExpectedEdge,
        minSignalBps: cfg.minSignalBps,
        comboEntryMaxCost: cfg.comboEntryMaxCost,
        hedgeEnabled: cfg.hedgeEnabled,
        hedgeMaxAsk: cfg.hedgeMaxAsk,
        exitEnabled: cfg.exitEnabled,
        liquidityParticipation: cfg.liquidityParticipation,
      });
      suggestions.push("tightened drawdown mode without pausing paper trading");
    }
    const learned = learner?.suggested || {};
    if (Number.isFinite(num(learned.entryStartSec, NaN))) {
      cfg.entryStartSec = Math.max(0, Math.min(num(cfg.entryStartSec), num(learned.entryStartSec)));
      adjustments.entryStartSec = cfg.entryStartSec;
    }
    if (Number.isFinite(num(learned.entryEndSec, NaN))) {
      const cfgWindowDuration = slugWindowSeconds(clone.market?.slug || learner?.slug);
      cfg.entryEndSec = Math.min(cfgWindowDuration - 1, Math.max(num(cfg.entryEndSec), num(learned.entryEndSec)));
      adjustments.entryEndSec = cfg.entryEndSec;
    }
  if (Number.isFinite(num(learned.probeMaxPerCycle, NaN))) {
    cfg.probeMaxPerCycle = Math.max(num(cfg.probeMaxPerCycle), num(learned.probeMaxPerCycle));
    adjustments.probeMaxPerCycle = cfg.probeMaxPerCycle;
  }
  if (Number.isFinite(num(learned.targetOrderRows, NaN))) {
    cfg.targetOrderRows = Math.max(num(cfg.targetOrderRows), num(learned.targetOrderRows));
    adjustments.targetOrderRows = cfg.targetOrderRows;
  }
    if (num(learner?.currentObservedBuys) > 0) {
      cfg.probeEnabled = true;
      cfg.orderTtlSec = Math.max(num(cfg.orderTtlSec), 115);
      cfg.observedPreferredOutcome = learner.preferredOutcome || "";
      cfg.observedRecentBuyRows30s = learner.recentBuyRows30s;
      adjustments.probeEnabled = true;
      adjustments.orderTtlSec = cfg.orderTtlSec;
      adjustments.observedPreferredOutcome = cfg.observedPreferredOutcome;
      suggestions.push("using Bonereaper public trades as a live learning signal, with paper edge checks still required");
    }
  }
  cfg.minFillUsdc = Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.minFillUsdc, POLYMARKET_MIN_ORDER_USDC));
  cfg.orderUsdc = Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.orderUsdc, POLYMARKET_MIN_ORDER_USDC));
  cfg.probeOrderUsdc = Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.probeOrderUsdc, POLYMARKET_MIN_ORDER_USDC));
  cfg.maxClipUsdc = Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.maxClipUsdc, POLYMARKET_MIN_ORDER_USDC));
  if ((clone.horizon || slugHorizon(clone.market?.slug)) === "5m") {
    const isEth = (clone.asset || slugAsset(clone.market?.slug)) === "ETH";
    const fiveMinuteBudgetCap = isEth ? 12 : 30;
    cfg.parentConfirmOnly = true;
    cfg.allowLearnedProbe = false;
    cfg.allowComboEntry = false;
    cfg.flowConfirmEnabled = true;
    cfg.flowConfirmMinDominance = Math.max(num(cfg.flowConfirmMinDominance, 0.75), isEth ? 0.82 : 0.75);
    cfg.flowConfirmMinRows = Math.max(num(cfg.flowConfirmMinRows, 0), isEth ? 12 : 18);
    cfg.flowConfirmMinUsdc = Math.max(num(cfg.flowConfirmMinUsdc, 0), isEth ? 45 : 120);
    cfg.flowConfirmMaxAgeSec = isEth ? Math.min(num(cfg.flowConfirmMaxAgeSec, 30), 30) : Math.max(num(cfg.flowConfirmMaxAgeSec, 0), 42);
    cfg.flowConfirmOpeningWindowSec = isEth ? Math.min(num(cfg.flowConfirmOpeningWindowSec, 95), 95) : Math.max(num(cfg.flowConfirmOpeningWindowSec, 0), 140);
    cfg.flowConfirmOpeningMaxAgeSec = isEth ? Math.min(num(cfg.flowConfirmOpeningMaxAgeSec, 130), 130) : Math.max(num(cfg.flowConfirmOpeningMaxAgeSec, 0), 210);
    cfg.flowConfirmOpeningRowRatio = clamp(num(cfg.flowConfirmOpeningRowRatio, isEth ? 0.8 : 0.65), isEth ? 0.75 : 0.3, 1, isEth ? 0.8 : 0.65);
    cfg.flowConfirmMaxOpposingParentBps = isEth ? Math.min(num(cfg.flowConfirmMaxOpposingParentBps, 3.5), 3.5) : Math.max(num(cfg.flowConfirmMaxOpposingParentBps, 0), 5);
    cfg.flowConfirmMinEdge = isEth ? Math.max(num(cfg.flowConfirmMinEdge, 0.004), 0.004) : Math.min(num(cfg.flowConfirmMinEdge, -0.006), -0.006);
    cfg.probeEnabled = false;
    cfg.probeMaxPerCycle = 0;
    cfg.inventoryRebalanceRatio = 0;
    cfg.comboEntryMaxCost = 0;
    cfg.budgetUsdc = round(Math.min(num(cfg.budgetUsdc), fiveMinuteBudgetCap), 2);
    cfg.maxDirectionExposureUsdc = round(Math.min(num(cfg.maxDirectionExposureUsdc), Math.max(8, cfg.budgetUsdc * 0.65)), 2);
    cfg.orderUsdc = round(clamp(num(cfg.orderUsdc), POLYMARKET_MIN_ORDER_USDC, isEth ? 1.55 : 2.2), 2);
    cfg.maxClipUsdc = round(Math.min(num(cfg.maxClipUsdc), isEth ? 2.4 : 3.8), 2);
    cfg.minSignalBps = round(Math.max(num(cfg.minSignalBps), isEth ? 4.4 : 3.2), 3);
    cfg.minExpectedEdge = round(Math.max(num(cfg.minExpectedEdge), isEth ? 0.038 : 0.024), 4);
    cfg.maxAsk = round(Math.min(num(cfg.maxAsk), isEth ? 0.88 : 0.94), 3);
    cfg.targetOrderRows = Math.min(num(cfg.targetOrderRows, 0) || 12, isEth ? 8 : 14);
    cfg.minVisibleDepthUsdc = round(Math.max(num(cfg.minVisibleDepthUsdc, 2), isEth ? 2.5 : 2), 3);
    cfg.liquidityParticipation = round(Math.min(num(cfg.liquidityParticipation, 0.35), isEth ? 0.26 : 0.35), 3);
    cfg.executionLatencyMs = Math.max(600, num(cfg.executionLatencyMs, 600));
    cfg.makerPenetrationTicks = Math.max(1, num(cfg.makerPenetrationTicks, 1));
    Object.assign(adjustments, {
      parentConfirmOnly: true,
      allowLearnedProbe: false,
      allowComboEntry: false,
      flowConfirmEnabled: true,
      flowConfirmMinDominance: cfg.flowConfirmMinDominance,
      flowConfirmMinRows: cfg.flowConfirmMinRows,
      flowConfirmMinUsdc: cfg.flowConfirmMinUsdc,
      flowConfirmOpeningWindowSec: cfg.flowConfirmOpeningWindowSec,
      flowConfirmOpeningMaxAgeSec: cfg.flowConfirmOpeningMaxAgeSec,
      flowConfirmOpeningRowRatio: cfg.flowConfirmOpeningRowRatio,
      probeEnabled: false,
      probeMaxPerCycle: 0,
      inventoryRebalanceRatio: 0,
      comboEntryMaxCost: 0,
      budgetUsdc: cfg.budgetUsdc,
      maxDirectionExposureUsdc: cfg.maxDirectionExposureUsdc,
      targetOrderRows: cfg.targetOrderRows,
      minSignalBps: cfg.minSignalBps,
      minExpectedEdge: cfg.minExpectedEdge,
      maxAsk: cfg.maxAsk,
      minVisibleDepthUsdc: cfg.minVisibleDepthUsdc,
      liquidityParticipation: cfg.liquidityParticipation,
      executionLatencyMs: cfg.executionLatencyMs,
      makerPenetrationTicks: cfg.makerPenetrationTicks,
    });
    suggestions.push(isEth
      ? "ETH 5m tightened: stronger flow, parent, edge, depth and lower participation"
      : "5m flow-carry mode: parent-confirmed entries, fresh Bonereaper flow, or opening flow carry with reduced size");
  } else if ((clone.asset || slugAsset(clone.market?.slug)) === "ETH") {
    cfg.flowConfirmEnabled = true;
    cfg.flowConfirmMinDominance = Math.max(num(cfg.flowConfirmMinDominance, 0.68), 0.68);
    cfg.flowConfirmMinRows = Math.max(num(cfg.flowConfirmMinRows, 10), 10);
    cfg.flowConfirmMinUsdc = Math.max(num(cfg.flowConfirmMinUsdc, 35), 35);
    cfg.flowConfirmMinEdge = Math.max(num(cfg.flowConfirmMinEdge, 0.002), 0.002);
    cfg.minSignalBps = round(Math.max(num(cfg.minSignalBps), 2.8), 3);
    cfg.minExpectedEdge = round(Math.max(num(cfg.minExpectedEdge), 0.026), 4);
    cfg.maxAsk = round(Math.min(num(cfg.maxAsk), 0.93), 3);
    cfg.minVisibleDepthUsdc = round(Math.max(num(cfg.minVisibleDepthUsdc, 2), 2.5), 3);
    cfg.liquidityParticipation = round(Math.min(num(cfg.liquidityParticipation, 0.35), 0.32), 3);
    cfg.executionLatencyMs = Math.max(600, num(cfg.executionLatencyMs, 600));
    cfg.makerPenetrationTicks = Math.max(1, num(cfg.makerPenetrationTicks, 1));
    Object.assign(adjustments, {
      flowConfirmEnabled: true,
      flowConfirmMinDominance: cfg.flowConfirmMinDominance,
      flowConfirmMinRows: cfg.flowConfirmMinRows,
      flowConfirmMinUsdc: cfg.flowConfirmMinUsdc,
      flowConfirmMinEdge: cfg.flowConfirmMinEdge,
      minSignalBps: cfg.minSignalBps,
      minExpectedEdge: cfg.minExpectedEdge,
      maxAsk: cfg.maxAsk,
      minVisibleDepthUsdc: cfg.minVisibleDepthUsdc,
      liquidityParticipation: cfg.liquidityParticipation,
      executionLatencyMs: cfg.executionLatencyMs,
      makerPenetrationTicks: cfg.makerPenetrationTicks,
    });
    suggestions.push("ETH 15m signal-quality filter: flow confirmation, edge, depth and lower participation");
  }
  clone.config = cfg;
  clone.adaptive = {
    enabled,
    effectiveConfig: cfg,
    adjustments,
    suggestions,
    updatedAt: new Date().toISOString(),
  };
  return cfg;
}

function applyParentTrendFilter(state, clone) {
  const leg = cryptoLegForKey(clone.legKey || slugLegKey(clone.market?.slug));
  clone.parentTrend = null;
  if (!leg?.parentKey) return clone.config;
  const parent = state.clonePortfolio?.assets?.[leg.parentKey];
  if (!parent?.market?.slug) return clone.config;
  const parentDelta = num(parent.btc?.deltaBps, NaN);
  const parentPnl = parent.pnl?.settled ? num(parent.pnl.realized) : num(parent.pnl?.unrealized);
  const preferred = Number.isFinite(parentDelta) && Math.abs(parentDelta) >= 2
    ? (parentDelta > 0 ? "Up" : "Down")
    : "";
  if (!preferred) return clone.config;
  const blocked = preferred === "Up" ? "Down" : "Up";
  const cfg = clone.config || {};
  const strongThreshold = cfg.parentConfirmOnly ? 3.5 : 5;
  const strong = Math.abs(parentDelta) >= strongThreshold || parentPnl > Math.max(15, num(cfg.orderUsdc) * 6);
  cfg.parentPreferredOutcome = preferred;
  cfg.parentBlockedOutcome = strong ? blocked : "";
  cfg.parentTrendBps = round(parentDelta, 4);
  cfg.parentTrendStrong = strong;
  if (strong) {
    cfg.minExpectedEdge = round(Math.max(num(cfg.minExpectedEdge), 0.018), 4);
    cfg.probeMinExpectedEdge = round(Math.max(num(cfg.probeMinExpectedEdge), 0.008), 4);
  }
  clone.parentTrend = {
    parentKey: leg.parentKey,
    parentSlug: parent.market.slug,
    preferred,
    blocked: cfg.parentBlockedOutcome,
    deltaBps: round(parentDelta, 4),
    parentPnl: round(parentPnl, 6),
    strong,
    updatedAt: new Date().toISOString(),
  };
  return cfg;
}

function bonereaperFlowSignal(clone, cfg) {
  if (!cfg?.flowConfirmEnabled || !clone?.learner?.preferredOutcome) {
    return { active: false, reason: "flow disabled or no preferred outcome" };
  }
  const learner = clone.learner;
  const outcome = learner.preferredOutcome;
  const byOutcome = learner.byOutcome?.[outcome] || {};
  const totalUsdc = num(learner.totalBuyUsdc, num(learner.currentBuyUsdc));
  const preferredUsdc = num(learner.preferredUsdc, byOutcome.usdc);
  const preferredRows = num(learner.preferredRows, byOutcome.rows);
  const dominance = totalUsdc > 0 ? preferredUsdc / totalUsdc : 0;
  const age = num(learner.lastBuyAgeSec, 999);
  const lastBuyElapsed = num(learner.lastBuyElapsedSec, NaN);
  const currentElapsed = Number.isFinite(lastBuyElapsed) ? lastBuyElapsed + age : Infinity;
  const parentPreferred = cfg.parentPreferredOutcome || clone.parentTrend?.preferred || "";
  const parentDelta = Math.abs(num(cfg.parentTrendBps, clone.parentTrend?.deltaBps));
  const strongOppositeParent = parentPreferred && parentPreferred !== outcome && parentDelta >= num(cfg.flowConfirmMaxOpposingParentBps, 5);
  const baseRows = num(cfg.flowConfirmMinRows, 12);
  const baseUsdc = num(cfg.flowConfirmMinUsdc, 60);
  const rowRatio = clamp(num(cfg.flowConfirmOpeningRowRatio, 0.65), 0.3, 1);
  const fresh = (
    dominance >= num(cfg.flowConfirmMinDominance, 0.75)
    && preferredRows >= baseRows
    && preferredUsdc >= baseUsdc
    && age <= num(cfg.flowConfirmMaxAgeSec, 40)
    && !strongOppositeParent
  );
  const openingCarry = (
    dominance >= Math.max(num(cfg.flowConfirmMinDominance, 0.75), 0.78)
    && preferredRows >= Math.max(4, Math.ceil(baseRows * rowRatio))
    && preferredUsdc >= Math.max(POLYMARKET_MIN_ORDER_USDC, baseUsdc * rowRatio)
    && Number.isFinite(lastBuyElapsed)
    && lastBuyElapsed <= num(cfg.flowConfirmOpeningWindowSec, 95)
    && currentElapsed <= num(cfg.flowConfirmOpeningMaxAgeSec, 210)
    && !strongOppositeParent
  );
  const active = fresh || openingCarry;
  const mode = fresh ? "fresh" : openingCarry ? "opening-carry" : "";
  return {
    active,
    mode,
    preferred: outcome,
    dominance: round(dominance, 4),
    preferredRows,
    preferredUsdc: round(preferredUsdc, 6),
    totalUsdc: round(totalUsdc, 6),
    ageSec: round(age, 3),
    lastBuyElapsedSec: Number.isFinite(lastBuyElapsed) ? round(lastBuyElapsed, 3) : null,
    currentElapsedSec: Number.isFinite(currentElapsed) ? round(currentElapsed, 3) : null,
    parentPreferred,
    strongOppositeParent,
    reason: active
      ? `Bonereaper 5m ${mode} flow ${outcome} dominance ${round(dominance * 100, 1)}% rows ${preferredRows} usdc ${round(preferredUsdc, 2)} age ${round(age, 1)}s`
      : `flow not confirmed ${outcome} dominance ${round(dominance * 100, 1)}% rows ${preferredRows} usdc ${round(preferredUsdc, 2)} age ${round(age, 1)}s elapsed ${round(currentElapsed, 1)}s parent ${parentPreferred || "-"}`,
  };
}

function sanitizeCloneMinimumTradeArtifacts(clone, nowSec) {
  const minFill = Math.max(POLYMARKET_MIN_ORDER_USDC, num(clone.config?.minFillUsdc, POLYMARKET_MIN_ORDER_USDC));
  const fills = Array.isArray(clone.fills) ? clone.fills : [];
  const validFills = fills.filter((fill) => num(fill.amountUsdc) >= minFill);
  const removed = fills.length - validFills.length;
  if (removed <= 0) return 0;
  clone.fills = validFills;
  for (const order of clone.orders || []) {
    const orderFills = Array.isArray(order.fills) ? order.fills.filter((fill) => num(fill.amountUsdc) >= minFill) : [];
    const removedOrderFills = (order.fills || []).length - orderFills.length;
    order.fills = orderFills;
    order.filledShares = round(orderFills.reduce((total, fill) => total + num(fill.shares), 0), 6);
    order.filledCost = round(orderFills.reduce((total, fill) => total + num(fill.amountUsdc), 0), 6);
    order.remainingShares = round(Math.max(0, num(order.shares) - num(order.filledShares)), 6);
    if (removedOrderFills > 0 && num(order.notional) < minFill) {
      order.status = "EXPIRED";
      order.cancelReason = `removed pre-min-fill paper artifact below ${minFill} USDC`;
      order.updatedAt = isoFromSec(nowSec);
    } else if (order.action === "BUY_LIMIT" && num(order.filledShares) <= 0 && ["FILLED", "PARTIAL"].includes(order.status)) {
      order.status = "OPEN";
    } else if (order.action === "BUY_LIMIT" && num(order.remainingShares) <= 0.000001 && num(order.filledShares) > 0) {
      order.status = "FILLED";
    } else if (order.action === "BUY_LIMIT" && num(order.filledShares) > 0 && ["FILLED", "PARTIAL"].includes(order.status)) {
      order.status = "PARTIAL";
    }
  }
  clone.positions = rebuildClonePositionsFromFills(clone.fills);
  clone.minimumTradeSanitizer = {
    removedFills: removed,
    minFillUsdc: minFill,
    updatedAt: isoFromSec(nowSec),
  };
  return removed;
}

function rebuildClonePositionsFromFills(fills) {
  const positions = emptyClonePositions();
  const rows = [...(fills || [])].sort((a, b) => num(a.ts) - num(b.ts));
  for (const fill of rows) {
    const outcome = OUTCOMES.includes(fill.direction) ? fill.direction : null;
    if (!outcome) continue;
    const position = positions[outcome];
    if (fill.action === "BUY") {
      position.shares = round(num(position.shares) + num(fill.shares), 6);
      position.cost = round(num(position.cost) + num(fill.amountUsdc), 6);
      position.avgPrice = position.shares > 0 ? round(position.cost / position.shares, 6) : null;
    } else if (fill.action === "SELL" && position.shares > 0) {
      const soldShares = Math.min(num(position.shares), num(fill.shares));
      const costRemoved = round(num(position.cost) * (soldShares / Math.max(1e-9, num(position.shares))), 6);
      position.shares = round(Math.max(0, num(position.shares) - soldShares), 6);
      position.cost = round(Math.max(0, num(position.cost) - costRemoved), 6);
      position.avgPrice = position.shares > 0 ? round(position.cost / position.shares, 6) : null;
      position.realizedProceeds = round(num(position.realizedProceeds) + num(fill.amountUsdc), 6);
      position.realizedPnl = round(num(position.realizedPnl) + num(fill.amountUsdc) - costRemoved, 6);
    }
  }
  return positions;
}

function fillOpenCloneOrders(clone, nowSec) {
  for (const order of clone.orders || []) {
    if (!["OPEN", "PARTIAL"].includes(order.status)) continue;
    const quote = clone.orderbook?.[order.direction];
    if (nowSec - num(order.ts) > clone.config.orderTtlSec) {
      order.status = num(order.filledShares) > 0 ? "EXPIRED_PARTIAL" : "EXPIRED";
      order.updatedAt = isoFromSec(nowSec);
      continue;
    }
    const fillLimit = cloneFillLimitPrice(order, quote, clone.config || {});
    if (Number.isFinite(quote?.ask) && Number.isFinite(fillLimit) && quote.ask <= fillLimit) {
      tryFillCloneOrder(clone, order, nowSec, "limit crossed current ask");
    }
  }
}

function cloneCandidateLevels(quote, cfg, isPreferred, strongMomentum, cheapHedge) {
  const levels = [];
  const ask = num(quote?.ask, NaN);
  const bid = num(quote?.bid, NaN);
  if (!Number.isFinite(ask)) return levels;
  levels.push({ style: "cross", limitPrice: takerLimitPrice(ask, cfg) });
  if (Number.isFinite(bid) && bid > 0 && bid < ask) levels.push({ style: "maker-ladder", limitPrice: round(bid, 2) });
  const makerTop = Number.isFinite(bid)
    ? round(clamp(bid + 0.01, 0.01, num(cfg.maxAsk, 0.99)), 2)
    : round(clamp(ask - 0.01, 0.01, num(cfg.maxAsk, 0.99)), 2);
  if (makerTop > 0 && makerTop < ask) levels.push({ style: "maker-ladder", limitPrice: makerTop });
  const denseLadder = num(cfg.targetOrderRows) >= 40 || num(cfg.observedBurstPeak1s) >= 4 || num(cfg.observedRecentBuyRows30s) >= 6;
  const offsets = denseLadder
    ? [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15]
    : ((isPreferred && strongMomentum) || cheapHedge ? [0.02, 0.03, 0.05] : [0.02]);
  for (const offset of offsets) {
    const tick = num(quote?.tickSize, 0.01) <= 0.001 ? 3 : 2;
    const limitPrice = round(clamp(ask - offset, 0.01, num(cfg.maxAsk, 0.99)), tick);
    if (limitPrice > 0 && limitPrice < ask && !levels.some((row) => Math.abs(row.limitPrice - limitPrice) < 0.000001)) {
      levels.push({ style: "maker-ladder", limitPrice });
    }
  }
  return levels.filter((row) => Number.isFinite(row.limitPrice) && row.limitPrice > 0);
}

function cloneFlowRetraceLevels(quote, cfg, clone, outcome, fairPrice) {
  const ask = num(quote?.ask, NaN);
  if (!Number.isFinite(ask)) return [];
  const tick = num(quote?.tickSize, 0.01) <= 0.001 ? 3 : 2;
  const cap = Math.min(num(cfg.maxAsk, 0.94), 0.97);
  const observedAvg = finiteNum(clone.learner?.byOutcome?.[outcome]?.avgPrice);
  const bid = finiteNum(quote?.bid);
  const fair = finiteNum(fairPrice);
  const anchors = [
    observedAvg,
    Number.isFinite(bid) ? bid - 0.01 : null,
    Number.isFinite(fair) ? fair + 0.04 : null,
    fair,
  ].filter((value) => Number.isFinite(value) && value > 0);
  const levels = [];
  for (const anchor of anchors) {
    for (const offset of [0, 0.02, 0.04, 0.06, 0.09]) {
      const limitPrice = round(clamp(anchor - offset, 0.01, cap), tick);
      if (limitPrice <= 0 || limitPrice >= ask || limitPrice > cap) continue;
      if (levels.some((row) => Math.abs(row.limitPrice - limitPrice) < 0.000001)) continue;
      levels.push({ style: "maker-ladder", limitPrice });
    }
  }
  return levels.slice(0, 10);
}

function cloneCandidateChildOrders(candidate, clone, elapsed) {
  const cfg = clone.config || {};
  const targetRows = num(cfg.targetOrderRows);
  const currentRows = cloneEffectiveEntryRows(clone);
  const remainingRows = targetRows > 0 ? Math.max(0, targetRows - currentRows) : 24;
  if (remainingRows <= 0) return [];
  const observedRows = Math.max(num(cfg.observedWindowBuyRows), num(clone.learner?.currentObservedBuys));
  const recentRows = Math.max(num(cfg.observedRecentBuyRows30s), num(clone.learner?.recentBuyRows30s));
  const burstRows = Math.max(num(cfg.observedBurstPeak1s), num(clone.learner?.burstPeak1s));
  const baseChildren = candidate.kind === "learned-probe"
    ? Math.ceil(Math.max(2, observedRows / 9, recentRows * 1.6, burstRows * 3))
    : candidate.kind === "flow-confirm"
      ? Math.ceil(Math.max(2, observedRows / 10, recentRows * 2, burstRows * 4))
    : candidate.kind === "flow-carry"
      ? Math.ceil(Math.max(1, observedRows / 14, burstRows * 2))
    : candidate.kind === "directional"
      ? Math.ceil(Math.max(1, observedRows / 16, recentRows))
      : candidate.kind === "probe"
        ? Math.ceil(Math.max(1, observedRows / 22, recentRows * 0.8, burstRows))
        : candidate.kind === "inventory-balance"
          ? Math.ceil(Math.max(2, observedRows / 24, recentRows * 0.8))
          : 1;
  const highFlow = observedRows >= 35 || recentRows >= 4 || burstRows >= 3 || targetRows >= 70;
  const styleCap = candidate.style === "cross" ? (highFlow ? 14 : 6) : (highFlow ? 22 : 10);
  const earlyBoost = Number.isFinite(elapsed) && elapsed <= 120 ? 1.45 : 1;
  const catchUpBoost = Number.isFinite(elapsed) && elapsed >= 210 ? 1.25 : 1;
  const childCount = Math.min(remainingRows, styleCap, Math.max(1, Math.ceil(baseChildren * earlyBoost * catchUpBoost)));
  return Array.from({ length: childCount }, (_, index) => ({
    ...candidate,
    childCount,
    childIndex: index,
    priority: num(candidate.priority) - index * 0.001,
    reason: index > 0 ? `${candidate.reason}; child ${index + 1}/${childCount}` : candidate.reason,
  }));
}

function cloneEffectiveEntryRows(clone) {
  return (clone.orders || []).filter((order) => {
    if (order.action !== "BUY_LIMIT") return false;
    if (["OPEN", "PARTIAL", "FILLED", "EXPIRED_PARTIAL"].includes(order.status)) return true;
    return num(order.filledShares) > 0 || num(order.filledCost) > 0;
  }).length;
}

function levelEdgeSafe(fairPrice, ask, cfg) {
  if (!Number.isFinite(fairPrice) || !Number.isFinite(ask) || ask <= 0) return false;
  const effectiveAsk = effectiveBuyPrice(takerLimitPrice(ask, cfg), num(cfg?.takerFeeRate, 0.07));
  return fairPrice - effectiveAsk >= -0.025;
}

function generateCloneExits(clone, nowSec) {
  const market = clone.market;
  const start = num(market?.windowStart, null);
  const end = num(market?.windowEnd, null);
  const elapsed = Number.isFinite(start) ? nowSec - start : null;
  const remaining = Number.isFinite(end) ? end - nowSec : null;
  const live = market?.active && !market?.closed && Number.isFinite(elapsed) && elapsed >= 0 && remaining > 0;
  if (!live) return 0;
  const cfg = clone.config || {};
  let sold = 0;
  for (const outcome of OUTCOMES) {
    const position = clone.positions?.[outcome];
    const shares = num(position?.shares);
    const cost = num(position?.cost);
    const quote = clone.orderbook?.[outcome];
    if (shares <= 0.000001 || cost <= 0 || !Number.isFinite(quote?.bid) || quote.bid <= 0) continue;
    const avgPrice = num(position.avgPrice, cost / shares);
    const pnlPct = avgPrice > 0 ? (quote.bid - avgPrice) / avgPrice : 0;
    const nearCertainProfit = quote.bid >= Math.max(0.97, avgPrice * (1 + Math.max(0.2, num(cfg.exitTakeProfitPct))));
    const lateProfitProtect = remaining <= num(cfg.exitBeforeEndSec) && quote.bid >= Math.max(0.95, avgPrice * 1.35);
    if (!nearCertainProfit && !lateProfitProtect) continue;
    if (recordCloneSell(clone, {
      nowSec,
      outcome,
      shares: shares * 0.25,
      limitPrice: quote.bid,
      quoteBid: quote.bid,
      quoteAsk: quote.ask,
      reason: nearCertainProfit
        ? `rare settlement-hold profit lock at bid ${quote.bid}`
        : `late settlement-hold profit protect with ${remaining}s left`,
    })) sold += 1;
  }
  return sold;
}

function generateCloneOrders(clone, nowSec) {
  const market = clone.market;
  const start = num(market?.windowStart, null);
  const end = num(market?.windowEnd, null);
  const cfg = clone.config;
  const elapsed = Number.isFinite(start) ? nowSec - start : null;
  const remaining = Number.isFinite(end) ? end - nowSec : null;
  const live = market?.active && market?.acceptingOrders && !market?.closed && Number.isFinite(elapsed) && elapsed >= 0 && remaining > 0;
  if (!live) {
    clone.lastDecision = { ts: nowSec, isoTime: isoFromSec(nowSec), status: market?.closed ? "closed" : "waiting", reason: "market is not live" };
    return;
  }
  if (elapsed < cfg.entryStartSec || elapsed > cfg.entryEndSec) {
    clone.lastDecision = {
      ts: nowSec,
      isoTime: isoFromSec(nowSec),
      status: "waiting",
      elapsedSec: elapsed,
      reason: `outside clone entry band ${cfg.entryStartSec}-${cfg.entryEndSec}s`,
    };
    return;
  }
  const spent = cloneSpent(clone);
  const pending = clonePending(clone);
  const remainingBudget = cfg.budgetUsdc - spent - pending;
  const adverse = clone.adverseSelection || {};
  if (num(adverse.checked) >= 6 && num(adverse.rate) >= 0.55 && num(clone.pnl?.unrealized) < -Math.max(num(cfg.orderUsdc) * 3, 8)) {
    clone.lastDecision = {
      ts: nowSec,
      isoTime: isoFromSec(nowSec),
      status: "adverse-guard",
      elapsedSec: elapsed,
      fairUp: round(fairUpFromBtc(clone.btc, market, nowSec), 4),
      reason: `adverse selection guard rate ${round(num(adverse.rate) * 100, 1)}% avg ${round(num(adverse.avgBps), 1)} bps`,
    };
    return;
  }
  if (remainingBudget <= 1) {
    clone.lastDecision = { ts: nowSec, isoTime: isoFromSec(nowSec), status: "budget-full", spent, pending, reason: "paper budget reached" };
    return;
  }

  const signal = cloneSignalModel(clone, nowSec);
  const fairUp = signal.fairUp;
  const fair = signal.fair;
  const signalBps = signal.signalBps;
  let preferred = signal.preferred;
  const signalAbs = Math.abs(signalBps);
  const flow = bonereaperFlowSignal(clone, cfg);
  if (cfg.parentConfirmOnly) {
    const parentPreferred = cfg.parentPreferredOutcome || clone.parentTrend?.preferred || "";
    const parentStrong = Boolean(cfg.parentTrendStrong || clone.parentTrend?.strong);
    const parentConfirmed = Boolean(preferred && parentPreferred && preferred === parentPreferred && parentStrong);
    const flowConfirmed = Boolean(flow.active);
    if (flowConfirmed && !parentConfirmed) preferred = flow.preferred;
    if (!parentConfirmed && !flowConfirmed) {
      clone.lastDecision = {
        ts: nowSec,
        isoTime: isoFromSec(nowSec),
        status: "idle",
        elapsedSec: elapsed,
        fairUp: round(fairUp, 4),
        preferred,
        signal,
        flow,
        reason: `5m parent/flow confirm filter preferred ${preferred || "-"} parent ${parentPreferred || "-"} strong ${parentStrong}; ${flow.reason}`,
      };
      return;
    }
  }
  const probeAllowed = Boolean(cfg.probeEnabled)
    && signalAbs >= num(cfg.probeMinSignalBps, 0.1)
    && remaining > 25;
  if (!preferred && !probeAllowed) {
    clone.lastDecision = {
      ts: nowSec,
      isoTime: isoFromSec(nowSec),
      status: "idle",
      elapsedSec: elapsed,
      fairUp: round(fairUp, 4),
      preferred: "",
      signal,
      reason: `BTC signal ${round(signalBps, 2)} bps below ${cfg.minSignalBps} bps threshold`,
    };
    return;
  }
  const maxOrdersPerWindow = num(cfg.maxOrdersPerWindow);
  const entryOrderCount = cloneEffectiveEntryRows(clone);
  const targetOrderRows = num(cfg.targetOrderRows);
  if (targetOrderRows > 0 && entryOrderCount >= targetOrderRows) {
    clone.lastDecision = {
      ts: nowSec,
      isoTime: isoFromSec(nowSec),
      status: "max-orders",
      elapsedSec: elapsed,
      fairUp: round(fairUp, 4),
      preferred,
      reason: `target paper order rows ${targetOrderRows} reached for this window`,
    };
    return;
  }
  if (maxOrdersPerWindow > 0 && entryOrderCount >= maxOrdersPerWindow) {
    clone.lastDecision = {
      ts: nowSec,
      isoTime: isoFromSec(nowSec),
      status: "max-orders",
      elapsedSec: elapsed,
      fairUp: round(fairUp, 4),
      preferred,
      reason: `max entry orders ${maxOrdersPerWindow} reached for this window`,
    };
    return;
  }
  const candidates = [];
  const comboAsk = clone.orderbook?.comboAsk;
  const comboCandidate = cfg.allowComboEntry !== false && Number.isFinite(comboAsk) && comboAsk > 0 && comboAsk <= num(cfg.comboEntryMaxCost);
  const learnedPreferred = clone.learner?.preferredOutcome || cfg.observedPreferredOutcome || "";
  const learnedActive = cfg.allowLearnedProbe !== false
    && !cfg.parentConfirmOnly
    && Boolean(learnedPreferred)
    && num(clone.learner?.currentObservedBuys) > 0
    && num(clone.learner?.lastBuyAgeSec, 999) <= 90
    && signalAbs < num(cfg.whaleConfidenceBps);
  const outcomesToCheck = preferred
    ? (cfg.hedgeEnabled && signalAbs >= num(cfg.hedgeSignalBps) ? OUTCOMES : Array.from(new Set([preferred, learnedActive ? learnedPreferred : ""]).values()).filter(Boolean))
    : OUTCOMES;
  const maxProbePerCycle = num(cfg.probeMaxPerCycle, 4);
  for (const outcome of outcomesToCheck) {
    const quote = clone.orderbook?.[outcome];
    if (!Number.isFinite(quote?.ask)) continue;
    const parentOrFlowOutcome = flow.active ? flow.preferred : cfg.parentPreferredOutcome;
    if (cfg.parentConfirmOnly && outcome !== parentOrFlowOutcome) continue;
    if (cfg.parentBlockedOutcome === outcome && signalAbs < num(cfg.whaleConfidenceBps) * 1.15) continue;
    const strongMomentum = Math.abs(signalBps) >= num(cfg.minSignalBps) * 2;
    const isPreferred = outcome === preferred;
    const isLearnedProbe = learnedActive && outcome === learnedPreferred && (!preferred || !strongMomentum);
    const isProbe = !preferred || isLearnedProbe || (Boolean(cfg.probeEnabled) && signalAbs < num(cfg.minSignalBps));
    if (!isPreferred && !cfg.hedgeEnabled && !isProbe && !isLearnedProbe) continue;
    const cheapHedge = Boolean(cfg.hedgeEnabled) && !isPreferred && quote.ask <= cfg.hedgeMaxAsk;
    const highConfidence = signalAbs >= num(cfg.highConfidenceBps);
    const crossFeeRate = feeRateForOrder(clone, outcome, "cross");
    const crossEffectiveAsk = effectiveBuyPrice(takerLimitPrice(quote.ask, cfg), crossFeeRate);
    const crossEdge = round(fair[outcome] - crossEffectiveAsk, 6);
    const makerEdgeAtBetterPrice = round(fair[outcome] - effectiveBuyPrice(Math.max(0.01, quote.ask - 0.03), feeRateForOrder(clone, outcome, "maker-ladder")), 6);
    const hasExpectedEdge = crossEdge >= num(cfg.minExpectedEdge);
    const flowDriven = cfg.parentConfirmOnly && flow.active && outcome === flow.preferred;
    const flowLadderAllowed = flowDriven
      && quote.ask <= 0.99
      && (num(flow.dominance) >= 0.85 || clone.parentTrend?.strong)
      && num(flow.preferredRows) >= Math.max(4, Math.ceil(num(cfg.flowConfirmMinRows, 12) * 0.65));
    const directionalAllowed = hasExpectedEdge
      || (isPreferred && highConfidence && makerEdgeAtBetterPrice >= num(cfg.minExpectedEdge))
      || (flowDriven && (crossEdge >= 0.006 || makerEdgeAtBetterPrice >= num(cfg.flowConfirmMinEdge, -0.006)))
      || flowLadderAllowed;
    const probeAllowedForOutcome = (isProbe || isLearnedProbe) && quote.ask <= cfg.maxAsk;
    if ((quote.ask <= cfg.maxAsk || flowLadderAllowed) && (directionalAllowed || cheapHedge || probeAllowedForOutcome)) {
      const levels = cloneCandidateLevels(quote, cfg, isPreferred, strongMomentum, cheapHedge)
        .concat(flowLadderAllowed ? cloneFlowRetraceLevels(quote, cfg, clone, outcome, fair[outcome]) : []);
      const learnedBurst = isLearnedProbe && (num(clone.learner?.recentBuyRows30s) >= 3 || num(clone.learner?.burstPeak1s) >= 3);
      const observedPressure = num(clone.learner?.currentObservedBuys) >= 20 || num(clone.learner?.recentBuyRows30s) >= 2 || num(clone.learner?.byOutcome?.[outcome]?.rows) >= 12;
      const allowMicroCross = observedPressure && quote.ask <= Math.min(num(cfg.maxAsk), 0.96) && (levelEdgeSafe(fair[outcome], quote.ask, cfg) || isLearnedProbe);
      const filteredLevels = isProbe && !learnedBurst && !allowMicroCross ? levels.filter((level) => level.style === "maker-ladder") : levels;
      const flowKind = flowDriven && flow.mode === "opening-carry" ? "flow-carry" : "flow-confirm";
      const kind = cheapHedge && !isPreferred ? "hedge" : isLearnedProbe ? "learned-probe" : isProbe ? "probe" : "directional";
      const reason = cheapHedge
        ? `Bonereaper-style hedge ${outcome} ask ${quote.ask} combo ${comboAsk}`
        : isLearnedProbe
          ? `learned Bonereaper pressure on ${outcome}, still requiring paper edge`
        : isProbe
          ? `micro maker probe ${outcome} signal ${round(signalBps, 2)} bps`
        : strongMomentum && isPreferred
          ? `BTC momentum ${round(signalBps, 2)} bps with ask ${quote.ask}`
          : `fair ${round(fair[outcome], 4)} minus fee-adjusted ask ${round(crossEffectiveAsk, 4)}`;
      for (const level of filteredLevels) {
        const levelFeeRate = feeRateForOrder(clone, outcome, level.style);
        const levelEffectivePrice = effectiveBuyPrice(level.limitPrice, levelFeeRate);
        const levelEdge = round(fair[outcome] - levelEffectivePrice, 6);
        if (
          kind !== "hedge"
          && levelEdge < num(cfg.minExpectedEdge)
          && !(kind === "probe" && levelEdge >= num(cfg.probeMinExpectedEdge))
          && !(kind === "learned-probe" && levelEdge >= num(cfg.probeMinExpectedEdge))
          && !(kind === "learned-probe" && num(clone.learner?.byOutcome?.[outcome]?.usdc) > 0 && levelEdge >= -0.015)
          && !(flowDriven && levelEdge >= num(cfg.flowConfirmMinEdge, -0.006))
          && !(flowLadderAllowed && level.style === "maker-ladder" && levelEdge >= (flow.mode === "opening-carry" ? -0.18 : -0.12))
          && !(isPreferred && highConfidence && levelEdge >= -0.005)
        ) continue;
        if (level.limitPrice > cfg.maxAsk) continue;
        const priority = flowDriven
          ? 3.4 + Math.max(0, flow.dominance - 0.75) * 8 + Math.max(0, levelEdge)
          : kind === "probe" || kind === "learned-probe"
          ? 1.4 + Math.max(0, levelEdge)
          : (isPreferred ? (strongMomentum ? 4 : 3) : 2) + (level.style === "cross" ? 0.2 : 0);
        candidates.push({
          outcome,
          style: level.style,
          limitPrice: level.limitPrice,
          priority,
          edge: levelEdge,
          feeRate: levelFeeRate,
          effectivePrice: levelEffectivePrice,
          signalBps,
          confidence: signal.confidence,
          kind: flowDriven ? flowKind : kind,
          reason: flowDriven ? flow.reason : reason,
        });
      }
    }
  }

  if (comboCandidate) {
    for (const outcome of OUTCOMES) {
      const quote = clone.orderbook?.[outcome];
      if (!Number.isFinite(quote?.ask) || quote.ask > cfg.maxAsk) continue;
      candidates.push({
        outcome,
        style: "cross",
        limitPrice: takerLimitPrice(quote.ask, cfg),
        priority: 2.6,
        edge: round(fair[outcome] - quote.ask, 6),
        signalBps,
        confidence: signal.confidence,
        kind: "combo",
        reason: `combo inventory pair ask ${comboAsk} below ${cfg.comboEntryMaxCost}`,
      });
    }
  }

  const inv = positionInventory(clone);
  const inventoryCost = OUTCOMES.reduce((total, outcome) => total + inv[outcome].cost + inv[outcome].pending, 0);
  if (num(cfg.inventoryRebalanceRatio) > 0 && inventoryCost >= Math.max(8, num(cfg.orderUsdc) * 2)) {
    for (const outcome of OUTCOMES) {
      if (cfg.parentBlockedOutcome === outcome) continue;
      const other = outcome === "Up" ? "Down" : "Up";
      const own = inv[outcome].cost + inv[outcome].pending;
      const opposing = inv[other].cost + inv[other].pending;
      const quote = clone.orderbook?.[outcome];
      if (!Number.isFinite(quote?.ask) || quote.ask > Math.min(num(cfg.maxAsk), 0.92)) continue;
      const underweight = own + Math.max(2, num(cfg.orderUsdc)) < opposing * 0.72;
      const comboOk = Number.isFinite(comboAsk) && comboAsk <= num(cfg.comboEntryMaxCost, 0.985) + 0.035;
      if (!underweight && !comboOk) continue;
      const levels = cloneCandidateLevels(quote, cfg, false, false, false)
        .filter((level) => level.style === "maker-ladder" || quote.ask <= 0.62)
        .slice(0, underweight ? 8 : 4);
      for (const level of levels) {
        const feeRate = feeRateForOrder(clone, outcome, level.style);
        candidates.push({
          outcome,
          style: level.style,
          limitPrice: level.limitPrice,
          priority: 1.9 + Math.max(0, opposing - own) / Math.max(10, inventoryCost),
          edge: round(fair[outcome] - effectiveBuyPrice(level.limitPrice, feeRate), 6),
          feeRate,
          effectivePrice: effectiveBuyPrice(level.limitPrice, feeRate),
          signalBps,
          confidence: signal.confidence,
          kind: "inventory-balance",
          reason: `bilateral inventory balance ${outcome} vs ${other}`,
        });
      }
    }
  }

  const candidateLimit = Math.max(28, Math.min(180, maxProbePerCycle + 60));
  const selected = candidates
    .flatMap((candidate) => cloneCandidateChildOrders(candidate, clone, elapsed))
    .sort((a, b) => b.priority - a.priority || b.edge - a.edge)
    .slice(0, candidateLimit);
  const probeCount = selected.filter((row) => row.kind === "probe" || row.kind === "learned-probe").length;
  const selectedCapped = probeCount > maxProbePerCycle
    ? selected.filter((row) => row.kind !== "probe" && row.kind !== "learned-probe").concat(selected.filter((row) => row.kind === "probe" || row.kind === "learned-probe").slice(0, maxProbePerCycle))
    : selected;
  if (!selectedCapped.length) {
    clone.lastDecision = {
      ts: nowSec,
      isoTime: isoFromSec(nowSec),
      status: "idle",
      elapsedSec: elapsed,
      fairUp: round(fairUp, 4),
      preferred,
      reason: "no entry candidate at current ask",
    };
    return;
  }

  let placed = 0;
  const remainingOrderRows = targetOrderRows > 0 ? Math.max(0, targetOrderRows - entryOrderCount) : Infinity;
  const placeLimit = Math.min(
    remainingOrderRows,
    Math.max(20, Math.min(120, maxProbePerCycle + 36)),
  );
  for (const candidate of selectedCapped) {
    if (placed >= placeLimit) break;
    const quote = clone.orderbook?.[candidate.outcome];
    if (!Number.isFinite(quote?.ask)) continue;
    const limitPrice = Number.isFinite(candidate.limitPrice) ? candidate.limitPrice : candidate.style === "cross"
      ? takerLimitPrice(quote.ask, cfg)
      : round(clamp(Math.min(quote.ask - 0.01, num(quote.bid, quote.ask - 0.02) + 0.01), 0.01, cfg.maxAsk), 2);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice > cfg.maxAsk) continue;
    if (hasRecentCloneOrder(clone, candidate.outcome, limitPrice, nowSec, cfg.cooldownSec)) continue;
    const depthUsdc = visibleAskDepthUsdc(quote, limitPrice);
    if (candidate.style === "cross" && depthUsdc < Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.minVisibleDepthUsdc, POLYMARKET_MIN_ORDER_USDC))) continue;
    if (candidate.style === "cross" && num(candidate.edge) >= num(cfg.minExpectedEdge)) {
      releaseMakerOrdersForCross(clone, candidate.outcome, nowSec, "released stale maker orders for marketable paper entry");
    }
    const directionTotal = num(clone.positions?.[candidate.outcome]?.cost) + pendingByDirection(clone, candidate.outcome);
    if (directionTotal >= cfg.maxDirectionExposureUsdc) continue;
    if (losingDirectionCap(clone, candidate.outcome, directionTotal) && candidate.kind !== "inventory-balance") continue;

    const minNotional = minCloneOrderNotional(clone, candidate.outcome, candidate.effectivePrice || effectiveBuyPrice(limitPrice, candidate.feeRate));
    const notional = dynamicCloneNotional(clone, candidate, limitPrice, elapsed, minNotional);
    const cappedNotional = Math.min(
      notional,
      cfg.budgetUsdc - cloneSpent(clone) - clonePending(clone),
      cfg.maxDirectionExposureUsdc - directionTotal,
    );
    if (cappedNotional + 0.000001 < minNotional) continue;
    placeCloneOrder(clone, {
      nowSec,
      outcome: candidate.outcome,
      style: candidate.style,
      limitPrice,
      quoteAsk: quote.ask,
      quoteBid: quote.bid,
      notional: cappedNotional,
      fairPrice: fair[candidate.outcome],
      feeRate: candidate.feeRate,
      effectivePrice: candidate.effectivePrice,
      btcDeltaBps: clone.btc?.deltaBps,
      reason: candidate.reason,
    });
    placed += 1;
  }
  clone.lastDecision = {
    ts: nowSec,
    isoTime: isoFromSec(nowSec),
    status: placed ? "placed" : "cooldown",
    elapsedSec: elapsed,
    remainingSec: remaining,
    fairUp: round(fairUp, 4),
    preferred,
    signal,
    candidates: selectedCapped.map((row) => ({ outcome: row.outcome, style: row.style, kind: row.kind, edge: round(row.edge, 4), feeRate: round(row.feeRate, 4), reason: row.reason })),
    placed,
  };
}

function hasRecentCloneOrder(clone, outcome, limitPrice, nowSec, cooldownSec) {
  if (num(cooldownSec) <= 0) return false;
  return (clone.orders || []).some((order) => (
    order.direction === outcome
    && Math.abs(num(order.limitPrice) - limitPrice) < 0.000001
    && nowSec - num(order.ts) <= cooldownSec
    && ["OPEN", "PARTIAL", "FILLED"].includes(order.status)
  ));
}

function releaseMakerOrdersForCross(clone, outcome, nowSec, reason) {
  let released = 0;
  for (const order of clone.orders || []) {
    if (order.direction !== outcome) continue;
    if (order.style !== "maker-ladder") continue;
    if (!["OPEN", "PARTIAL"].includes(order.status)) continue;
    if (num(order.filledShares) > 0) continue;
    order.status = "EXPIRED";
    order.updatedAt = isoFromSec(nowSec);
    order.cancelReason = reason;
    released += 1;
  }
  return released;
}

function placeCloneOrder(clone, spec) {
  clone.nextOrderId = num(clone.nextOrderId, 0) + 1;
  const feeRate = Number.isFinite(spec.feeRate) ? num(spec.feeRate) : feeRateForOrder(clone, spec.outcome, spec.style);
  const effectivePrice = Number.isFinite(spec.effectivePrice) ? num(spec.effectivePrice) : effectiveBuyPrice(spec.limitPrice, feeRate);
  const shares = round(spec.notional / Math.max(0.000001, effectivePrice), 6);
  const executionLatencyMs = Math.max(0, num(clone.config?.executionLatencyMs, 600));
  const snapshotMs = marketClockNowMs(clone);
  const eligibleFillMs = snapshotMs + executionLatencyMs;
  const order = {
    id: `clone-${clone.nextOrderId}`,
    ts: spec.nowSec,
    isoTime: isoFromSec(spec.nowSec),
    snapshotMs: Math.round(snapshotMs),
    snapshotIsoTime: new Date(snapshotMs).toISOString(),
    eligibleFillMs: Math.round(eligibleFillMs),
    eligibleFillIsoTime: new Date(eligibleFillMs).toISOString(),
    executionLatencyMs: round(executionLatencyMs, 0),
    slug: clone.market.slug,
    action: "BUY_LIMIT",
    direction: spec.outcome,
    style: spec.style,
    limitPrice: round(spec.limitPrice, 6),
    quoteAsk: round(spec.quoteAsk, 6),
    quoteBid: Number.isFinite(spec.quoteBid) ? round(spec.quoteBid, 6) : null,
    quoteSnapshotAt: clone.orderbook?.updatedAt || "",
    quoteSource: clone.orderbook?.source || "",
    fairPrice: round(spec.fairPrice, 6),
    feeRate: round(feeRate, 6),
    effectivePrice: round(effectivePrice, 6),
    btcDeltaBps: Number.isFinite(spec.btcDeltaBps) ? round(spec.btcDeltaBps, 4) : null,
    notional: round(spec.notional, 6),
    shares,
    remainingShares: shares,
    filledShares: 0,
    filledCost: 0,
    fills: [],
    status: "OPEN",
    reason: spec.reason,
  };
  clone.orders.unshift(order);
  if (order.style !== "maker-ladder" && Number.isFinite(spec.quoteAsk) && spec.quoteAsk <= order.limitPrice) {
    tryFillCloneOrder(clone, order, spec.nowSec, "marketable limit at current ask");
  }
}

function tryFillCloneOrder(clone, order, nowSec, reason) {
  if (order.status === "FILLED") return false;
  const plan = simulateCloneFill(clone, order, nowSec, reason);
  if (!plan || plan.shares <= 0 || plan.cost <= 0) return false;
  recordCloneFill(clone, order, plan, nowSec, reason);
  return true;
}

function simulateCloneFill(clone, order, nowSec, reason) {
  const quote = clone.orderbook?.[order.direction];
  const cfg = clone.config || {};
  const nowMs = marketClockNowMs(clone);
  if (Number.isFinite(num(order.eligibleFillMs, NaN)) && nowMs < num(order.eligibleFillMs)) return null;
  const ageSec = nowSec - num(order.ts);
  const makerLike = order.style === "maker-ladder" || !String(reason).includes("marketable");
  const fillLimit = cloneFillLimitPrice(order, quote, cfg);
  if (!quote || !Number.isFinite(quote.ask) || !Number.isFinite(fillLimit) || quote.ask > fillLimit) return null;
  if (makerLike && ageSec < num(cfg.queueDelaySec)) return null;
  const remaining = remainingOrderShares(order);
  if (remaining <= 0) return null;
  const baseParticipation = num(cfg.liquidityParticipation, 0.35);
  const participation = makerLike ? Math.min(baseParticipation * 0.35, 0.18) : Math.min(baseParticipation, 0.65);
  const levels = visibleAskLevelsAtOrBelow(quote, fillLimit);
  const visibleDepth = round(levels.reduce((total, level) => total + level.price * level.size, 0), 6);
  if (!levels.length || visibleDepth < Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.minVisibleDepthUsdc, POLYMARKET_MIN_ORDER_USDC))) return null;
  let fillShares = 0;
  let tradeCost = 0;
  let fee = 0;
  const usedLevels = [];
  for (const level of levels) {
    if (fillShares >= remaining) break;
    const available = Math.max(0, level.size * participation);
    const shares = Math.min(remaining - fillShares, available);
    if (shares <= 0) continue;
    fillShares += shares;
    tradeCost += shares * level.price;
    const levelFeeRate = makerLike ? num(clone.config?.makerFeeRate, 0) : num(order.feeRate, feeRateForOrder(clone, order.direction, order.style));
    fee += shares * feePerShare(level.price, levelFeeRate);
    usedLevels.push({ price: round(level.price, 6), shares: round(shares, 6) });
  }
  tradeCost = round(tradeCost, 6);
  fee = round(fee, 6);
  const cost = round(tradeCost + fee, 6);
  fillShares = round(fillShares, 6);
  if (cost < Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.minFillUsdc, POLYMARKET_MIN_ORDER_USDC))) return null;
  return {
    shares: fillShares,
    cost,
    tradeCost,
    fee,
    avgPrice: fillShares > 0 ? round(tradeCost / fillShares, 6) : null,
    effectivePrice: fillShares > 0 ? round(cost / fillShares, 6) : null,
    levels: usedLevels,
    fillRatio: round(fillShares / Math.max(remaining, 1e-9), 6),
  };
}

function recordCloneFill(clone, order, plan, nowSec, reason) {
  if (order.status === "FILLED") return;
  const shares = num(plan.shares);
  const cost = round(plan.cost, 6);
  const fillPrice = num(plan.avgPrice);
  order.filledShares = round(num(order.filledShares) + shares, 6);
  order.filledCost = round(num(order.filledCost) + cost, 6);
  order.remainingShares = round(Math.max(0, num(order.shares) - num(order.filledShares)), 6);
  order.status = order.remainingShares <= 0.000001 ? "FILLED" : "PARTIAL";
  order.fillTs = nowSec;
  order.fillIsoTime = isoFromSec(nowSec);
  order.fillMs = Math.round(marketClockNowMs(clone));
  order.fillLatencyMs = Number.isFinite(num(order.snapshotMs, NaN)) ? Math.max(0, order.fillMs - num(order.snapshotMs)) : null;
  order.fillPrice = fillPrice;
  order.fillCost = order.filledCost;
  order.fillReason = reason;
  order.fills ||= [];
  const fillIndex = order.fills.length + 1;
  order.fills.push({
    ts: nowSec,
    isoTime: isoFromSec(nowSec),
    fillMs: order.fillMs,
    fillLatencyMs: order.fillLatencyMs,
    price: fillPrice,
    amountUsdc: cost,
    tradeCost: round(plan.tradeCost, 6),
    fee: round(plan.fee, 6),
    effectivePrice: round(plan.effectivePrice, 6),
    shares,
    levels: plan.levels,
    fillRatio: plan.fillRatio,
    executionLatencyMs: order.executionLatencyMs,
    quoteSnapshotAt: order.quoteSnapshotAt,
  });
  const position = clone.positions[order.direction] || { shares: 0, cost: 0, avgPrice: null };
  position.shares = round(num(position.shares) + shares, 6);
  position.cost = round(num(position.cost) + cost, 6);
  position.avgPrice = position.shares > 0 ? round(position.cost / position.shares, 6) : null;
  clone.positions[order.direction] = position;
  clone.fills.unshift({
    id: `${order.id}-fill-${fillIndex}`,
    orderId: order.id,
    ts: nowSec,
    isoTime: isoFromSec(nowSec),
    fillMs: order.fillMs,
    fillLatencyMs: order.fillLatencyMs,
    slug: order.slug,
    asset: clone.asset || slugAsset(order.slug) || "",
    action: "BUY",
    direction: order.direction,
    price: round(fillPrice, 6),
    amountUsdc: cost,
    tradeCost: round(plan.tradeCost, 6),
    fee: round(plan.fee, 6),
    effectivePrice: round(plan.effectivePrice, 6),
    shares,
    style: order.style,
    reason: order.reason,
    fillReason: reason,
    fillRatio: plan.fillRatio,
    levels: plan.levels,
    executionLatencyMs: order.executionLatencyMs,
    quoteSnapshotAt: order.quoteSnapshotAt,
    btcDeltaBps: order.btcDeltaBps,
    fairPrice: order.fairPrice,
  });
}

function recordCloneSell(clone, spec) {
  const position = clone.positions?.[spec.outcome];
  const availableShares = num(position?.shares);
  if (availableShares <= 0) return false;
  const plan = simulateCloneSell(clone, spec.outcome, Math.min(num(spec.shares), availableShares), spec.limitPrice);
  if (!plan || plan.shares <= 0 || plan.proceeds <= 0) return false;
  clone.nextOrderId = num(clone.nextOrderId, 0) + 1;
  const order = {
    id: `clone-${clone.nextOrderId}`,
    ts: spec.nowSec,
    isoTime: isoFromSec(spec.nowSec),
    slug: clone.market.slug,
    action: "SELL_LIMIT",
    direction: spec.outcome,
    style: "exit",
    limitPrice: round(spec.limitPrice, 6),
    quoteBid: Number.isFinite(spec.quoteBid) ? round(spec.quoteBid, 6) : null,
    quoteAsk: Number.isFinite(spec.quoteAsk) ? round(spec.quoteAsk, 6) : null,
    notional: round(plan.proceeds, 6),
    shares: round(plan.shares, 6),
    remainingShares: 0,
    filledShares: round(plan.shares, 6),
    filledCost: round(plan.proceeds, 6),
    fillTs: spec.nowSec,
    fillIsoTime: isoFromSec(spec.nowSec),
    fillPrice: plan.avgPrice,
    fillCost: round(plan.proceeds, 6),
    fills: [{
      ts: spec.nowSec,
      isoTime: isoFromSec(spec.nowSec),
      price: plan.avgPrice,
      amountUsdc: round(plan.proceeds, 6),
      grossProceeds: round(plan.grossProceeds, 6),
      fee: round(plan.fee, 6),
      effectivePrice: round(plan.effectivePrice, 6),
      shares: round(plan.shares, 6),
      levels: plan.levels,
      fillRatio: plan.fillRatio,
    }],
    status: "FILLED",
    reason: spec.reason,
  };
  clone.orders.unshift(order);

  const beforeShares = availableShares;
  const beforeCost = num(position.cost);
  const costRemoved = round(beforeCost * (plan.shares / beforeShares), 6);
  position.shares = round(Math.max(0, beforeShares - plan.shares), 6);
  position.cost = round(Math.max(0, beforeCost - costRemoved), 6);
  position.avgPrice = position.shares > 0 ? round(position.cost / position.shares, 6) : null;
  position.realizedProceeds = round(num(position.realizedProceeds) + plan.proceeds, 6);
  position.realizedPnl = round(num(position.realizedPnl) + plan.proceeds - costRemoved, 6);
  clone.positions[spec.outcome] = position;

  clone.fills.unshift({
    id: `${order.id}-fill-1`,
    orderId: order.id,
    ts: spec.nowSec,
    isoTime: isoFromSec(spec.nowSec),
    slug: order.slug,
    action: "SELL",
    direction: order.direction,
    price: plan.avgPrice,
    amountUsdc: round(plan.proceeds, 6),
    grossProceeds: round(plan.grossProceeds, 6),
    fee: round(plan.fee, 6),
    effectivePrice: round(plan.effectivePrice, 6),
    shares: round(plan.shares, 6),
    style: order.style,
    reason: spec.reason,
    fillReason: "paper exit at current bid",
    fillRatio: plan.fillRatio,
    levels: plan.levels,
    realizedPnl: round(plan.proceeds - costRemoved, 6),
    btcDeltaBps: Number.isFinite(clone.btc?.deltaBps) ? round(clone.btc.deltaBps, 4) : null,
  });
  return true;
}

function updateCloneAdverseSelection(clone, nowSec) {
  const fills = clone.fills || [];
  let checked = 0;
  let adverse = 0;
  let totalBps = 0;
  const byDirection = {
    Up: { checked: 0, adverse: 0, avgBps: 0 },
    Down: { checked: 0, adverse: 0, avgBps: 0 },
  };
  for (const fill of fills) {
    if (fill.action !== "BUY") continue;
    const quote = clone.orderbook?.[fill.direction];
    const mark = Number.isFinite(quote?.bid) ? num(quote.bid) : Number.isFinite(quote?.mid) ? num(quote.mid) : Number.isFinite(quote?.ask) ? num(quote.ask) : NaN;
    const fillPrice = num(fill.effectivePrice, num(fill.price));
    if (!Number.isFinite(mark) || !Number.isFinite(fillPrice) || fillPrice <= 0) continue;
    const bps = round(((mark - fillPrice) / fillPrice) * 10000, 3);
    fill.adverseCheckedAt = isoFromSec(nowSec);
    fill.markPriceAfterFill = round(mark, 6);
    fill.markMoveBps = bps;
    fill.adverseSelection = bps <= -120;
    checked += 1;
    totalBps += bps;
    const bucket = byDirection[fill.direction] || (byDirection[fill.direction] = { checked: 0, adverse: 0, avgBps: 0 });
    bucket.checked += 1;
    bucket.avgBps += bps;
    if (fill.adverseSelection) {
      adverse += 1;
      bucket.adverse += 1;
    }
  }
  for (const bucket of Object.values(byDirection)) {
    bucket.avgBps = bucket.checked ? round(bucket.avgBps / bucket.checked, 3) : 0;
    bucket.rate = bucket.checked ? round(bucket.adverse / bucket.checked, 4) : 0;
  }
  clone.adverseSelection = {
    checked,
    adverse,
    rate: checked ? round(adverse / checked, 4) : 0,
    avgBps: checked ? round(totalBps / checked, 3) : 0,
    byDirection,
    updatedAt: isoFromSec(nowSec),
  };
}

function simulateCloneSell(clone, outcome, shares, limitPrice) {
  const quote = clone.orderbook?.[outcome];
  if (!quote || !Number.isFinite(quote.bid) || quote.bid < limitPrice) return null;
  const cfg = clone.config || {};
  const participation = num(cfg.liquidityParticipation);
  const levels = (Array.isArray(quote.bids) ? quote.bids : [])
    .map((level) => ({ price: num(level.price), size: num(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0 && level.price >= limitPrice)
    .sort((a, b) => b.price - a.price);
  const visibleDepth = round(levels.reduce((total, level) => total + level.price * level.size, 0), 6);
  if (!levels.length || visibleDepth < Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.minVisibleDepthUsdc, POLYMARKET_MIN_ORDER_USDC))) return null;
  let soldShares = 0;
  let grossProceeds = 0;
  let fee = 0;
  const usedLevels = [];
  for (const level of levels) {
    if (soldShares >= shares) break;
    const available = Math.max(0, level.size * participation);
    const fillShares = Math.min(shares - soldShares, available);
    if (fillShares <= 0) continue;
    soldShares += fillShares;
    grossProceeds += fillShares * level.price;
    fee += fillShares * feePerShare(level.price, num(cfg.takerFeeRate, 0.07));
    usedLevels.push({ price: round(level.price, 6), shares: round(fillShares, 6) });
  }
  soldShares = round(soldShares, 6);
  grossProceeds = round(grossProceeds, 6);
  fee = round(fee, 6);
  const proceeds = round(grossProceeds - fee, 6);
  if (proceeds < Math.max(POLYMARKET_MIN_ORDER_USDC, num(cfg.minFillUsdc, POLYMARKET_MIN_ORDER_USDC))) return null;
  return {
    shares: soldShares,
    proceeds,
    grossProceeds,
    fee,
    avgPrice: soldShares > 0 ? round(grossProceeds / soldShares, 6) : null,
    effectivePrice: soldShares > 0 ? round(proceeds / soldShares, 6) : null,
    levels: usedLevels,
    fillRatio: round(soldShares / Math.max(shares, 1e-9), 6),
  };
}

function updateClonePnl(state, clone) {
  const cost = cloneSpent(clone);
  let marketValue = 0;
  for (const outcome of OUTCOMES) {
    const shares = num(clone.positions?.[outcome]?.shares);
    const quote = clone.orderbook?.[outcome];
    const mark = Number.isFinite(quote?.bid) ? quote.bid : Number.isFinite(quote?.mid) ? quote.mid : 0;
    const exitFee = shares * feePerShare(mark, num(clone.config?.takerFeeRate, 0.07));
    marketValue += Math.max(0, shares * mark - exitFee);
  }
  const window = state.windows?.[clone.market?.slug];
  const winner = (window?.settled ? window.direction || "" : "") || clone.market?.resolvedOutcome || "";
  const settledValue = winner && clone.positions?.[winner] ? num(clone.positions[winner].shares) : 0;
  const closedRealized = round(OUTCOMES.reduce((total, outcome) => total + num(clone.positions?.[outcome]?.realizedPnl), 0), 6);
  clone.pnl = {
    cost: round(cost, 6),
    marketValue: round(marketValue, 6),
    settledValue: round(settledValue, 6),
    closedRealized,
    unrealized: round(closedRealized + marketValue - cost, 6),
    realized: winner ? round(closedRealized + settledValue - cost, 6) : 0,
    winner,
    settled: Boolean(winner),
  };
}

function cloneWindowSnapshot(clone, reason = "archive") {
  if (!clone?.market?.slug) return null;
  const cost = num(clone.pnl?.cost, cloneSpent(clone));
  const buyCost = cloneBuyCost(clone);
  const sellProceeds = cloneSellProceeds(clone);
  const fillCount = (clone.fills || []).length;
  const orderCount = (clone.orders || []).length;
  const observedBuyRows = num(clone.calibration?.observedBuyRows);
  if (cost <= 0 && fillCount <= 0 && orderCount <= 0 && observedBuyRows <= 0) return null;
  const pnl = clone.pnl?.settled ? num(clone.pnl.realized) : num(clone.pnl?.unrealized);
  const lastDecision = clone.lastDecision ? {
    ts: clone.lastDecision.ts,
    isoTime: clone.lastDecision.isoTime,
    status: clone.lastDecision.status,
    elapsedSec: clone.lastDecision.elapsedSec,
    remainingSec: clone.lastDecision.remainingSec,
    preferred: clone.lastDecision.preferred,
    fairUp: clone.lastDecision.fairUp,
    reason: clone.lastDecision.reason || "",
    placed: clone.lastDecision.placed,
    signalBps: clone.lastDecision.signal?.signalBps,
    deltaBps: clone.lastDecision.signal?.deltaBps ?? clone.btc?.deltaBps,
  } : null;
  return {
    slug: clone.market.slug,
    asset: clone.asset || clone.market.asset || slugAsset(clone.market.slug) || "",
    horizon: clone.horizon || slugHorizon(clone.market.slug) || "",
    legKey: clone.legKey || slugLegKey(clone.market.slug) || "",
    title: clone.market.title || clone.market.slug,
    windowStart: clone.market.windowStart,
    windowEnd: clone.market.windowEnd,
    strategyVersionId: clone.strategyVersionId || "",
    strategyVersionName: clone.strategyVersionName || "",
    versionStartedAt: clone.versionStartedAt || null,
    ledgerResetId: clone.ledgerResetId || "",
    ledgerResetName: clone.ledgerResetName || "",
    ledgerResetStartedAt: clone.ledgerResetStartedAt || null,
    archivedAt: new Date().toISOString(),
    archiveReason: reason,
    status: clone.status || "",
    settled: Boolean(clone.pnl?.settled),
    winner: clone.pnl?.winner || "",
    cost: round(cost, 6),
    buyCost: round(buyCost, 6),
    sellProceeds: round(sellProceeds, 6),
    marketValue: round(clone.pnl?.marketValue, 6),
    settledValue: round(clone.pnl?.settledValue, 6),
    pnl: round(pnl, 6),
    fillCount,
    orderCount,
    noTradeReason: cost <= 0 && fillCount <= 0 && orderCount <= 0 ? (lastDecision?.reason || "no paper order generated") : "",
    lastDecision,
    btc: clone.btc ? {
      price: clone.btc.price,
      openPrice: clone.btc.openPrice,
      deltaBps: clone.btc.deltaBps,
      source: clone.btc.priceSource || clone.btc.source || "",
      updatedAt: clone.btc.updatedAt,
    } : null,
    positions: {
      Up: { ...clone.positions?.Up },
      Down: { ...clone.positions?.Down },
    },
    calibration: clone.calibration ? {
      observedBuyRows: clone.calibration.observedBuyRows,
      cloneFillRows: clone.calibration.cloneFillRows,
      matchedRows: clone.calibration.matchedRows,
      directionMatchRate: clone.calibration.directionMatchRate,
      avgSignedTimeErrorSec: clone.calibration.avgSignedTimeErrorSec,
      avgAbsTimeErrorSec: clone.calibration.avgAbsTimeErrorSec,
      avgAbsPriceError: clone.calibration.avgAbsPriceError,
    } : null,
    learner: clone.learner ? {
      currentObservedBuys: clone.learner.currentObservedBuys,
      preferredOutcome: clone.learner.preferredOutcome,
      recentBuyRows30s: clone.learner.recentBuyRows30s,
      medianBuyUsdc: clone.learner.medianBuyUsdc,
      medianWindowBuyRows: clone.learner.medianWindowBuyRows,
    } : null,
    risk: clone.risk ? {
      paused: clone.risk.paused,
      reason: clone.risk.reason,
      dailyLoss: clone.risk.dailyLoss,
      consecutiveLosses: clone.risk.consecutiveLosses,
    } : null,
    adverseSelection: clone.adverseSelection ? {
      checked: clone.adverseSelection.checked,
      adverse: clone.adverseSelection.adverse,
      rate: clone.adverseSelection.rate,
      avgBps: clone.adverseSelection.avgBps,
      byDirection: clone.adverseSelection.byDirection,
    } : null,
  };
}

function archiveCloneWindow(state, clone, reason) {
  ensureCloneLedger(state);
  const snapshot = cloneWindowSnapshot(clone, reason);
  if (!snapshot) return false;
  const index = state.cloneHistory.findIndex((row) => (
    row.slug === snapshot.slug
    && String(row.strategyVersionId || "") === String(snapshot.strategyVersionId || "")
    && String(row.ledgerResetId || "") === String(snapshot.ledgerResetId || "")
  ));
  if (index >= 0) state.cloneHistory[index] = snapshot;
  else state.cloneHistory.unshift(snapshot);
  state.cloneHistory.sort((a, b) => num(b.windowStart) - num(a.windowStart));
  state.cloneHistory = state.cloneHistory.slice(0, 1000);
  recomputeCloneCumulative(state);
  return true;
}

function activePortfolioClones(state) {
  const clones = [];
  const seen = new Set();
  const assets = state.clonePortfolio?.assets || {};
  for (const leg of CRYPTO_LEGS) {
    const clone = assets[leg.key] || (leg.key === "BTC5m" ? state.clone : null);
    if (!clone?.market?.slug) continue;
    const key = `${leg.key}:${clone.market.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clones.push(clone);
  }
  if (!clones.length && state.clone?.market?.slug) clones.push(state.clone);
  return clones;
}

function activePortfolioSnapshots(state, reason = "current") {
  const history = cloneLedgerRows(state);
  return activePortfolioClones(state)
    .map((clone) => cloneWindowSnapshot(clone, reason))
    .filter(Boolean)
    .filter((snapshot) => !history.some((row) => (
      row.slug === snapshot.slug
      && String(row.strategyVersionId || "") === String(snapshot.strategyVersionId || "")
      && String(row.ledgerResetId || "") === String(snapshot.ledgerResetId || "")
    )));
}

function recomputeCloneCumulative(state) {
  ensureCloneLedger(state);
  reconcileCloneHistorySettlements(state);
  const reset = state.cloneLedgerReset || null;
  const history = cloneLedgerRows(state);
  const current = state.clone;
  const currentSnapshot = cloneWindowSnapshot(current, "current");
  const currentAlreadyArchived = currentSnapshot && history.some((row) => (
    row.slug === currentSnapshot.slug
    && String(row.strategyVersionId || "") === String(currentSnapshot.strategyVersionId || "")
    && String(row.ledgerResetId || "") === String(currentSnapshot.ledgerResetId || "")
  ));
  const settledWindows = history.filter((row) => row.settled).length;
  const unsettledWindows = history.length - settledWindows;
  const finalizedCost = round(history.reduce((total, row) => total + num(row.cost), 0), 6);
  const finalizedPnl = round(history.reduce((total, row) => total + num(row.pnl), 0), 6);
  const currentCost = currentSnapshot && !currentAlreadyArchived ? num(currentSnapshot.cost) : 0;
  const currentPnl = currentSnapshot && !currentAlreadyArchived ? num(currentSnapshot.pnl) : 0;
  state.cloneCumulative = {
    resetId: reset?.id || null,
    resetName: reset?.name || null,
    resetStartedAt: reset?.startedAt || null,
    resetStartSec: reset?.startSec || null,
    finalizedWindows: history.length,
    settledWindows,
    unsettledWindows,
    currentSlug: current?.market?.slug || state.slug || null,
    currentCost: round(currentCost, 6),
    currentPnl: round(currentPnl, 6),
    finalizedCost,
    finalizedPnl,
    totalCostIncludingOpen: round(finalizedCost + currentCost, 6),
    totalPnlIncludingOpen: round(finalizedPnl + currentPnl, 6),
    updatedAt: new Date().toISOString(),
  };
  recomputeCloneVersionCumulative(state, currentSnapshot, currentAlreadyArchived);
  recomputeClonePortfolioCumulative(state);
}

function recomputeClonePortfolioCumulative(state) {
  ensureCloneLedger(state);
  const reset = state.cloneLedgerReset || null;
  const history = cloneLedgerRows(state);
  const currentSnapshots = activePortfolioSnapshots(state, "current");
  const finalizedCost = round(history.reduce((total, row) => total + num(row.cost), 0), 6);
  const finalizedPnl = round(history.reduce((total, row) => total + num(row.pnl), 0), 6);
  const currentCost = round(currentSnapshots.reduce((total, row) => total + num(row.cost), 0), 6);
  const currentPnl = round(currentSnapshots.reduce((total, row) => total + num(row.pnl), 0), 6);
  const byAsset = {};
  const byLeg = {};
  for (const asset of CRYPTO_ASSETS) {
    const assetRows = history.filter((row) => (row.asset || slugAsset(row.slug)) === asset);
    const assetCurrent = currentSnapshots.filter((row) => (row.asset || slugAsset(row.slug)) === asset);
    const cost = assetRows.reduce((total, row) => total + num(row.cost), 0) + assetCurrent.reduce((total, row) => total + num(row.cost), 0);
    const pnl = assetRows.reduce((total, row) => total + num(row.pnl), 0) + assetCurrent.reduce((total, row) => total + num(row.pnl), 0);
    byAsset[asset] = {
      windows: assetRows.length + assetCurrent.length,
      currentWindows: assetCurrent.length,
      cost: round(cost, 6),
      pnl: round(pnl, 6),
      returnPct: returnPct(pnl, cost),
    };
  }
  for (const leg of CRYPTO_LEGS) {
    const legRows = history.filter((row) => (row.legKey || slugLegKey(row.slug)) === leg.key);
    const legCurrent = currentSnapshots.filter((row) => (row.legKey || slugLegKey(row.slug)) === leg.key);
    const cost = legRows.reduce((total, row) => total + num(row.cost), 0) + legCurrent.reduce((total, row) => total + num(row.cost), 0);
    const pnl = legRows.reduce((total, row) => total + num(row.pnl), 0) + legCurrent.reduce((total, row) => total + num(row.pnl), 0);
    byLeg[leg.key] = {
      asset: leg.asset,
      horizon: leg.horizon,
      windows: legRows.length + legCurrent.length,
      currentWindows: legCurrent.length,
      cost: round(cost, 6),
      pnl: round(pnl, 6),
      returnPct: returnPct(pnl, cost),
    };
  }
  state.clonePortfolioCumulative = {
    resetId: reset?.id || null,
    resetName: reset?.name || null,
    resetStartedAt: reset?.startedAt || null,
    finalizedWindows: history.length,
    currentWindows: currentSnapshots.length,
    currentSlugs: currentSnapshots.map((row) => row.slug),
    finalizedCost,
    finalizedPnl,
    currentCost,
    currentPnl,
    totalCostIncludingOpen: round(finalizedCost + currentCost, 6),
    totalPnlIncludingOpen: round(finalizedPnl + currentPnl, 6),
    returnPct: returnPct(finalizedPnl + currentPnl, finalizedCost + currentCost),
    byAsset,
    byLeg,
    updatedAt: new Date().toISOString(),
  };
}

function updateClonePortfolioSummary(state, nowSec = Math.floor(Date.now() / 1000)) {
  state.clonePortfolio ||= { enabled: true, assets: {} };
  const assets = state.clonePortfolio.assets || {};
  const rows = CRYPTO_LEGS.map((leg) => {
    const clone = assets[leg.key] || (leg.key === "BTC5m" ? state.clone : null);
    const cost = num(clone?.pnl?.cost);
    const pnl = clone?.pnl?.settled ? num(clone?.pnl?.realized) : num(clone?.pnl?.unrealized);
    return {
      asset: leg.asset,
      horizon: leg.horizon,
      legKey: leg.key,
      slug: clone?.market?.slug || currentCryptoSlug(leg.asset, leg.horizon, nowSec),
      status: clone?.status || "disabled",
      orders: (clone?.orders || []).length,
      fills: (clone?.fills || []).length,
      cost: round(cost, 6),
      pnl: round(pnl, 6),
      returnPct: returnPct(pnl, cost),
      adverseRate: clone?.adverseSelection?.rate ?? null,
      adverseAvgBps: clone?.adverseSelection?.avgBps ?? null,
      updatedAt: clone?.updatedAt || null,
    };
  });
  const currentCost = rows.reduce((total, row) => total + num(row.cost), 0);
  const currentPnl = rows.reduce((total, row) => total + num(row.pnl), 0);
  state.clonePortfolio.assetSummaries = rows;
  state.clonePortfolio.currentCost = round(currentCost, 6);
  state.clonePortfolio.currentPnl = round(currentPnl, 6);
  state.clonePortfolio.currentReturnPct = returnPct(currentPnl, currentCost);
  state.clonePortfolio.updatedAt = isoFromSec(nowSec);
  recomputeClonePortfolioCumulative(state);
}

function cloneLedgerRows(state) {
  const reset = state.cloneLedgerReset || null;
  const rows = state.cloneHistory || [];
  if (!reset?.id) return rows;
  return rows.filter((row) => row.ledgerResetId === reset.id);
}

function recomputeCloneVersionCumulative(state, currentSnapshot = null, currentAlreadyArchived = false) {
  const version = state.cloneVersion;
  if (!version?.id) {
    state.cloneVersionCumulative = emptyCloneVersionCumulative(version);
    return;
  }
  const history = (state.cloneHistory || []).filter((row) => row.strategyVersionId === version.id);
  const currentMatchesVersion = currentSnapshot
    && !currentAlreadyArchived
    && currentSnapshot.strategyVersionId === version.id;
  const settledWindows = history.filter((row) => row.settled).length;
  const unsettledWindows = history.length - settledWindows;
  const finalizedCost = round(history.reduce((total, row) => total + num(row.cost), 0), 6);
  const finalizedPnl = round(history.reduce((total, row) => total + num(row.pnl), 0), 6);
  const currentCost = currentMatchesVersion ? num(currentSnapshot.cost) : 0;
  const currentPnl = currentMatchesVersion ? num(currentSnapshot.pnl) : 0;
  state.cloneVersionCumulative = {
    versionId: version.id,
    versionName: version.name || STRATEGY_VERSION_NAME,
    startedAt: version.startedAt,
    startSec: version.startSec,
    finalizedWindows: history.length,
    settledWindows,
    unsettledWindows,
    currentSlug: state.clone?.market?.slug || state.slug || null,
    currentCost: round(currentCost, 6),
    currentPnl: round(currentPnl, 6),
    finalizedCost,
    finalizedPnl,
    totalCostIncludingOpen: round(finalizedCost + currentCost, 6),
    totalPnlIncludingOpen: round(finalizedPnl + currentPnl, 6),
    updatedAt: new Date().toISOString(),
  };
}

function reconcileCloneHistorySettlements(state) {
  for (const row of state.cloneHistory || []) {
    if (row.settled) continue;
    const observedWindow = state.windows?.[row.slug];
    const winner = observedWindow?.settled ? observedWindow.direction : "";
    if (!winner) continue;
    applySettlementToHistoryRow(row, {
      source: "observed-wallet-settlement",
      checkedAt: new Date().toISOString(),
      winner,
    }, "settlement-reconciled");
  }
}

async function refreshArchivedSettlements(state, opts, nowSec) {
  ensureCloneLedger(state);
  const rows = (state.cloneHistory || [])
    .filter((row) => !row.settled && num(row.windowEnd) && nowSec > num(row.windowEnd) + 20)
    .slice(0, 8);
  for (const row of rows) {
    if (row.lastSettlementCheckSec && nowSec - num(row.lastSettlementCheckSec) < 30) continue;
    row.lastSettlementCheckSec = nowSec;
    try {
      const oracle = await fetchPolymarketSettlement(row.slug, opts);
      row.oracleSettlement = oracle;
      if (oracle.completed && oracle.winner) {
        applySettlementToHistoryRow(row, oracle, "oracle-settlement");
        markWindowSettlement(state, row.slug, oracle);
        continue;
      }
      const market = await fetchCloneMarket(row.slug, opts);
      if (!market.resolvedOutcome || !row.positions?.[market.resolvedOutcome]) continue;
      const gammaSettlement = {
        source: "gamma",
        checkedAt: new Date().toISOString(),
        winner: market.resolvedOutcome,
        resolvedOutcome: market.resolvedOutcome,
        outcomePrices: market.outcomePrices,
      };
      applySettlementToHistoryRow(row, gammaSettlement, "gamma-settlement");
      row.gammaSettlement = gammaSettlement;
      markWindowSettlement(state, row.slug, gammaSettlement);
    } catch (err) {
      row.lastSettlementError = shortError(err);
    }
  }
}

async function refreshObservedWindowSettlements(state, opts, nowSec) {
  const rows = Object.values(state.windows || {})
    .filter((row) => isCrypto5mSlug(row.slug))
    .filter((row) => num(row.buyRows) > 0 && !row.settled && num(row.windowEnd) && nowSec > num(row.windowEnd) + 20)
    .sort((a, b) => num(b.windowEnd) - num(a.windowEnd))
    .slice(0, 10);
  for (const row of rows) {
    if (row.lastSettlementCheckSec && nowSec - num(row.lastSettlementCheckSec) < 30) continue;
    row.lastSettlementCheckSec = nowSec;
    try {
      const oracle = await fetchPolymarketSettlement(row.slug, opts);
      row.oracleSettlement = oracle;
      if (oracle.completed && oracle.winner) {
        markWindowSettlement(state, row.slug, oracle);
      }
    } catch (err) {
      row.lastSettlementError = shortError(err);
    }
  }
}

function settlementValuesForRow(row, winner) {
  const settledValue = winner ? num(row.positions?.[winner]?.shares) : 0;
  const closedRealized = round(OUTCOMES.reduce((total, outcome) => total + num(row.positions?.[outcome]?.realizedPnl), 0), 6);
  const pnl = round(closedRealized + settledValue - num(row.cost), 6);
  return { settledValue: round(settledValue, 6), closedRealized, pnl };
}

function applySettlementToHistoryRow(row, settlement, archiveReason) {
  if (!settlement?.winner) return false;
  const values = settlementValuesForRow(row, settlement.winner);
  row.settled = true;
  row.winner = settlement.winner;
  row.settledValue = values.settledValue;
  row.closedRealized = values.closedRealized;
  row.marketValue = values.settledValue;
  row.pnl = values.pnl;
  row.archiveReason = archiveReason;
  row.archivedAt = settlement.checkedAt || new Date().toISOString();
  row.settlementSource = settlement.source || archiveReason;
  return true;
}

function markWindowSettlement(state, slug, settlement) {
  if (!settlement?.winner) return;
  const windowStart = slugWindowStart(slug);
  const window = state.windows?.[slug] || {
    slug,
    title: slug,
    windowStart,
    windowEnd: Number.isFinite(windowStart) ? windowStart + slugWindowSeconds(slug) : null,
    direction: "",
    tradeRows: 0,
    buyRows: 0,
    sellRows: 0,
    redeemRows: 0,
    buyUsdc: 0,
    sellUsdc: 0,
    redeemUsdc: 0,
    buyShares: 0,
    sellShares: 0,
    avgBuyPrice: null,
    firstBuyTs: null,
    lastBuyTs: null,
    settled: false,
    realizedPnl: 0,
  };
  window.direction = settlement.winner;
  window.settled = true;
  window.oracleSettlement = settlement;
  state.windows[slug] = window;
}

function updateCloneCalibration(state, clone, opts) {
  const observed = (state.trades || [])
    .filter((row) => row.slug === opts.slug && row.action === "BUY")
    .sort((a, b) => num(a.ts) - num(b.ts));
  const fills = (clone.fills || [])
    .filter((row) => row.slug === opts.slug)
    .filter((row) => row.action === "BUY")
    .sort((a, b) => num(a.ts) - num(b.ts));
  const used = new Set();
  const matches = [];
  for (const obs of observed) {
    let best = null;
    let bestScore = Infinity;
    for (const fill of fills) {
      if (used.has(fill.id)) continue;
      if (fill.direction !== obs.direction) continue;
      const timeError = Math.abs(num(fill.ts) - num(obs.ts));
      const priceError = Math.abs(num(fill.price) - num(obs.price));
      if (timeError > opts.cloneMatchSeconds || priceError > opts.clonePriceTolerance) continue;
      const score = timeError + priceError * 100;
      if (score < bestScore) {
        best = fill;
        bestScore = score;
      }
    }
    if (best) {
      used.add(best.id);
      matches.push({
        observedId: obs.id,
        cloneId: best.id,
        direction: obs.direction,
        timeErrorSec: round(num(best.ts) - num(obs.ts), 3),
        priceError: round(num(best.price) - num(obs.price), 6),
      });
    }
  }
  const absTime = matches.reduce((total, row) => total + Math.abs(row.timeErrorSec), 0);
  const signedTime = matches.reduce((total, row) => total + row.timeErrorSec, 0);
  const absPrice = matches.reduce((total, row) => total + Math.abs(row.priceError), 0);
  clone.calibration = {
    observedBuyRows: observed.length,
    cloneFillRows: fills.length,
    matchedRows: matches.length,
    directionMatchRate: observed.length ? round(matches.length / observed.length, 4) : null,
    avgSignedTimeErrorSec: matches.length ? round(signedTime / matches.length, 3) : null,
    avgAbsTimeErrorSec: matches.length ? round(absTime / matches.length, 3) : null,
    avgAbsPriceError: matches.length ? round(absPrice / matches.length, 6) : null,
    missedObservedRows: Math.max(0, observed.length - matches.length),
    extraCloneRows: Math.max(0, fills.length - matches.length),
    updatedAt: new Date().toISOString(),
    sampleMatches: matches.slice(-20),
  };
}

function compactState(state, opts) {
  ensureCloneLedger(state);
  state.trades.sort((a, b) => b.ts - a.ts || String(b.id).localeCompare(String(a.id)));
  state.trades = state.trades.slice(0, opts.maxTrades);
  const seen = new Set(state.trades.map((row) => row.id));
  state.seen = state.seen.filter((key) => seen.has(key)).slice(-opts.maxTrades * 2);
  for (const [slug, window] of Object.entries(state.windows)) {
    const tooOld = window.windowEnd && Date.now() / 1000 - window.windowEnd > 24 * 60 * 60;
    const hasRows = window.buyRows || window.sellRows || window.redeemRows;
    if (tooOld && !hasRows) delete state.windows[slug];
  }
  if (state.clone) {
    state.clone.orders = (state.clone.orders || []).slice(0, 500);
    state.clone.fills = (state.clone.fills || []).slice(0, 500);
  }
  state.cloneHistory = (state.cloneHistory || []).slice(0, 1000);
}

function trimCloneForDashboard(clone, opts) {
  if (!clone || typeof clone !== "object") return clone;
  return {
    ...clone,
    orders: (clone.orders || []).slice(0, opts.dashboardMaxOrders),
    fills: (clone.fills || []).slice(0, opts.dashboardMaxTrades),
  };
}

function dashboardState(state, opts) {
  const assets = state.clonePortfolio?.assets || {};
  const trimmedAssets = Object.fromEntries(Object.entries(assets).map(([key, clone]) => [key, trimCloneForDashboard(clone, opts)]));
  return {
    wallet: state.wallet,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    status: state.status,
    lastError: state.lastError,
    pollMs: state.pollMs,
    paperOnly: state.paperOnly,
    autoBtc5m: state.autoBtc5m,
    slug: state.slug,
    eventUrl: state.eventUrl,
    marketClockOffsetSec: state.marketClockOffsetSec,
    marketClockSource: state.marketClockSource,
    marketClockUpdatedAt: state.marketClockUpdatedAt,
    summary: state.summary,
    clone: trimCloneForDashboard(state.clone, opts),
    clonePortfolio: {
      ...(state.clonePortfolio || {}),
      assets: trimmedAssets,
    },
    cloneCumulative: state.cloneCumulative,
    clonePortfolioCumulative: state.clonePortfolioCumulative,
    cloneVersion: state.cloneVersion,
    cloneVersionCumulative: state.cloneVersionCumulative,
    cloneLedgerReset: state.cloneLedgerReset,
    hourlyPerformance: state.hourlyPerformance,
    winrateComparison: state.winrateComparison,
    trades: (state.trades || []).slice(0, opts.dashboardMaxTrades),
    cloneHistory: (state.cloneHistory || []).slice(0, opts.dashboardMaxHistory),
    dashboard: {
      optimized: true,
      maxTrades: opts.dashboardMaxTrades,
      maxHistory: opts.dashboardMaxHistory,
      maxOrders: opts.dashboardMaxOrders,
      fullStateBytes: 0,
      generatedAt: new Date().toISOString(),
    },
  };
}

function recomputeSummary(state) {
  const windows = Object.values(state.windows);
  const activeWindows = windows.filter((row) => row.buyRows > 0);
  state.summary = {
    tradeRows: state.trades.length,
    buyRows: state.trades.filter((row) => row.action === "BUY").length,
    redeemRows: state.trades.filter((row) => row.action === "REDEEM").length,
    buyUsdc: round(activeWindows.reduce((total, row) => total + num(row.buyUsdc), 0), 4),
    redeemUsdc: round(activeWindows.reduce((total, row) => total + num(row.redeemUsdc), 0), 4),
    realizedPnl: round(activeWindows.reduce((total, row) => total + num(row.realizedPnl), 0), 4),
    openWindows: activeWindows.filter((row) => !row.settled).length,
    totalWindows: activeWindows.length,
  };
}

function returnPct(pnl, cost) {
  const c = num(cost);
  if (c <= 0) return null;
  return round((num(pnl) / c) * 100, 4);
}

function hourPeriod(nowSec = Math.floor(Date.now() / 1000), offsetHours = 0) {
  const end = Math.floor(nowSec / 3600) * 3600 - offsetHours * 3600;
  const start = end - 3600;
  return {
    start,
    end,
    label: `${isoFromSec(start)} - ${isoFromSec(end)}`,
  };
}

function localTimeLabel(sec) {
  return new Date(sec * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function recomputeHourlyPerformance(state, nowSec = Math.floor(Date.now() / 1000)) {
  const lastCompleted = hourPeriod(nowSec, 0);
  const rolling = { start: nowSec - 3600, end: nowSec, label: `${isoFromSec(nowSec - 3600)} - ${isoFromSec(nowSec)}` };
  const rolling24h = { start: nowSec - 24 * 3600, end: nowSec, label: `${isoFromSec(nowSec - 24 * 3600)} - ${isoFromSec(nowSec)}` };
  state.hourlyPerformance = {
    updatedAt: isoFromSec(nowSec),
    lastCompletedHour: performanceForPeriod(state, lastCompleted.start, lastCompleted.end, { includeOpen: false }),
    rollingHour: performanceForPeriod(state, rolling.start, rolling.end, { includeOpen: true }),
    rolling24h: performanceForPeriod(state, rolling24h.start, rolling24h.end, { includeOpen: true }),
  };
}

function performanceForPeriod(state, startSec, endSec, options = {}) {
  return {
    startSec,
    endSec,
    startIso: isoFromSec(startSec),
    endIso: isoFromSec(endSec),
    startLocal: localTimeLabel(startSec),
    endLocal: localTimeLabel(endSec),
    includeOpen: Boolean(options.includeOpen),
    paper: paperPerformanceForPeriod(state, startSec, endSec, options),
    bonereaper: observedPerformanceForPeriod(state, startSec, endSec, options),
  };
}

function inPeriodByWindowEnd(row, startSec, endSec, includeOpen = false) {
  const start = num(row.windowStart, NaN);
  const end = num(row.windowEnd, NaN);
  if (!Number.isFinite(end)) return false;
  if (includeOpen && Number.isFinite(start)) return end > startSec && start < endSec;
  return end > startSec && end <= endSec;
}

function paperPerformanceForPeriod(state, startSec, endSec, options = {}) {
  const includeOpen = Boolean(options.includeOpen);
  const rows = cloneLedgerRows(state).filter((row) => inPeriodByWindowEnd(row, startSec, endSec, includeOpen));
  if (includeOpen) {
    for (const current of activePortfolioSnapshots(state, "current")) {
      if (current && current.ledgerResetId === state.cloneLedgerReset?.id && inPeriodByWindowEnd(current, startSec, endSec, includeOpen)
          && !rows.some((row) => row.slug === current.slug && row.ledgerResetId === current.ledgerResetId)) {
        rows.push(current);
      }
    }
  }
  const cost = round(rows.reduce((total, row) => total + num(row.buyCost, num(row.cost)), 0), 6);
  const pnl = round(rows.reduce((total, row) => total + num(row.pnl), 0), 6);
  return {
    windows: rows.length,
    settledWindows: rows.filter((row) => row.settled).length,
    unsettledWindows: rows.filter((row) => !row.settled).length,
    cost,
    pnl,
    returnPct: returnPct(pnl, cost),
  };
}

function observedPerformanceForPeriod(state, startSec, endSec, options = {}) {
  const includeOpen = Boolean(options.includeOpen);
  const windows = Object.values(state.windows || {})
    .filter((row) => isCrypto5mSlug(row.slug))
    .filter((row) => num(row.buyRows) > 0)
    .filter((row) => inPeriodByWindowEnd(row, startSec, endSec, includeOpen))
    .map((row) => observedWindowPerformance(state, row));
  const confirmed = windows.filter((row) => row.settled);
  const pending = windows.filter((row) => !row.settled);
  const totalCost = round(windows.reduce((total, row) => total + num(row.cost), 0), 6);
  const confirmedCost = round(confirmed.reduce((total, row) => total + num(row.cost), 0), 6);
  const pendingCost = round(pending.reduce((total, row) => total + num(row.cost), 0), 6);
  const pnl = round(confirmed.reduce((total, row) => total + num(row.pnl), 0), 6);
  return {
    windows: windows.length,
    settledWindows: confirmed.length,
    unsettledWindows: pending.length,
    cost: totalCost,
    confirmedCost,
    pendingCost,
    pnl,
    returnPct: returnPct(pnl, confirmedCost),
  };
}

function observedWindowPerformance(state, window) {
  const rows = (state.trades || []).filter((row) => row.slug === window.slug);
  const buyRows = rows.filter((row) => row.action === "BUY");
  const sellRows = rows.filter((row) => row.action === "SELL");
  const cost = round(num(window.buyUsdc, buyRows.reduce((total, row) => total + num(row.amountUsdc), 0)), 6);
  const sellProceeds = round(num(window.sellUsdc, sellRows.reduce((total, row) => total + num(row.amountUsdc), 0)), 6);
  const winner = window.settled ? window.direction || window.oracleSettlement?.winner || "" : "";
  let payout = 0;
  if (winner) {
    if (num(window.redeemUsdc) > 0) {
      payout = num(window.redeemUsdc);
    } else {
      const winnerBought = buyRows
        .filter((row) => row.direction === winner)
        .reduce((total, row) => total + num(row.shares), 0);
      const winnerSold = sellRows
        .filter((row) => row.direction === winner)
        .reduce((total, row) => total + num(row.shares), 0);
      payout = Math.max(0, winnerBought - winnerSold);
    }
  }
  const settled = Boolean(winner);
  const pnl = settled ? round(sellProceeds + payout - cost, 6) : 0;
  return {
    slug: window.slug,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    settled,
    winner,
    cost,
    sellProceeds,
    payout: round(payout, 6),
    pnl,
  };
}

function cloneDirectionPrediction(row) {
  const up = num(row.positions?.Up?.shares);
  const down = num(row.positions?.Down?.shares);
  if (up > down) return "Up";
  if (down > up) return "Down";
  return row.lastDecision?.preferred || "";
}

function summarizeWinrateRows(rows, costKey = "cost") {
  const settled = rows.filter((row) => row.settled && OUTCOMES.includes(row.winner));
  const wins = settled.filter((row) => num(row.pnl) > 0);
  const losses = settled.filter((row) => num(row.pnl) < 0);
  const flats = settled.filter((row) => num(row.pnl) === 0);
  const directionHits = settled.filter((row) => row.directionHit).length;
  const cost = settled.reduce((total, row) => total + num(row[costKey]), 0);
  const pnl = settled.reduce((total, row) => total + num(row.pnl), 0);
  const byLeg = {};
  for (const leg of CRYPTO_LEGS) {
    const legRows = settled.filter((row) => (row.legKey || slugLegKey(row.slug)) === leg.key);
    const legCost = legRows.reduce((total, row) => total + num(row[costKey]), 0);
    const legPnl = legRows.reduce((total, row) => total + num(row.pnl), 0);
    const legWins = legRows.filter((row) => num(row.pnl) > 0).length;
    const legDirectionHits = legRows.filter((row) => row.directionHit).length;
    byLeg[leg.key] = {
      windows: legRows.length,
      wins: legWins,
      directionHits: legDirectionHits,
      winRate: legRows.length ? returnPct(legWins, legRows.length) : null,
      directionHitRate: legRows.length ? returnPct(legDirectionHits, legRows.length) : null,
      cost: round(legCost, 6),
      pnl: round(legPnl, 6),
      returnPct: returnPct(legPnl, legCost),
    };
  }
  return {
    windows: rows.length,
    settled: settled.length,
    pending: rows.length - settled.length,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    directionHits,
    winRate: settled.length ? returnPct(wins.length, settled.length) : null,
    directionHitRate: settled.length ? returnPct(directionHits, settled.length) : null,
    cost: round(cost, 6),
    pnl: round(pnl, 6),
    returnPct: returnPct(pnl, cost),
    byLeg,
  };
}

function observedComparisonRows(state, startSec, endSec) {
  const grouped = new Map();
  for (const row of state.trades || []) {
    const slug = row.slug || "";
    const windowStart = slugWindowStart(slug);
    if (!isCrypto5mSlug(slug) || !Number.isFinite(windowStart)) continue;
    if (windowStart < startSec || windowStart > endSec) continue;
    if (!["BUY", "SELL", "REDEEM"].includes(row.action)) continue;
    const group = grouped.get(slug) || {
      slug,
      legKey: slugLegKey(slug),
      windowStart,
      windowEnd: windowStart + slugWindowSeconds(slug),
      buyRows: 0,
      sellRows: 0,
      redeemRows: 0,
      cost: 0,
      sellProceeds: 0,
      redeemUsdc: 0,
      shares: { Up: 0, Down: 0 },
      soldShares: { Up: 0, Down: 0 },
    };
    if (row.action === "BUY") {
      group.buyRows += 1;
      group.cost += num(row.amountUsdc);
      if (OUTCOMES.includes(row.direction)) group.shares[row.direction] += num(row.shares);
    } else if (row.action === "SELL") {
      group.sellRows += 1;
      group.sellProceeds += num(row.amountUsdc);
      if (OUTCOMES.includes(row.direction)) group.soldShares[row.direction] += num(row.shares);
    } else if (row.action === "REDEEM") {
      group.redeemRows += 1;
      group.redeemUsdc += num(row.amountUsdc);
    }
    grouped.set(slug, group);
  }
  return [...grouped.values()]
    .filter((row) => row.buyRows > 0)
    .map((row) => {
      const window = state.windows?.[row.slug] || {};
      const winner = window.oracleSettlement?.winner || (window.settled ? window.direction : "");
      const payout = row.redeemUsdc > 0
        ? row.redeemUsdc
        : winner
          ? Math.max(0, num(row.shares[winner]) - num(row.soldShares[winner]))
          : 0;
      const pnl = winner ? row.sellProceeds + payout - row.cost : 0;
      const upNet = num(row.shares.Up) - num(row.soldShares.Up);
      const downNet = num(row.shares.Down) - num(row.soldShares.Down);
      const dominant = upNet > downNet ? "Up" : downNet > upNet ? "Down" : "";
      return {
        ...row,
        winner,
        settled: OUTCOMES.includes(winner),
        dominant,
        directionHit: OUTCOMES.includes(winner) && dominant === winner,
        cost: round(row.cost, 6),
        pnl: round(pnl, 6),
      };
    });
}

function recomputeWinrateComparison(state, nowSec = Math.floor(Date.now() / 1000)) {
  const startSec = num(state.cloneVersion?.startSec, Math.floor(Date.parse(state.cloneVersion?.startedAt || state.startedAt || 0) / 1000));
  const ourRows = (state.cloneHistory || [])
    .filter((row) => row.strategyVersionId === state.cloneVersion?.id)
    .filter((row) => num(row.cost) > 0)
    .map((row) => ({
      ...row,
      legKey: row.legKey || slugLegKey(row.slug),
      directionHit: OUTCOMES.includes(row.winner) && cloneDirectionPrediction(row) === row.winner,
    }));
  const bonereaperRows = observedComparisonRows(state, startSec, nowSec);
  state.winrateComparison = {
    updatedAt: new Date().toISOString(),
    versionId: state.cloneVersion?.id || "",
    versionName: state.cloneVersion?.name || "",
    period: {
      startSec,
      endSec: nowSec,
      startIso: isoFromSec(startSec),
      endIso: isoFromSec(nowSec),
    },
    source: "local activity cache; public activity rows are de-duplicated before grouping",
    cacheRows: (state.trades || []).length,
    our: summarizeWinrateRows(ourRows, "cost"),
    bonereaper: summarizeWinrateRows(bonereaperRows, "cost"),
  };
}

function renderHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bonereaper 实时模拟盘</title>
  <style>
    :root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#e6edf3}
    body{margin:0;padding:22px}
    header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px}
    h1{margin:0 0 6px;font-size:24px}
    .muted{color:#8b949e;font-size:13px;line-height:1.6}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:16px 0}
    .card{border:1px solid #30363d;background:#161b22;border-radius:8px;padding:12px}
    .card b{display:block;font-size:20px;margin-top:4px}
    .ok{color:#3fb950}.bad{color:#f85149}.warn{color:#d29922}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th,td{border-bottom:1px solid #30363d;padding:7px 8px;vertical-align:top}
    th{position:sticky;top:0;background:#161b22;text-align:left;z-index:1}
    .num{text-align:right;font-variant-numeric:tabular-nums}
    code{color:#a5d6ff}
    .wrap{border:1px solid #30363d;border-radius:8px;max-height:62vh;overflow:auto;background:#0d1117}
    input{padding:9px 10px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;width:min(520px,100%)}
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Bonereaper 实时模拟盘</h1>
      <div class="muted">实时读取公开 activity，模拟盘镜像记录；不下真实订单。</div>
    </div>
    <div class="muted" id="meta">加载中...</div>
  </header>
  <section class="cards">
    <div class="card">状态<b id="status">-</b></div>
    <div class="card">BUY 行数<b id="buyRows">-</b></div>
    <div class="card">买入 USDC<b id="buyUsdc">-</b></div>
    <div class="card">赎回 USDC<b id="redeemUsdc">-</b></div>
    <div class="card">已实现盈亏<b id="pnl">-</b></div>
    <div class="card">未结窗口<b id="openWindows">-</b></div>
  </section>
  <p><input id="filter" placeholder="过滤动作 / 市场 / 方向 / 交易哈希"></p>
  <div class="wrap">
    <table>
      <thead><tr><th>时间</th><th>动作</th><th>窗口</th><th>方向</th><th class="num">价格</th><th class="num">USDC</th><th class="num">份额</th><th class="num">盈亏</th><th>原因</th><th>交易哈希</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <script>
    const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
    const fmt = (n, d=2) => Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d}) : '';
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const statusText = s => ({ ok:'正常', error:'错误', starting:'启动中', waiting:'等待中' }[String(s)] || s || '-');
    const actionText = s => ({ BUY:'买入', SELL:'卖出', REDEEM:'赎回', TRADE:'成交' }[String(s)] || s || '-');
    const dirText = s => ({ Up:'上涨', Down:'下跌' }[String(s)] || s || '-');
    const reasonText = s => String(s ?? '').replace('live public activity mirror', '公开成交实时镜像');
    let last = null;
    async function load() {
      try {
        const res = await fetch('./dashboard-state.json?ts=' + Date.now(), { cache: 'no-store' });
        last = await res.json();
        render();
      } catch (e) {
        els.status.textContent = '离线';
        els.status.className = 'bad';
        els.meta.textContent = e.message;
      }
    }
    function render() {
      const s = last.summary || {};
      els.status.textContent = statusText(last.status);
      els.status.className = last.status === 'ok' ? 'ok' : last.status === 'error' ? 'bad' : 'warn';
      els.buyRows.textContent = s.buyRows ?? 0;
      els.buyUsdc.textContent = fmt(s.buyUsdc);
      els.redeemUsdc.textContent = fmt(s.redeemUsdc);
      els.pnl.textContent = fmt(s.realizedPnl);
      els.pnl.className = Number(s.realizedPnl) >= 0 ? 'ok' : 'bad';
      els.openWindows.textContent = s.openWindows ?? 0;
      const eventLine = last.slug ? '<br>市场：<code>' + esc(last.slug) + '</code>' : '';
      const linkLine = last.eventUrl ? '<br><a href="' + esc(last.eventUrl) + '" target="_blank" rel="noreferrer">打开 Polymarket 市场</a>' : '';
      els.meta.innerHTML = '更新时间：' + esc(last.updatedAt || '-') + '<br>钱包：<code>' + esc(last.wallet) + '</code>' + eventLine + linkLine + '<br>' + esc(last.lastError || '');
      const q = els.filter.value.trim().toLowerCase();
      const rows = (last.trades || []).filter(row => !q || JSON.stringify(row).toLowerCase().includes(q));
      els.rows.innerHTML = rows.map(row => {
        const pnl = row.pnl == null ? '' : fmt(row.pnl);
        const pnlCls = Number(row.pnl) >= 0 ? 'ok' : 'bad';
        const tx = row.tx ? '<code>' + esc(row.tx.slice(0,10) + '...' + row.tx.slice(-6)) + '</code>' : '';
        return '<tr><td>'+esc(row.isoTime)+'</td><td>'+esc(actionText(row.action))+'</td><td><code>'+esc(row.slug)+'</code></td><td>'+esc(dirText(row.direction))+'</td><td class="num">'+fmt(row.price,4)+'</td><td class="num">'+fmt(row.amountUsdc)+'</td><td class="num">'+fmt(row.shares)+'</td><td class="num '+pnlCls+'">'+pnl+'</td><td>'+esc(reasonText(row.reason))+'</td><td>'+tx+'</td></tr>';
      }).join('');
    }
    els.filter.addEventListener('input', render);
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`;
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bonereaper 行为克隆模拟盘</title>
  <style>
    :root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0f14;color:#e6edf3}
    body{margin:0;padding:20px}
    header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:14px}
    h1{margin:0 0 6px;font-size:24px}
    h2{font-size:16px;margin:22px 0 10px}
    .muted{color:#8b949e;font-size:13px;line-height:1.6}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin:12px 0}
    .card{border:1px solid #2f363f;background:#151b23;border-radius:8px;padding:11px}
    .card span{color:#8b949e;font-size:12px}
    .card b{display:block;font-size:20px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ok{color:#3fb950}.bad{color:#f85149}.warn{color:#d29922}.blue{color:#79c0ff}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th,td{border-bottom:1px solid #30363d;padding:7px 8px;vertical-align:top}
    th{position:sticky;top:0;background:#151b23;text-align:left;z-index:1}
    .num{text-align:right;font-variant-numeric:tabular-nums}
    code{color:#a5d6ff}
    a{color:#79c0ff}
    .wrap{border:1px solid #30363d;border-radius:8px;max-height:39vh;overflow:auto;background:#0b0f14}
    input{padding:9px 10px;border-radius:6px;border:1px solid #30363d;background:#0b0f14;color:#e6edf3;width:min(520px,100%)}
    .split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
    .chartPanel{border:1px solid #30363d;background:#111821;border-radius:8px;padding:12px;margin:14px 0;position:relative}
    .chartHead{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:8px}
    .chartHead h2{margin:0 0 4px}
    .legend{display:flex;gap:12px;flex-wrap:wrap;color:#8b949e;font-size:12px}
    .legend span{display:inline-flex;align-items:center;gap:6px}
    .swatch{width:18px;height:3px;border-radius:999px;background:#79c0ff;display:inline-block}
    .swatch.ok{background:#3fb950}.swatch.bad{background:#f85149}
    #pnlChart,#totalPnlChart{width:100%;display:block;cursor:crosshair}
    #pnlChart{height:620px}
    #totalPnlChart{height:380px}
    .chartTip{position:absolute;display:none;min-width:230px;max-width:300px;pointer-events:none;z-index:5;padding:10px 12px;border:1px solid #30363d;border-radius:8px;background:rgba(13,17,23,.97);box-shadow:0 12px 28px rgba(0,0,0,.36);font-size:12px;line-height:1.55}
    .chartTip b{display:block;margin-bottom:4px;font-size:13px}
    .chartTip .tipSlug{color:#8b949e;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .chartTip .tipRow{display:flex;justify-content:space-between;gap:16px;border-top:1px solid rgba(48,54,61,.65);padding-top:5px;margin-top:5px}
    .chartTip .tipValue{font-variant-numeric:tabular-nums}
    @media (max-width:900px){.split{grid-template-columns:1fr}header{display:block}}
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Bonereaper 行为克隆模拟盘</h1>
      <div class="muted">只跑模拟盘：同步观察 Bonereaper 钱包成交，同时用 BTC 价格和 Polymarket 盘口生成本地 paper 订单。</div>
    </div>
    <div class="muted" id="meta">加载中...</div>
  </header>
  <section class="grid">
    <div class="card"><span>镜像状态</span><b id="status">-</b></div>
    <div class="card"><span>观察到的买入笔数</span><b id="buyRows">-</b></div>
    <div class="card"><span>观察买入金额</span><b id="buyUsdc">-</b></div>
    <div class="card"><span>观察赎回金额</span><b id="redeemUsdc">-</b></div>
    <div class="card"><span>观察已实现盈亏</span><b id="pnl">-</b></div>
    <div class="card"><span>观察未赎回窗口</span><b id="openWindows">-</b></div>
  </section>
  <section class="grid">
    <div class="card"><span>克隆状态</span><b id="cloneStatus">-</b></div>
    <div class="card"><span>BTC 现价</span><b id="btcPrice">-</b></div>
    <div class="card"><span>BTC 相对开盘 bps</span><b id="btcDelta">-</b></div>
    <div class="card"><span>BTC 数据更新时间</span><b id="btcUpdated">-</b></div>
    <div class="card"><span>最近 BTC 样本</span><b id="btcSamples">-</b></div>
    <div class="card"><span>上涨 / 下跌卖一</span><b id="asks">-</b></div>
    <div class="card"><span>双边组合卖一</span><b id="comboAsk">-</b></div>
    <div class="card"><span>当前窗口浮动盈亏</span><b id="clonePnl">-</b></div>
    <div class="card"><span>新规则累计盈亏</span><b id="versionCumulativePnl">-</b></div>
    <div class="card"><span>新规则已结算盈亏</span><b id="versionFinalizedPnl">-</b></div>
    <div class="card"><span>新规则窗口数</span><b id="versionWindows">-</b></div>
    <div class="card"><span>总账累计（重置后）</span><b id="cumulativePnl">-</b></div>
    <div class="card"><span>总账已结算（重置后）</span><b id="finalizedPnl">-</b></div>
    <div class="card"><span>组合当前盈亏</span><b id="portfolioCurrentPnl">-</b></div>
    <div class="card"><span>组合累计盈亏</span><b id="portfolioCumulativePnl">-</b></div>
    <div class="card"><span>滚动 1 小时组合</span><b id="portfolioRollingHour">-</b></div>
    <div class="card"><span>滚动 24 小时组合</span><b id="portfolioRolling24h">-</b></div>
    <div class="card"><span>BTC 15m 状态</span><b id="btc15Status">-</b></div>
    <div class="card"><span>BTC 15m 成交数</span><b id="btc15Fills">-</b></div>
    <div class="card"><span>ETH 5m 状态</span><b id="eth5Status">-</b></div>
    <div class="card"><span>ETH 5m 成交数</span><b id="eth5Fills">-</b></div>
    <div class="card"><span>ETH 15m 状态</span><b id="eth15Status">-</b></div>
    <div class="card"><span>ETH 15m 成交数</span><b id="eth15Fills">-</b></div>
    <div class="card"><span>父级趋势过滤</span><b id="parentTrend">-</b></div>
    <div class="card"><span>四腿预算分配</span><b id="legBudgetMix">-</b></div>
    <div class="card"><span>逆向选择率</span><b id="adverseSelection">-</b></div>
    <div class="card"><span>上一小时我们收益比</span><b id="hourlyPaperReturn">-</b></div>
    <div class="card"><span>上一小时 Bonereaper 收益比</span><b id="hourlyBonereaperReturn">-</b></div>
    <div class="card"><span>滚动小时我们投入</span><b id="rollingPaper">-</b></div>
    <div class="card"><span>滚动小时 Bonereaper</span><b id="rollingBonereaper">-</b></div>
    <div class="card"><span>风控状态</span><b id="riskGuard">-</b></div>
    <div class="card"><span>Polymarket 开盘价</span><b id="openSample">-</b></div>
    <div class="card"><span>模拟成交数</span><b id="cloneFills">-</b></div>
    <div class="card"><span>匹配校准</span><b id="calibration">-</b></div>
    <div class="card"><span>实时学习</span><b id="learnerStatus">-</b></div>
    <div class="card"><span>新规则版本</span><b id="versionInfo">-</b></div>
    <div class="card"><span>最小成交约束</span><b id="minTradeRule">-</b></div>
    <div class="card"><span>模拟响应延迟</span><b id="executionLatency">-</b></div>
    <div class="card"><span>自适应参数</span><b id="adaptiveParams">-</b></div>
    <div class="card"><span>模拟待结算窗口</span><b id="cloneUnsettledWindows">-</b></div>
    <div class="card"><span>已归档窗口</span><b id="finalizedWindows">-</b></div>
    <div class="card"><span>我们胜率</span><b id="ourWinRate">-</b></div>
    <div class="card"><span>Bonereaper 胜率</span><b id="bonereaperWinRate">-</b></div>
    <div class="card"><span>我们方向命中率</span><b id="ourDirectionRate">-</b></div>
    <div class="card"><span>Bonereaper 方向命中率</span><b id="bonereaperDirectionRate">-</b></div>
  </section>
  <div class="muted" id="decision">-</div>
  <section class="chartPanel">
    <div class="chartHead">
      <div>
        <h2>信测率/胜率对比</h2>
        <div class="muted" id="winrateMeta">-</div>
      </div>
      <div class="legend">
        <span><i class="swatch ok"></i>胜率</span>
        <span><i class="swatch"></i>方向命中率</span>
        <span><i class="swatch bad"></i>收益率</span>
      </div>
    </div>
    <div class="wrap" style="max-height:240px">
      <table>
        <thead><tr><th>盘口</th><th class="num">我们窗口</th><th class="num">我们胜率</th><th class="num">我们方向命中</th><th class="num">我们收益率</th><th class="num">Bonereaper窗口</th><th class="num">Bonereaper胜率</th><th class="num">Bonereaper方向命中</th><th class="num">Bonereaper收益率</th></tr></thead>
        <tbody id="winrateRows"></tbody>
      </table>
    </div>
  </section>
  <section class="chartPanel">
    <div class="chartHead">
      <div>
        <h2>新规则四盘口盈亏波动图</h2>
        <div class="muted" id="pnlChartMeta">-</div>
      </div>
      <div class="legend">
        <span><i class="swatch ok"></i>单窗口盈利</span>
        <span><i class="swatch bad"></i>单窗口亏损</span>
        <span><i class="swatch"></i>单盘口累计</span>
      </div>
    </div>
    <canvas id="pnlChart"></canvas>
    <div class="chartTip" id="pnlChartTip"></div>
  </section>
  <section class="chartPanel">
    <div class="chartHead">
      <div>
        <h2>总收益曲线图</h2>
        <div class="muted" id="totalPnlChartMeta">-</div>
      </div>
      <div class="legend">
        <span><i class="swatch"></i>累计收益</span>
        <span><i class="swatch ok"></i>单窗口盈利</span>
        <span><i class="swatch bad"></i>单窗口亏损</span>
      </div>
    </div>
    <canvas id="totalPnlChart"></canvas>
    <div class="chartTip" id="totalPnlChartTip"></div>
  </section>
  <p><input id="filter" placeholder="过滤动作 / 市场 / 方向 / 原因 / 交易哈希"></p>
  <div class="split">
    <section>
      <h2>模拟成交</h2>
      <div class="wrap">
        <table>
          <thead><tr><th>时间</th><th>动作</th><th>方向</th><th>类型</th><th class="num">价格</th><th class="num">USDC</th><th class="num">份额</th><th>原因</th></tr></thead>
          <tbody id="cloneFillRows"></tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>模拟订单</h2>
      <div class="wrap">
        <table>
          <thead><tr><th>时间</th><th>状态</th><th>方向</th><th>类型</th><th class="num">限价</th><th class="num">剩余份额</th><th>原因</th></tr></thead>
          <tbody id="cloneOrderRows"></tbody>
        </table>
      </div>
    </section>
  </div>
  <h2>模拟累计历史</h2>
  <div class="wrap">
    <table>
      <thead><tr><th>窗口</th><th>状态</th><th>胜出方向</th><th>结算源</th><th class="num">成本</th><th class="num">盈亏</th><th class="num">成交</th><th class="num">匹配</th><th>归档时间</th></tr></thead>
      <tbody id="cloneHistoryRows"></tbody>
    </table>
  </div>
  <h2>Bonereaper 公开成交</h2>
  <div class="wrap">
    <table>
      <thead><tr><th>时间</th><th>动作</th><th>窗口</th><th>方向</th><th class="num">价格</th><th class="num">USDC</th><th class="num">份额</th><th class="num">盈亏</th><th>原因</th><th>交易哈希</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <script>
    const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
    const fmt = (n, d=2) => Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d}) : '-';
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const statusText = s => ({
      ok:'正常', error:'错误', starting:'启动中', waiting:'等待中', placed:'已生成订单', cooldown:'冷却中',
      idle:'空闲', closed:'已结束', disabled:'已禁用', 'risk-paused':'风控暂停', 'budget-full':'预算用完',
      'adverse-guard':'逆向选择保护',
      'max-orders':'已达本窗口订单上限',
      OPEN:'未成交', PARTIAL:'部分成交', FILLED:'已成交', EXPIRED:'已过期', EXPIRED_PARTIAL:'部分成交后过期'
    }[String(s)] || s || '-');
    const actionText = s => ({ BUY:'买入', SELL:'卖出', REDEEM:'赎回', TRADE:'成交', BUY_LIMIT:'限价买入', SELL_LIMIT:'限价卖出' }[String(s)] || s || '-');
    const dirText = s => ({ Up:'上涨', Down:'下跌' }[String(s)] || s || '-');
    const styleText = s => ({ cross:'吃单', 'maker-ladder':'挂单阶梯', exit:'退出' }[String(s)] || s || '-');
    const CHART_LEGS = [
      { key:'BTC5m', label:'BTC 5m', color:'#79c0ff' },
      { key:'BTC15m', label:'BTC 15m', color:'#a371f7' },
      { key:'ETH5m', label:'ETH 5m', color:'#f2cc60' },
      { key:'ETH15m', label:'ETH 15m', color:'#56d4dd' },
    ];
    const legKeyFromSlug = slug => {
      const match = String(slug || '').match(/^(btc|eth)-updown-(5m|15m)-/i);
      return match ? match[1].toUpperCase() + match[2].toLowerCase() : '';
    };
    const chartLegLabel = key => CHART_LEGS.find(row => row.key === key)?.label || key || '-';
    const settlementText = s => ({
      'polymarket-crypto-price':'Polymarket 价格源',
      gamma:'Gamma',
      'observed-wallet-settlement':'钱包结算',
      'oracle-settlement':'Polymarket 价格源',
      'gamma-settlement':'Gamma'
    }[String(s)] || s || '-');
    const reasonText = s => String(s ?? '')
      .replace(/fair ([0-9.]+) minus ask ([0-9.]+)/g, '公允价 $1 高于卖一 $2')
      .replace(/fair ([0-9.]+) minus fee-adjusted ask ([0-9.]+)/g, '公允价 $1 高于含费卖一 $2')
      .replace(/micro maker probe (Up|Down) signal (-?[0-9.]+) bps/g, '小资金挂单探针 $1，信号 $2 bps')
      .replace(/BTC momentum (-?[0-9.]+) bps with ask ([0-9.]+)/g, 'BTC 动量 $1 bps，卖一 $2')
      .replace(/Bonereaper-style hedge (Up|Down) ask ([0-9.]+) combo ([0-9.]+)/g, 'Bonereaper 风格对冲 $1，卖一 $2，组合 $3')
      .replace(/BTC signal (-?[0-9.]+) bps below ([0-9.]+) bps threshold/g, 'BTC 信号 $1 bps，低于 $2 bps 阈值')
      .replace(/max entry orders ([0-9.]+) reached for this window/g, '本窗口已达到 $1 笔入场订单上限')
      .replace(/target paper order rows ([0-9.]+) reached for this window/g, '本窗口已达到目标模拟订单数 $1')
      .replace(/learned Bonereaper pressure on (Up|Down), still requiring paper edge/g, '学习到 Bonereaper 对 $1 的买入压力，但仍要求模拟盘优势')
      .replace(/settlement-hold mode: do not sell intrawindow; wait for final result like Bonereaper/g, '结算持有模式：窗口内不卖出，像 Bonereaper 一样等待最终结果')
      .replace(/scaled paper budget from Bonereaper live flow at ([0-9.]+)% of observed activity/g, '按 Bonereaper 实时成交流量的 $1% 缩放模拟预算')
      .replace(/using Bonereaper public trades as a live learning signal, with paper edge checks still required/g, '使用 Bonereaper 公开成交作为实时学习信号，同时保留模拟盘优势检查')
      .replace(/5m flow-carry mode: parent-confirmed entries, fresh Bonereaper flow, or opening flow carry with reduced size/g, '5m 流量延续模式：父级确认、新鲜 Bonereaper 流量，或开盘流量延续小仓试单')
      .replace(/ETH 5m tightened: stronger flow, parent, edge, depth and lower participation/g, 'ETH 5m 收紧：更强流量/父级/优势/深度，降低参与比例')
      .replace(/ETH 15m signal-quality filter: flow confirmation, edge, depth and lower participation/g, 'ETH 15m 信号质量过滤：流量确认、优势、深度、降低参与比例')
      .replace(new RegExp('5m parent/flow confirm filter preferred (Up|Down|-) parent (Up|Down|-) strong (true|false); ', 'g'), '5m 父级/流量确认过滤：本地偏向 $1，父级 $2，强趋势 $3；')
      .replace(/Bonereaper 5m (fresh|opening-carry) flow (Up|Down) dominance ([0-9.]+)% rows ([0-9.]+) usdc ([0-9.]+) age ([0-9.]+)s/g, 'Bonereaper 5m $1 流量 $2，占比 $3%，$4 笔，$5U，最近 $6 秒')
      .replace(/flow not confirmed (Up|Down|-) dominance ([0-9.]+)% rows ([0-9.]+) usdc ([0-9.]+) age ([0-9.]+)s elapsed ([0-9.]+)s parent (Up|Down|-)/g, '流量未确认：$1 占比 $2%，$3 笔，$4U，最近 $5 秒，窗口已过 $6 秒，父级 $7')
      .replace(/child ([0-9]+)\\/([0-9]+)/g, '子订单 $1/$2')
      .replace(/bilateral inventory balance (Up|Down) vs (Up|Down)/g, '双边库存再平衡：补 $1，对比 $2')
      .replace(/adverse selection guard rate ([0-9.]+)% avg (-?[0-9.]+) bps/g, '逆向选择保护：不利成交率 $1%，均值 $2 bps')
      .replace(/signal flipped to (Up|Down) at (-?[0-9.]+) bps/g, '信号反转为 $1，幅度 $2 bps')
      .replace(/take profit at (-?[0-9.]+)%/g, '止盈，浮盈 $1%')
      .replace(/stop loss after signal flip at (-?[0-9.]+)%/g, '信号反转后止损，浮动 $1%')
      .replace(/rare settlement-hold profit lock at bid ([0-9.]+)/g, '结算持有模式下少量锁定利润，买一 $1')
      .replace(/late settlement-hold profit protect with ([0-9.]+)s left/g, '临近结束保护利润，剩余 $1 秒')
      .replace(/late window profit protect with ([0-9.]+)s left/g, '临近结束保护利润，剩余 $1 秒')
      .replace('paper exit at current bid', '按当前买一模拟卖出')
      .replace(/combo ask ([0-9.]+) below ([0-9.]+)/g, '双边组合卖一 $1 低于阈值 $2')
      .replace(/cheap hedge ask ([0-9.]+)/g, '便宜对冲卖一 $1')
      .replace(/released stale maker orders for marketable paper entry/g, '为可成交入场释放旧挂单')
      .replace(/removed pre-min-fill paper artifact below ([0-9.]+) USDC/g, '移除低于 $1 USDC 的历史模拟成交残留')
      .replace('marketable limit at current ask', '限价单可按当前卖一成交')
      .replace('limit crossed current ask', '限价穿过当前卖一')
      .replace('current ask', '当前卖一')
      .replace('no edge or cheap hedge candidate', '没有足够优势或便宜对冲机会')
      .replace('no entry candidate at current ask', '当前卖一没有合适入场候选')
      .replace('outside clone entry band', '不在克隆入场时间段')
      .replace('paper budget reached', '模拟预算已用完')
      .replace('market is not live', '市场未处于可交易状态')
      .replace('lowered minEdge because observed buys are being missed', '因漏掉观察买单，降低 minEdge')
      .replace('raised minEdge because clone is over-trading', '因模拟交易过多，提高 minEdge')
      .replace('moved entry earlier because clone fills are late', '因模拟成交偏晚，提前入场')
      .replace('moved entry later because clone fills are early', '因模拟成交偏早，延后入场')
      .replace('reduced order size after recent losing windows', '因近期窗口亏损，降低单笔金额')
      .replace('tightened drawdown mode without pausing paper trading', '进入回撤收紧模式，但不暂停模拟交易')
      .replace('disabled cheap counter-trend hedge', '已禁用便宜反向对冲')
      .replace('kept tiny caps until rolling backtest turns positive', '历史回放未转正，保持极小仓位上限')
      .replace('rolling backtest positive; modestly increased caps', '历史回放转正，适度放大仓位上限')
      .replace('expired because small window budget cap was reached', '因小额单窗口预算上限取消')
      .replace(/\\bUp\\b/g, '上涨')
      .replace(/\\bDown\\b/g, '下跌')
      .replace(/\\bmaker\\b/g, '挂单')
      .replace(/\\bmarketable\\b/g, '可成交');
    let last = null;
    let chartHitBoxes = [];
    let totalChartHitBoxes = [];
    const signedFmt = (n, d=2) => {
      const value = Number(n);
      if (!Number.isFinite(value)) return '-';
      return (value > 0 ? '+' : '') + fmt(value, d);
    };
    async function load() {
      try {
        const res = await fetch('./dashboard-state.json?ts=' + Date.now(), { cache: 'no-store' });
        last = await res.json();
        render();
      } catch (e) {
        els.status.textContent = '离线';
        els.status.className = 'bad';
        els.meta.textContent = e.message;
      }
    }
    function render() {
      const s = last.summary || {};
      const c = last.clone || {};
      const cum = last.cloneCumulative || {};
      const vcum = last.cloneVersionCumulative || {};
      const version = last.cloneVersion || {};
      const hourly = last.hourlyPerformance?.lastCompletedHour || {};
      const ob = c.orderbook || {};
      const btc = c.btc || {};
      const cal = c.calibration || {};
      const risk = c.risk || {};
      const adaptive = c.adaptive || {};
      const learner = c.learner || {};
      const portfolio = last.clonePortfolio || {};
      const portfolioCum = last.clonePortfolioCumulative || {};
      const assets = portfolio.assets || {};
      const summaries = portfolio.assetSummaries || [];
      const legSummary = key => summaries.find(row => row.legKey === key) || {};
      const btc5 = assets.BTC5m || c || {};
      const btc15 = assets.BTC15m || {};
      const eth5 = assets.ETH5m || {};
      const eth15 = assets.ETH15m || {};
      const btc15Summary = legSummary('BTC15m');
      const eth5Summary = legSummary('ETH5m');
      const eth15Summary = legSummary('ETH15m');
      els.status.textContent = statusText(last.status);
      els.status.className = last.status === 'ok' ? 'ok' : last.status === 'error' ? 'bad' : 'warn';
      els.buyRows.textContent = s.buyRows ?? 0;
      els.buyUsdc.textContent = fmt(s.buyUsdc);
      els.redeemUsdc.textContent = fmt(s.redeemUsdc);
      els.pnl.textContent = fmt(s.realizedPnl);
      els.pnl.className = Number(s.realizedPnl) >= 0 ? 'ok' : 'bad';
      els.openWindows.textContent = s.openWindows ?? 0;
      els.cloneStatus.textContent = statusText(c.status);
      els.cloneStatus.className = c.status === 'ok' || c.status === 'placed' ? 'ok' : c.status === 'error' ? 'bad' : 'warn';
      els.btcPrice.textContent = btc.price == null ? '-' : fmt(btc.price) + ' / ' + esc(btc.priceSource || btc.source || '-');
      els.btcDelta.textContent = btc.deltaBps == null ? '-' : fmt(btc.deltaBps, 2);
      els.btcDelta.className = Number(btc.deltaBps) >= 0 ? 'ok' : 'bad';
      els.btcUpdated.textContent = btc.updatedAt ? new Date(btc.updatedAt).toLocaleTimeString() : '-';
      els.btcSamples.textContent = (btc.samples || []).slice(-3).map(row => fmt(row.price, 2)).join(' / ') || '-';
      els.asks.textContent = (ob.Up?.ask == null || ob.Down?.ask == null) ? '-' : fmt(ob.Up.ask, 3) + ' / ' + fmt(ob.Down.ask, 3);
      els.comboAsk.textContent = ob.comboAsk == null ? '-' : fmt(ob.comboAsk, 3);
      els.comboAsk.className = Number(ob.comboAsk) <= 0.985 ? 'ok' : 'warn';
      const clonePnl = c.pnl?.settled ? c.pnl.realized : c.pnl?.unrealized;
      els.clonePnl.textContent = fmt(clonePnl);
      els.clonePnl.className = Number(clonePnl) >= 0 ? 'ok' : 'bad';
      els.versionCumulativePnl.textContent = fmt(vcum.totalPnlIncludingOpen);
      els.versionCumulativePnl.className = Number(vcum.totalPnlIncludingOpen) >= 0 ? 'ok' : 'bad';
      els.versionFinalizedPnl.textContent = fmt(vcum.finalizedPnl);
      els.versionFinalizedPnl.className = Number(vcum.finalizedPnl) >= 0 ? 'ok' : 'bad';
      els.versionWindows.textContent = (vcum.finalizedWindows ?? 0) + ' / 当前 ' + fmt(vcum.currentPnl ?? 0);
      els.cumulativePnl.textContent = fmt(cum.totalPnlIncludingOpen);
      els.cumulativePnl.className = Number(cum.totalPnlIncludingOpen) >= 0 ? 'ok' : 'bad';
      els.finalizedPnl.textContent = fmt(cum.finalizedPnl);
      els.finalizedPnl.className = Number(cum.finalizedPnl) >= 0 ? 'ok' : 'bad';
      els.portfolioCurrentPnl.textContent = fmt(portfolio.currentPnl);
      els.portfolioCurrentPnl.className = Number(portfolio.currentPnl) >= 0 ? 'ok' : 'bad';
      els.portfolioCumulativePnl.textContent = fmt(portfolioCum.totalPnlIncludingOpen) + 'U / ' + (portfolioCum.returnPct == null ? '-' : fmt(portfolioCum.returnPct, 2) + '%');
      els.portfolioCumulativePnl.className = Number(portfolioCum.totalPnlIncludingOpen) >= 0 ? 'ok' : 'bad';
      const paperHour = hourly.paper || {};
      const boneHour = hourly.bonereaper || {};
      els.hourlyPaperReturn.textContent = paperHour.returnPct == null ? '-' : fmt(paperHour.returnPct, 2) + '% / ' + fmt(paperHour.pnl) + 'U';
      els.hourlyPaperReturn.className = Number(paperHour.returnPct) >= 0 ? 'ok' : 'bad';
      els.hourlyBonereaperReturn.textContent = boneHour.returnPct == null ? '-' : fmt(boneHour.returnPct, 2) + '% / ' + fmt(boneHour.pnl) + 'U';
      els.hourlyBonereaperReturn.className = Number(boneHour.returnPct) >= 0 ? 'ok' : 'bad';
      const rolling = last.hourlyPerformance?.rollingHour || {};
      const rolling24h = last.hourlyPerformance?.rolling24h || {};
      const rollingPaper = rolling.paper || {};
      const rollingBone = rolling.bonereaper || {};
      const rolling24Paper = rolling24h.paper || {};
      els.portfolioRollingHour.textContent = fmt(rollingPaper.cost) + 'U / ' + fmt(rollingPaper.pnl) + 'U / ' + (rollingPaper.returnPct == null ? '-' : fmt(rollingPaper.returnPct, 2) + '%');
      els.portfolioRollingHour.className = Number(rollingPaper.pnl) >= 0 ? 'ok' : 'bad';
      els.portfolioRolling24h.textContent = fmt(rolling24Paper.cost) + 'U / ' + fmt(rolling24Paper.pnl) + 'U / ' + (rolling24Paper.returnPct == null ? '-' : fmt(rolling24Paper.returnPct, 2) + '%');
      els.portfolioRolling24h.className = Number(rolling24Paper.pnl) >= 0 ? 'ok' : 'bad';
      const legStatus = (leg, summary) => leg.status || summary.status || '-';
      const legFills = (leg, summary) => (leg.fills || []).length || summary.fills || 0;
      els.btc15Status.textContent = statusText(legStatus(btc15, btc15Summary));
      els.btc15Status.className = legStatus(btc15, btc15Summary) === 'error' ? 'bad' : legStatus(btc15, btc15Summary) === '-' ? 'warn' : 'ok';
      els.btc15Fills.textContent = legFills(btc15, btc15Summary);
      els.eth5Status.textContent = statusText(legStatus(eth5, eth5Summary));
      els.eth5Status.className = legStatus(eth5, eth5Summary) === 'error' ? 'bad' : legStatus(eth5, eth5Summary) === '-' ? 'warn' : 'ok';
      els.eth5Fills.textContent = legFills(eth5, eth5Summary);
      els.eth15Status.textContent = statusText(legStatus(eth15, eth15Summary));
      els.eth15Status.className = legStatus(eth15, eth15Summary) === 'error' ? 'bad' : legStatus(eth15, eth15Summary) === '-' ? 'warn' : 'ok';
      els.eth15Fills.textContent = legFills(eth15, eth15Summary);
      const trendRows = [btc5, eth5].map(leg => {
        const trend = leg.parentTrend || {};
        if (!trend.parentKey) return '';
        const blockedOutcome = trend.blockedOutcome || trend.blocked || '';
        const preferredOutcome = trend.preferredOutcome || trend.preferred || '';
        const blocked = blockedOutcome ? '阻断' + dirText(blockedOutcome) : '不过滤';
        return trend.parentKey + ':' + dirText(preferredOutcome || '-') + '/' + blocked;
      }).filter(Boolean);
      els.parentTrend.textContent = trendRows.join(' | ') || '-';
      els.parentTrend.className = trendRows.some(row => row.includes('阻断')) ? 'warn' : 'ok';
      const budgetRows = [
        ['BTC5m', btc5],
        ['BTC15m', btc15],
        ['ETH5m', eth5],
        ['ETH15m', eth15],
      ].map(([key, leg]) => key + ' ' + fmt(leg.config?.budgetUsdc ?? leg.baseConfig?.budgetUsdc ?? 0, 0) + 'U');
      els.legBudgetMix.textContent = budgetRows.join(' | ');
      const adverse = c.adverseSelection || {};
      els.adverseSelection.textContent = adverse.checked ? fmt((adverse.rate || 0) * 100, 1) + '% / ' + fmt(adverse.avgBps, 0) + 'bps' : '-';
      els.adverseSelection.className = Number(adverse.rate) >= 0.45 ? 'bad' : Number(adverse.rate) >= 0.25 ? 'warn' : 'ok';
      els.rollingPaper.textContent = fmt(rollingPaper.cost) + 'U / ' + fmt(rollingPaper.pnl) + 'U';
      els.rollingPaper.className = Number(rollingPaper.pnl) >= 0 ? 'ok' : 'bad';
      els.rollingBonereaper.textContent = fmt(rollingBone.confirmedCost) + 'U + 待结 ' + fmt(rollingBone.pendingCost) + 'U';
      els.rollingBonereaper.className = Number(rollingBone.pnl) >= 0 ? 'ok' : 'bad';
      els.riskGuard.textContent = risk.reason ? '仅提示' : '运行中';
      els.riskGuard.className = risk.reason ? 'warn' : 'ok';
      els.openSample.textContent = btc.openPrice == null ? '-' : fmt(btc.openPrice) + ' / ' + esc(btc.openPriceSource || '-');
      els.cloneFills.textContent = (c.fills || []).length;
      els.calibration.textContent = cal.observedBuyRows ? (cal.matchedRows + '/' + cal.observedBuyRows) : '-';
      const ac = adaptive.effectiveConfig || c.config || {};
      els.learnerStatus.textContent = (learner.currentObservedBuys ?? 0) + '笔 / 偏向 ' + dirText(learner.preferredOutcome || '-') + ' / 近30秒 ' + (learner.recentBuyRows30s ?? 0);
      els.versionInfo.textContent = (version.startedAt ? new Date(version.startedAt).toLocaleTimeString() : '已归零') + ' 起';
      els.minTradeRule.textContent = '成交>= ' + esc(ac.minFillUsdc ?? 1) + 'U / 深度>= ' + esc(ac.minVisibleDepthUsdc ?? 1) + 'U / maker击穿 ' + esc(ac.makerPenetrationTicks ?? 1) + ' tick';
      els.executionLatency.textContent = esc(ac.executionLatencyMs ?? 600) + 'ms / 快照后才允许成交';
      els.adaptiveParams.textContent = '预算 ' + esc(ac.budgetUsdc ?? '-') + ' / 目标笔数 ' + esc(ac.targetOrderRows ?? '-') + ' / 探针 ' + esc(ac.probeOrderUsdc ?? '-') + ' / 单笔 ' + esc(ac.orderUsdc ?? '-') + ' / 最大 ' + esc(ac.maxClipUsdc ?? '-') + ' / 吃单费 ' + esc(ac.takerFeeRate ?? '-') + ' / 参与深度 ' + esc(ac.liquidityParticipation ?? '-') + ' / 退出 ' + esc(ac.exitEnabled ? '开' : '关') + ' / 反向 ' + esc(ac.hedgeEnabled ? '开' : '关');
      els.cloneUnsettledWindows.textContent = cum.unsettledWindows ?? ((last.cloneHistory || []).filter(row => !row.settled).length);
      els.finalizedWindows.textContent = cum.finalizedWindows ?? 0;
      const wr = last.winrateComparison || {};
      const ourWr = wr.our || {};
      const boneWr = wr.bonereaper || {};
      const pctText = value => value == null ? '-' : fmt(value, 2) + '%';
      els.ourWinRate.textContent = pctText(ourWr.winRate) + ' / ' + esc(ourWr.wins ?? 0) + '/' + esc(ourWr.settled ?? 0);
      els.ourWinRate.className = Number(ourWr.winRate) >= 50 ? 'ok' : Number(ourWr.winRate) >= 45 ? 'warn' : 'bad';
      els.bonereaperWinRate.textContent = pctText(boneWr.winRate) + ' / ' + esc(boneWr.wins ?? 0) + '/' + esc(boneWr.settled ?? 0);
      els.bonereaperWinRate.className = Number(boneWr.winRate) >= 50 ? 'ok' : Number(boneWr.winRate) >= 45 ? 'warn' : 'bad';
      els.ourDirectionRate.textContent = pctText(ourWr.directionHitRate);
      els.ourDirectionRate.className = Number(ourWr.directionHitRate) >= Number(boneWr.directionHitRate || 0) ? 'ok' : 'warn';
      els.bonereaperDirectionRate.textContent = pctText(boneWr.directionHitRate);
      els.bonereaperDirectionRate.className = Number(boneWr.directionHitRate) >= 50 ? 'ok' : 'warn';
      els.winrateMeta.textContent = wr.period ? ('区间 ' + new Date(wr.period.startIso).toLocaleString() + ' - ' + new Date(wr.period.endIso).toLocaleString() + ' | 缓存公开成交 ' + esc(wr.cacheRows ?? 0) + ' 行 | ' + esc(wr.source || '')) : '等待下一轮统计';
      els.winrateRows.innerHTML = CHART_LEGS.map(leg => {
        const ours = ourWr.byLeg?.[leg.key] || {};
        const bone = boneWr.byLeg?.[leg.key] || {};
        const ourReturnCls = Number(ours.returnPct) >= 0 ? 'ok' : 'bad';
        const boneReturnCls = Number(bone.returnPct) >= 0 ? 'ok' : 'bad';
        return '<tr><td>'+esc(leg.label)+'</td>'
          + '<td class="num">'+esc(ours.windows ?? 0)+'</td>'
          + '<td class="num">'+pctText(ours.winRate)+'</td>'
          + '<td class="num">'+pctText(ours.directionHitRate)+'</td>'
          + '<td class="num '+ourReturnCls+'">'+pctText(ours.returnPct)+'</td>'
          + '<td class="num">'+esc(bone.windows ?? 0)+'</td>'
          + '<td class="num">'+pctText(bone.winRate)+'</td>'
          + '<td class="num">'+pctText(bone.directionHitRate)+'</td>'
          + '<td class="num '+boneReturnCls+'">'+pctText(bone.returnPct)+'</td></tr>';
      }).join('');
      const eventLine = last.slug ? '<br>市场：<code>' + esc(last.slug) + '</code>' : '';
      const linkLine = last.eventUrl ? '<br><a href="' + esc(last.eventUrl) + '" target="_blank" rel="noreferrer">打开 Polymarket 市场</a>' : '';
      els.meta.innerHTML = '更新时间：' + esc(last.updatedAt || '-') + '<br>钱包：<code>' + esc(last.wallet) + '</code>' + eventLine + linkLine + '<br>' + esc(reasonText(last.lastError || c.lastError || risk.reason || ''));
      const d = c.lastDecision || {};
      els.decision.innerHTML = '决策：<code>' + esc(statusText(d.status)) + '</code> ' + esc(reasonText(d.reason || '')) + ' | 上涨公允价=' + esc(d.fairUp ?? '-') + ' | 偏向=' + esc(dirText(d.preferred || '')) + ' | 盘口源=' + esc(ob.source || '-') + ' | BTC源=' + esc(btc.priceSource || btc.source || '-') + ' | 自适应=' + esc((adaptive.suggestions || []).join('; '));
      drawPnlChart();
      drawTotalPnlChart();
      const q = els.filter.value.trim().toLowerCase();
      const rows = (last.trades || []).filter(row => !q || JSON.stringify(row).toLowerCase().includes(q));
      els.rows.innerHTML = rows.map(row => {
        const pnl = row.pnl == null ? '' : fmt(row.pnl);
        const pnlCls = Number(row.pnl) >= 0 ? 'ok' : 'bad';
        const tx = row.tx ? '<code>' + esc(row.tx.slice(0,10) + '...' + row.tx.slice(-6)) + '</code>' : '';
        return '<tr><td>'+esc(row.isoTime)+'</td><td>'+esc(actionText(row.action))+'</td><td><code>'+esc(row.slug)+'</code></td><td>'+esc(dirText(row.direction))+'</td><td class="num">'+fmt(row.price,4)+'</td><td class="num">'+fmt(row.amountUsdc)+'</td><td class="num">'+fmt(row.shares)+'</td><td class="num '+pnlCls+'">'+pnl+'</td><td>'+esc(reasonText(row.reason))+'</td><td>'+tx+'</td></tr>';
      }).join('');
      const fills = (c.fills || []).filter(row => !q || JSON.stringify(row).toLowerCase().includes(q));
      els.cloneFillRows.innerHTML = fills.map(row => '<tr><td>'+esc(row.isoTime)+'</td><td>'+esc(actionText(row.action))+'</td><td>'+esc(dirText(row.direction))+'</td><td>'+esc(styleText(row.style))+'</td><td class="num">'+fmt(row.price,4)+'</td><td class="num">'+fmt(row.amountUsdc)+'</td><td class="num">'+fmt(row.shares)+'</td><td>'+esc(reasonText(row.reason))+'<br><span class="muted">'+esc(reasonText(row.fillReason || ''))+' '+esc(row.fillRatio == null ? '' : '成交比例 '+row.fillRatio)+'</span></td></tr>').join('');
      const orders = (c.orders || []).filter(row => !q || JSON.stringify(row).toLowerCase().includes(q));
      els.cloneOrderRows.innerHTML = orders.map(row => '<tr><td>'+esc(row.isoTime)+'</td><td>'+esc(statusText(row.status))+'</td><td>'+esc(dirText(row.direction))+'</td><td>'+esc(styleText(row.style))+'</td><td class="num">'+fmt(row.limitPrice,4)+'</td><td class="num">'+fmt(row.remainingShares ?? row.shares)+'</td><td>'+esc(reasonText(row.reason))+'</td></tr>').join('');
      const history = (last.cloneHistory || []).filter(row => !q || JSON.stringify(row).toLowerCase().includes(q));
      els.cloneHistoryRows.innerHTML = history.map(row => {
        const matched = row.calibration ? row.calibration.matchedRows + '/' + row.calibration.observedBuyRows : '-';
        const pnlCls = Number(row.pnl) >= 0 ? 'ok' : 'bad';
        const settlement = row.settlementSource || row.archiveReason || '';
        const statusCell = esc(row.settled ? '已结算' : statusText(row.status)) + (row.noTradeReason ? '<br><span class="muted">'+esc(reasonText(row.noTradeReason))+'</span>' : '');
        return '<tr><td><code>'+esc(row.slug)+'</code></td><td>'+statusCell+'</td><td>'+esc(dirText(row.winner || '-'))+'</td><td>'+esc(settlementText(settlement))+'</td><td class="num">'+fmt(row.cost)+'</td><td class="num '+pnlCls+'">'+fmt(row.pnl)+'</td><td class="num">'+esc(row.fillCount ?? 0)+'</td><td class="num">'+esc(matched)+'</td><td>'+esc(row.archivedAt)+'</td></tr>';
      }).join('');
    }
    function windowLabel(row) {
      const start = Number(row.windowStart || String(row.slug || '').match(/(\\d+)$/)?.[1]);
      if (!Number.isFinite(start)) return String(row.slug || '').replace(/^(btc|eth)-updown-(5m|15m)-/i, '');
      return new Date(start * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    function chartPoints(limit = 160) {
      const versionId = last.cloneVersion?.id || '';
      const history = [...(last.cloneHistory || [])]
        .filter(row => row && row.slug)
        .filter(row => !versionId || row.strategyVersionId === versionId)
        .reverse();
      const points = history.map(row => ({
        slug: row.slug,
        legKey: row.legKey || legKeyFromSlug(row.slug),
        label: chartLegLabel(row.legKey || legKeyFromSlug(row.slug)) + ' ' + windowLabel(row),
        pnl: Number(row.pnl) || 0,
        cost: Number(row.cost) || 0,
        fillCount: Number(row.fillCount) || 0,
        winner: row.winner || '',
        settlementSource: row.settlementSource || row.archiveReason || '',
        noTradeReason: row.noTradeReason || '',
        settled: Boolean(row.settled),
        current: false
      }));
      const currentClones = Object.values(last.clonePortfolio?.assets || {}).length ? Object.values(last.clonePortfolio.assets || {}) : [last.clone || {}];
      for (const c of currentClones) {
        const currentSlug = c.market?.slug || '';
        const currentPnl = c.pnl?.settled ? Number(c.pnl.realized) : Number(c.pnl?.unrealized);
        const currentCost = Number(c.pnl?.cost ?? 0);
        const currentMatchesVersion = !versionId || c.strategyVersionId === versionId;
        if (!currentMatchesVersion || !currentSlug || points.some(row => row.slug === currentSlug) || !(currentCost > 0 || Number.isFinite(currentPnl))) continue;
        points.push({
          slug: currentSlug,
          legKey: c.legKey || legKeyFromSlug(currentSlug),
          label: chartLegLabel(c.legKey || legKeyFromSlug(currentSlug)) + ' 当前',
          pnl: Number.isFinite(currentPnl) ? currentPnl : 0,
          cost: currentCost,
          fillCount: (c.fills || []).length,
          winner: '',
          settlementSource: '',
          noTradeReason: '',
          settled: false,
          current: true
        });
      }
      const runningByLeg = {};
      for (const point of points) {
        const legKey = point.legKey || legKeyFromSlug(point.slug);
        runningByLeg[legKey] = (runningByLeg[legKey] || 0) + point.pnl;
        point.cumulative = runningByLeg[legKey];
      }
      return limit ? points.slice(-limit) : points;
    }
    function drawPnlChart() {
      const canvas = els.pnlChart;
      if (!canvas) return;
      const points = chartPoints();
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(360, Math.floor(rect.width || 900));
      const height = 620;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      canvas.style.height = height + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#0b0f14';
      ctx.fillRect(0, 0, width, height);
      const pad = { left: 62, right: 66, top: 18, bottom: 26 };
      const plotW = width - pad.left - pad.right;
      ctx.font = '12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      ctx.lineWidth = 1;
      if (!points.length) {
        chartHitBoxes = [];
        hidePnlTooltip();
        ctx.fillStyle = '#8b949e';
        ctx.fillText('暂无模拟窗口数据', pad.left, pad.top + 24);
        els.pnlChartMeta.textContent = '新规则版本已从 0 开始，等待四盘口模拟成交。';
        return;
      }
      chartHitBoxes = [];
      const panelGap = 14;
      const panelH = Math.floor((height - pad.top - pad.bottom - panelGap * 3) / 4);
      const groups = CHART_LEGS.map((leg, legIndex) => ({
        ...leg,
        top: pad.top + legIndex * (panelH + panelGap),
        points: points.filter(point => (point.legKey || legKeyFromSlug(point.slug)) === leg.key).slice(-42)
      }));
      groups.forEach(group => {
        const top = group.top;
        const bottom = top + panelH;
        const innerTop = top + 20;
        const innerBottom = bottom - 18;
        const plotH = Math.max(30, innerBottom - innerTop);
        const legPoints = group.points;
        ctx.strokeStyle = '#24313d';
        ctx.strokeRect(pad.left, top, plotW, panelH);
        ctx.fillStyle = group.color;
        ctx.font = '12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        const legPnl = legPoints.reduce((total, row) => total + row.pnl, 0);
        const legCost = legPoints.reduce((total, row) => total + row.cost, 0);
        const latest = legPoints[legPoints.length - 1];
        ctx.fillText(group.label + ' | ' + legPoints.length + '窗 | 成本 ' + fmt(legCost, 0) + 'U | 图上PnL ' + signedFmt(legPnl), pad.left + 8, top + 14);
        if (!legPoints.length) {
          ctx.fillStyle = '#8b949e';
          ctx.fillText('暂无该盘口模拟窗口', pad.left + 12, innerTop + 24);
          return;
        }
        const pnlMax = Math.max(1, ...legPoints.map(row => Math.abs(row.pnl))) * 1.16;
        const cumVals = legPoints.map(row => row.cumulative);
        let cumMin = Math.min(...cumVals);
        let cumMax = Math.max(...cumVals);
        if (cumMin === cumMax) {
          cumMin -= 1;
          cumMax += 1;
        }
        const yPnl = value => innerTop + (pnlMax - value) / (pnlMax * 2) * plotH;
        const yCum = value => innerTop + (cumMax - value) / (cumMax - cumMin) * plotH;
        const xAt = idx => pad.left + (legPoints.length === 1 ? plotW / 2 : idx / (legPoints.length - 1) * plotW);
        const zeroY = yPnl(0);
        ctx.strokeStyle = '#24313d';
        for (let i = 0; i <= 2; i += 1) {
          const y = innerTop + (plotH / 2) * i;
          ctx.beginPath();
          ctx.moveTo(pad.left, y);
          ctx.lineTo(width - pad.right, y);
          ctx.stroke();
        }
        ctx.strokeStyle = '#8b949e';
        ctx.beginPath();
        ctx.moveTo(pad.left, zeroY);
        ctx.lineTo(width - pad.right, zeroY);
        ctx.stroke();
        ctx.fillStyle = '#8b949e';
        ctx.textAlign = 'right';
        ctx.fillText('+' + fmt(pnlMax, 0), pad.left - 8, yPnl(pnlMax) + 4);
        ctx.fillText('0', pad.left - 8, zeroY + 4);
        ctx.fillText('-' + fmt(pnlMax, 0), pad.left - 8, yPnl(-pnlMax) + 4);
        ctx.fillStyle = group.color;
        ctx.fillText(fmt(cumMax, 0), width - 8, yCum(cumMax) + 4);
        ctx.fillText(fmt(cumMin, 0), width - 8, yCum(cumMin) + 4);
        ctx.textAlign = 'left';
        const gap = Math.max(2, plotW / Math.max(legPoints.length, 1) * 0.28);
        const barW = Math.max(3, Math.min(18, plotW / Math.max(legPoints.length, 1) - gap));
        legPoints.forEach((point, idx) => {
          const x = xAt(idx) - barW / 2;
          const y = yPnl(Math.max(point.pnl, 0));
          const h = Math.max(1, Math.abs(yPnl(point.pnl) - zeroY));
          const hitPad = Math.max(8, barW * 0.5);
          chartHitBoxes.push({
            x0: xAt(idx) - barW / 2 - hitPad,
            x1: xAt(idx) + barW / 2 + hitPad,
            y0: top,
            y1: bottom,
            point
          });
          ctx.fillStyle = point.pnl >= 0 ? 'rgba(63,185,80,0.78)' : 'rgba(248,81,73,0.78)';
          ctx.fillRect(x, point.pnl >= 0 ? y : zeroY, barW, h);
          if (point.current) {
            ctx.strokeStyle = '#d29922';
            ctx.strokeRect(x - 1, (point.pnl >= 0 ? y : zeroY) - 1, barW + 2, h + 2);
          }
        });
        ctx.strokeStyle = group.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        legPoints.forEach((point, idx) => {
          const x = xAt(idx);
          const y = yCum(point.cumulative);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.lineWidth = 1;
        legPoints.forEach((point, idx) => {
          const x = xAt(idx);
          const y = yCum(point.cumulative);
          ctx.fillStyle = point.current ? '#d29922' : group.color;
          ctx.beginPath();
          ctx.arc(x, y, point.current ? 3.5 : 2.3, 0, Math.PI * 2);
          ctx.fill();
        });
        const labelEvery = Math.max(1, Math.ceil(legPoints.length / 6));
        ctx.fillStyle = '#8b949e';
        ctx.textAlign = 'center';
        legPoints.forEach((point, idx) => {
          if (idx % labelEvery !== 0 && idx !== legPoints.length - 1) return;
          ctx.fillText(windowLabel(point), xAt(idx), bottom - 4);
        });
        ctx.textAlign = 'left';
      });
      const lastPoint = points[points.length - 1];
      const best = points.reduce((max, row) => row.pnl > max.pnl ? row : max, points[0]);
      const worst = points.reduce((min, row) => row.pnl < min.pnl ? row : min, points[0]);
      const rh = last.hourlyPerformance?.rollingHour?.paper || {};
      const r24 = last.hourlyPerformance?.rolling24h?.paper || {};
      const legSummary = groups.map(group => group.label + ':' + signedFmt(group.points.reduce((total, row) => total + row.pnl, 0))).join(' | ');
      els.pnlChartMeta.textContent = '四盘口分图 | 最新 ' + chartLegLabel(lastPoint.legKey) + ' ' + fmt(lastPoint.pnl) + ' USDC | 最好 ' + chartLegLabel(best.legKey) + ' ' + fmt(best.pnl) + ' | 最差 ' + chartLegLabel(worst.legKey) + ' ' + fmt(worst.pnl) + ' | ' + legSummary + ' | 滚动1小时 ' + fmt(rh.pnl) + 'U / 滚动24小时 ' + fmt(r24.pnl) + 'U';
    }
    function totalCurvePoints() {
      const points = chartPoints(1000);
      let running = 0;
      return points.map((point, idx) => {
        running += Number(point.pnl) || 0;
        return { ...point, totalCumulative: running, totalIndex: idx };
      });
    }
    function drawTotalPnlChart() {
      const canvas = els.totalPnlChart;
      if (!canvas) return;
      const points = totalCurvePoints();
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(360, Math.floor(rect.width || 900));
      const height = 380;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      canvas.style.height = height + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#0b0f14';
      ctx.fillRect(0, 0, width, height);
      const pad = { left: 70, right: 28, top: 22, bottom: 42 };
      const plotW = width - pad.left - pad.right;
      const plotH = height - pad.top - pad.bottom;
      ctx.font = '12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      if (!points.length) {
        totalChartHitBoxes = [];
        hideTotalPnlTooltip();
        ctx.fillStyle = '#8b949e';
        ctx.fillText('暂无总收益曲线数据', pad.left, pad.top + 24);
        if (els.totalPnlChartMeta) els.totalPnlChartMeta.textContent = '等待新规则窗口归档或当前持仓生成。';
        return;
      }
      let yMin = Math.min(0, ...points.map(row => row.totalCumulative));
      let yMax = Math.max(0, ...points.map(row => row.totalCumulative));
      if (yMin === yMax) {
        yMin -= 1;
        yMax += 1;
      }
      const yMargin = Math.max(1, (yMax - yMin) * 0.08);
      yMin -= yMargin;
      yMax += yMargin;
      const xAt = idx => pad.left + (points.length === 1 ? plotW / 2 : idx / (points.length - 1) * plotW);
      const yAt = value => pad.top + (yMax - value) / (yMax - yMin) * plotH;
      const zeroY = yAt(0);
      ctx.strokeStyle = '#24313d';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const y = pad.top + (plotH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
        const value = yMax - (yMax - yMin) * (i / 4);
        ctx.fillStyle = '#8b949e';
        ctx.textAlign = 'right';
        ctx.fillText(signedFmt(value, 0), pad.left - 8, y + 4);
      }
      ctx.strokeStyle = '#8b949e';
      ctx.beginPath();
      ctx.moveTo(pad.left, zeroY);
      ctx.lineTo(width - pad.right, zeroY);
      ctx.stroke();
      const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
      gradient.addColorStop(0, 'rgba(121,192,255,0.22)');
      gradient.addColorStop(1, 'rgba(121,192,255,0.02)');
      ctx.beginPath();
      ctx.moveTo(xAt(0), zeroY);
      points.forEach((point, idx) => {
        ctx.lineTo(xAt(idx), yAt(point.totalCumulative));
      });
      ctx.lineTo(xAt(points.length - 1), zeroY);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.strokeStyle = '#79c0ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      points.forEach((point, idx) => {
        const x = xAt(idx);
        const y = yAt(point.totalCumulative);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.lineWidth = 1;
      totalChartHitBoxes = [];
      points.forEach((point, idx) => {
        const x = xAt(idx);
        const y = yAt(point.totalCumulative);
        totalChartHitBoxes.push({ x0: x - 10, x1: x + 10, y0: y - 10, y1: y + 10, x, y, point });
        ctx.fillStyle = point.pnl >= 0 ? '#3fb950' : '#f85149';
        ctx.beginPath();
        ctx.arc(x, y, point.current ? 4 : 2.8, 0, Math.PI * 2);
        ctx.fill();
        if (point.current) {
          ctx.strokeStyle = '#d29922';
          ctx.beginPath();
          ctx.arc(x, y, 5.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
      const labelEvery = Math.max(1, Math.ceil(points.length / 8));
      ctx.fillStyle = '#8b949e';
      ctx.textAlign = 'center';
      points.forEach((point, idx) => {
        if (idx % labelEvery !== 0 && idx !== points.length - 1) return;
        ctx.fillText(windowLabel(point), xAt(idx), height - 16);
      });
      ctx.textAlign = 'left';
      const lastPoint = points[points.length - 1];
      const highPoint = points.reduce((max, row) => row.totalCumulative > max.totalCumulative ? row : max, points[0]);
      const lowPoint = points.reduce((min, row) => row.totalCumulative < min.totalCumulative ? row : min, points[0]);
      const rh = last.hourlyPerformance?.rollingHour?.paper || {};
      const r24 = last.hourlyPerformance?.rolling24h?.paper || {};
      const totalBook = last.clonePortfolioCumulative?.totalPnlIncludingOpen ?? last.cloneVersionCumulative?.totalPnlIncludingOpen;
      if (els.totalPnlChartMeta) {
        els.totalPnlChartMeta.textContent = '图内窗口 ' + points.length + ' 个 | 最新累计 ' + signedFmt(lastPoint.totalCumulative) + ' USDC | 最高 ' + signedFmt(highPoint.totalCumulative) + ' | 最低 ' + signedFmt(lowPoint.totalCumulative) + ' | 总账累计 ' + signedFmt(totalBook) + 'U | 滚动1小时 ' + fmt(rh.pnl) + 'U / 滚动24小时 ' + fmt(r24.pnl) + 'U';
      }
    }
    function hidePnlTooltip() {
      if (els.pnlChartTip) els.pnlChartTip.style.display = 'none';
    }
    function showPnlTooltip(event) {
      const canvas = els.pnlChart;
      const tip = els.pnlChartTip;
      if (!canvas || !tip || !chartHitBoxes.length) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let hit = chartHitBoxes.find(box => x >= box.x0 && x <= box.x1 && y >= box.y0 - 8 && y <= box.y1 + 8);
      if (!hit && y >= 0 && y <= rect.height) {
        hit = chartHitBoxes
          .map(box => ({ box, dist: Math.min(Math.abs(x - box.x0), Math.abs(x - box.x1), Math.abs(x - (box.x0 + box.x1) / 2)) }))
          .filter(row => row.dist <= 12)
          .sort((a, b) => a.dist - b.dist)[0]?.box;
      }
      if (!hit) {
        hidePnlTooltip();
        return;
      }
      const point = hit.point;
      const pnlClass = point.pnl >= 0 ? 'ok' : 'bad';
      const pnlLabel = point.pnl >= 0 ? '盈利' : '亏损';
      const status = point.current ? '当前窗口' : point.settled ? '已结算' : '待结算';
      const winner = point.winner ? ' / 胜出 ' + dirText(point.winner) : '';
      tip.innerHTML =
        '<b>' + esc(point.label) + ' ' + esc(status) + esc(winner) + '</b>' +
        '<div class="tipSlug">' + esc(point.slug) + '</div>' +
        '<div class="tipRow"><span>单窗口' + pnlLabel + '</span><span class="tipValue ' + pnlClass + '">' + signedFmt(point.pnl) + ' USDC</span></div>' +
        '<div class="tipRow"><span>累计盈亏</span><span class="tipValue ' + (point.cumulative >= 0 ? 'ok' : 'bad') + '">' + signedFmt(point.cumulative) + ' USDC</span></div>' +
        '<div class="tipRow"><span>投入成本</span><span class="tipValue">' + fmt(point.cost) + ' USDC</span></div>' +
        '<div class="tipRow"><span>成交笔数</span><span class="tipValue">' + esc(point.fillCount) + '</span></div>' +
        '<div class="tipRow"><span>结算源</span><span class="tipValue">' + esc(settlementText(point.settlementSource)) + '</span></div>' +
        (point.noTradeReason ? '<div class="tipRow"><span>未入场原因</span><span class="tipValue">' + esc(reasonText(point.noTradeReason)) + '</span></div>' : '');
      tip.style.display = 'block';
      const panelRect = tip.parentElement.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      let left = event.clientX - panelRect.left + 14;
      let top = event.clientY - panelRect.top + 14;
      if (left + tipW + 8 > panelRect.width) left = event.clientX - panelRect.left - tipW - 14;
      if (top + tipH + 8 > panelRect.height) top = event.clientY - panelRect.top - tipH - 14;
      tip.style.left = Math.max(8, Math.min(left, panelRect.width - tipW - 8)) + 'px';
      tip.style.top = Math.max(8, Math.min(top, panelRect.height - tipH - 8)) + 'px';
    }
    function hideTotalPnlTooltip() {
      if (els.totalPnlChartTip) els.totalPnlChartTip.style.display = 'none';
    }
    function showTotalPnlTooltip(event) {
      const canvas = els.totalPnlChart;
      const tip = els.totalPnlChartTip;
      if (!canvas || !tip || !totalChartHitBoxes.length) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let hit = totalChartHitBoxes.find(box => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1);
      if (!hit && y >= 0 && y <= rect.height) {
        hit = totalChartHitBoxes
          .map(box => ({ box, dist: Math.hypot(x - box.x, y - box.y) }))
          .filter(row => row.dist <= 18)
          .sort((a, b) => a.dist - b.dist)[0]?.box;
      }
      if (!hit) {
        hideTotalPnlTooltip();
        return;
      }
      const point = hit.point;
      const pnlClass = point.pnl >= 0 ? 'ok' : 'bad';
      const cumulativeClass = point.totalCumulative >= 0 ? 'ok' : 'bad';
      const status = point.current ? '当前窗口' : point.settled ? '已结算' : '待结算';
      const winner = point.winner ? ' / 胜出 ' + dirText(point.winner) : '';
      tip.innerHTML =
        '<b>' + esc(point.label) + ' ' + esc(status) + esc(winner) + '</b>' +
        '<div class="tipSlug">' + esc(point.slug) + '</div>' +
        '<div class="tipRow"><span>总累计收益</span><span class="tipValue ' + cumulativeClass + '">' + signedFmt(point.totalCumulative) + ' USDC</span></div>' +
        '<div class="tipRow"><span>单窗口盈亏</span><span class="tipValue ' + pnlClass + '">' + signedFmt(point.pnl) + ' USDC</span></div>' +
        '<div class="tipRow"><span>投入成本</span><span class="tipValue">' + fmt(point.cost) + ' USDC</span></div>' +
        '<div class="tipRow"><span>成交笔数</span><span class="tipValue">' + esc(point.fillCount) + '</span></div>' +
        '<div class="tipRow"><span>盘口</span><span class="tipValue">' + esc(chartLegLabel(point.legKey)) + '</span></div>' +
        '<div class="tipRow"><span>结算源</span><span class="tipValue">' + esc(settlementText(point.settlementSource)) + '</span></div>' +
        (point.noTradeReason ? '<div class="tipRow"><span>未入场原因</span><span class="tipValue">' + esc(reasonText(point.noTradeReason)) + '</span></div>' : '');
      tip.style.display = 'block';
      const panelRect = tip.parentElement.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      let left = event.clientX - panelRect.left + 14;
      let top = event.clientY - panelRect.top + 14;
      if (left + tipW + 8 > panelRect.width) left = event.clientX - panelRect.left - tipW - 14;
      if (top + tipH + 8 > panelRect.height) top = event.clientY - panelRect.top - tipH - 14;
      tip.style.left = Math.max(8, Math.min(left, panelRect.width - tipW - 8)) + 'px';
      tip.style.top = Math.max(8, Math.min(top, panelRect.height - tipH - 8)) + 'px';
    }
    els.filter.addEventListener('input', render);
    if (els.pnlChart) {
      els.pnlChart.addEventListener('mousemove', showPnlTooltip);
      els.pnlChart.addEventListener('mouseleave', hidePnlTooltip);
    }
    if (els.totalPnlChart) {
      els.totalPnlChart.addEventListener('mousemove', showTotalPnlTooltip);
      els.totalPnlChart.addEventListener('mouseleave', hideTotalPnlTooltip);
    }
    window.addEventListener('resize', () => { if (last) { drawPnlChart(); drawTotalPnlChart(); } });
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`;
}

async function flush(state, opts, options = {}) {
  const writeFullState = options.writeFullState !== false;
  compactState(state, opts);
  recomputeSummary(state);
  recomputeCloneCumulative(state);
  recomputeHourlyPerformance(state);
  recomputeWinrateComparison(state);
  state.updatedAt = new Date().toISOString();
  await ensureDir(opts.out);
  if (writeFullState) {
    await writeJsonAtomic(join(opts.out, "state.json"), state);
    await writeJsonAtomic(join(opts.out, "trades.json"), state.trades);
    await writeJsonAtomic(join(opts.out, "windows.json"), Object.values(state.windows));
  }
  await writeJsonAtomic(join(opts.out, "dashboard-state.json"), dashboardState(state, opts));
  if (state.clone) {
    await writeJsonAtomic(join(opts.out, "clone.json"), state.clone);
    await writeJsonAtomic(join(opts.out, "clone-orders.json"), state.clone.orders || []);
    await writeJsonAtomic(join(opts.out, "clone-fills.json"), state.clone.fills || []);
    await writeJsonAtomic(join(opts.out, "clone-risk.json"), state.clone.risk || {});
    await writeJsonAtomic(join(opts.out, "clone-adaptive.json"), state.clone.adaptive || {});
  }
  if (writeFullState) {
    await writeJsonAtomic(join(opts.out, "clone-portfolio.json"), state.clonePortfolio || {});
  }
  await writeJsonAtomic(join(opts.out, "clone-portfolio-cumulative.json"), state.clonePortfolioCumulative || {});
  if (writeFullState) {
    await writeJsonAtomic(join(opts.out, "clone-history.json"), state.cloneHistory || []);
    await writeJsonAtomic(join(opts.out, "clone-ledger-reset.json"), state.cloneLedgerReset || {});
    await writeJsonAtomic(join(opts.out, "clone-version.json"), state.cloneVersion || {});
  }
  await writeJsonAtomic(join(opts.out, "clone-version-cumulative.json"), state.cloneVersionCumulative || emptyCloneVersionCumulative(state.cloneVersion));
  await writeJsonAtomic(join(opts.out, "hourly-performance.json"), state.hourlyPerformance || {});
  await writeJsonAtomic(join(opts.out, "winrate-comparison.json"), state.winrateComparison || {});
  if (writeFullState) {
    await writeJsonAtomic(join(opts.out, "clone-settlements.json"), (state.cloneHistory || [])
      .filter((row) => row.settled || row.oracleSettlement || row.gammaSettlement)
      .map((row) => ({
        slug: row.slug,
        settled: Boolean(row.settled),
        winner: row.winner || "",
        pnl: row.pnl,
        cost: row.cost,
        buyCost: row.buyCost,
        sellProceeds: row.sellProceeds,
        settledValue: row.settledValue,
        settlementSource: row.settlementSource || "",
        oracleSettlement: row.oracleSettlement || null,
        gammaSettlement: row.gammaSettlement || null,
        archivedAt: row.archivedAt,
      })));
  }
  await writeJsonAtomic(join(opts.out, "clone-cumulative.json"), state.cloneCumulative || emptyCloneCumulative());
  await writeTextAtomic(join(opts.out, "index.html"), renderDashboardHtml());
}

async function pollOnce(state, opts, startSec) {
  const batches = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const activityErrors = [];
  const activityOptions = opts.autoBtc5m ? { slugFilter: "" } : {};
  for (const type of ACTIVITY_TYPES) {
    try {
      batches.push(...(await fetchActivity(type, opts, startSec, activityOptions)));
    } catch (err) {
      activityErrors.push(`${type}: ${shortError(err)}`);
    }
  }
  state.activityLastError = activityErrors.join("; ");
  updateMarketClockFromActivity(state, opts, batches, nowSec);
  const marketNowSecValue = marketClockNowSec(state, nowSec);
  const currentWindowStart = opts.slug ? slugWindowStart(opts.slug) : null;
  const currentWindowElapsed = Number.isFinite(currentWindowStart) ? marketNowSecValue - currentWindowStart : Infinity;
  const protectOpening = currentWindowElapsed >= 0 && currentWindowElapsed <= 90;
  if (!state.activityBackfill?.lastRunSec && !protectOpening) {
    state.activityBackfill = {
      lastRunSec: nowSec,
      lastRunAt: isoFromSec(nowSec),
      rows: 0,
      skippedStartup: true,
    };
  }
  const shouldBackfill = !protectOpening
    && Boolean(state.activityBackfill?.lastRunSec)
    && nowSec - num(state.activityBackfill?.lastRunSec) >= 600;
  if (shouldBackfill) {
    const backfillStart = marketNowSecValue - Math.max(20 * 60, opts.backfillMinutes * 60);
    const backfillEnd = marketNowSecValue;
    let backfillRows = 0;
    for (const type of ACTIVITY_TYPES) {
      const rows = await fetchActivitySliced(type, opts, backfillStart, backfillEnd, {
        sliceSec: 900,
        slugFilter: "",
        pageAll: true,
        maxRows: 1000,
        allowPartial: true,
      });
      backfillRows += rows.length;
      batches.push(...rows);
    }
    updateMarketClockFromActivity(state, opts, batches, nowSec);
    state.activityBackfill = {
      lastRunSec: nowSec,
      lastRunAt: isoFromSec(nowSec),
      startSec: backfillStart,
      endSec: backfillEnd,
      rows: backfillRows,
    };
  }
  let changed = false;
  for (const row of batches.sort((a, b) => num(a.timestamp) - num(b.timestamp))) {
    changed = applyActivity(state, row) || changed;
  }
  return changed;
}

function maybeRollAutoBtc5m(state, opts) {
  if (!opts.autoBtc5m) return;
  const nextSlug = currentBtc5mSlug(marketClockNowSec(state));
  if (opts.slug === nextSlug) return;
  archiveCloneWindow(state, state.clone, "auto-roll");
  opts.slug = nextSlug;
  opts.eventUrl = eventUrlForSlug(nextSlug);
  state.slug = opts.slug;
  state.eventUrl = opts.eventUrl;
  state.clone = createInitialCloneState(opts);
  attachCloneVersion(state.clone, state.cloneVersion);
  attachCloneLedgerReset(state.clone, state.cloneLedgerReset);
  recomputeCloneCumulative(state);
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await ensureDir(opts.out);
  await writeTextAtomic(join(opts.out, "index.html"), renderDashboardHtml());
  const stateFile = join(opts.out, "state.json");
  const state = opts.reset
    ? createInitialState(opts)
    : await readJson(stateFile, createInitialState(opts));
  state.wallet = opts.wallet;
  state.slug = opts.slug || null;
  state.eventUrl = opts.eventUrl || (opts.slug ? eventUrlForSlug(opts.slug) : null);
  state.autoBtc5m = opts.autoBtc5m;
  state.pollMs = opts.pollMs;
  state.paperOnly = true;
  opts.marketClockOffsetSec = num(state.marketClockOffsetSec, 0);
  ensureCloneState(state, opts);
  let first = true;
  let lastFlushMs = 0;
  let lastFullFlushMs = 0;

  console.log(`Bonereaper live paper started: ${opts.out}`);
  console.log("Paper-only: no real orders will be submitted.");

  while (true) {
    const startedAt = Date.now();
    try {
      maybeRollAutoBtc5m(state, opts);
      const startSec = first && opts.backfillMinutes > 0 ? Math.floor(Date.now() / 1000) - opts.backfillMinutes * 60 : null;
      if (first) console.log("[live] first loop: activity poll start");
      await pollOnce(state, opts, startSec);
      if (first) console.log("[live] first loop: activity poll done; clone refresh start");
      await refreshCloneEngine(state, opts);
      if (first) console.log("[live] first loop: clone refresh done; flush start");
      state.status = "ok";
      state.lastError = "";
      first = false;
    } catch (err) {
      state.status = "error";
      state.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[live] ${state.lastError}`);
    }
    const nowMs = Date.now();
    const shouldFlush = first || nowMs - lastFlushMs >= opts.flushIntervalMs || state.status === "error";
    if (shouldFlush) {
      const writeFullState = nowMs - lastFullFlushMs >= opts.fullStateFlushIntervalMs || state.status === "error";
      await flush(state, opts, { writeFullState });
      lastFlushMs = nowMs;
      if (writeFullState) lastFullFlushMs = nowMs;
    }
    await sleep(Math.max(250, opts.pollMs - (Date.now() - startedAt)));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
