# HFCD Crypto Paper Trading 上线 longone 计划

## 当前边界

- 当前 V2.23 是 Binance Futures Testnet mirror，只用于模拟执行、仓位对账和安全审计。
- 不接真实 Binance 主网，不把 API key 暴露到前端。
- BTC 主路由保持 1h，ETH 主路由保持 2h，ETH 15m 只做 shadow；不因为短频活跃就自动晋级。
- 所有新交易类型默认支持做多和做空，但必须有方向策略、最大仓位和 close-all 安全开关。

## 上线目标

把加密货币模拟交易接入 longone 的线上后端与页面，做到：

- 展示 BTC/ETH 实时 paper 信号、跳过原因、仓位、PnL、传感器状态。
- 后端按 V2.23/V2.22 路由生成模拟开平仓。
- 可选同步 Binance Futures Testnet 订单，但默认先只展示 paper，不影响真实资金。
- 提供 `仓位对账`、`Testnet 一键平仓`、`暂停自动镜像` 安全操作。

## 分阶段实施

### P0 本地安全闭环

- 完成 V2.23 `reconcile`：只读取 Testnet 账户、仓位、挂单，不下单。
- 完成 V2.23 `close-all`：只对 BTCUSDT/ETHUSDT 做 reduce-only 平仓，可同时取消挂单。
- 每轮 mirror 自动输出 `safety_report`，记录仓位、挂单、风险标记。
- 用 LaunchAgent 模板每 15 分钟跑一轮，但需要手动安装启用。

### P1 Worker API

- 新增线上 API：`/api/crypto-trading/status`、`/api/crypto-trading/run-once`、`/api/crypto-trading/reconcile`、`/api/crypto-trading/close-all`。
- D1 表复用多市场交易账本结构，新增字段：`route`、`frequency`、`side_policy`、`sensor_source`、`testnet_order_id`。
- 后端只使用服务端环境变量，不允许前端读取任何交易所密钥。

### P2 页面接入

- 新增 “加密货币 AI 交易” 或并入 “多市场 AI 交易” 的 crypto 子页。
- 页面展示：信号时间、BTC/ETH 路由、方向、开平仓事件、PnL、跳过原因、传感器可用性。
- 安全按钮：暂停、仓位对账、Testnet close-all；危险操作需要二次确认。

### P3 前向验证

- 连续 7-14 天积累真实 forward paper 样本。
- 每日输出健康报告：交易数、胜率、PF、最大回撤、跳过原因、quote/传感器可用性。
- 只有当 BTC/ETH 分资产通过前向门槛，才考虑从 Testnet mirror 升级到更真实的 broker/exchange execution。

## 不做的事

- 不直接把 V2.23 变成真实主网交易。
- 不把 BTC/ETH 绑定成一个统一模型，BTC 和 ETH 独立验收。
- 不把 15m/30m 高频路线晋级为主策略，除非盲测和前向 shadow 明确击败 1h/2h 基线。
