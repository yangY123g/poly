# Bonereaper Paper Simulator v16

这是 `BTC5m-Dash` 项目的 v16 上传包，用于 Polymarket BTC/ETH Up or Down 5m/15m 的本地 paper-only 模拟。

## 版本

- 版本 ID：`portfolio-v16-strict-fill-latency`
- 版本名：`新规则版本：严格盘口成交/手续费 + 600ms 响应延迟`
- 主脚本：`scripts/bonereaper-live-paper.mjs`
- 参考备份：`scripts/bonereaper-live-paper.v14-backup.mjs`

## 安全边界

该脚本只读取公开 API、写入本地 HTML/JSON 状态文件，不导入实盘交易服务，也不会提交真实订单。

## 常用低内存启动命令

```powershell
node scripts\bonereaper-live-paper.mjs --out bonereaper-live-current --poll-ms 500 --backfill-minutes 12 --auto-btc5m --clone --max-trades 3000 --dashboard-max-trades 150 --dashboard-max-history 120 --dashboard-max-orders 60 --flush-interval-ms 5000 --full-state-flush-interval-ms 120000 --clone-execution-latency-ms 600
```

## 说明

v16 的核心重点是把 paper 成交模型收紧：模拟 Polymarket 最小成交金额、可见深度、maker 挂单被击穿才成交、taker 手续费和约 600ms 响应延迟。它仍然是模拟盘版本，不能视为真实交易收益保证。
