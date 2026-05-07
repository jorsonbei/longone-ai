# HFCD Trading Long/Short Blind Promotion Policy

## 固定规则

所有新增交易路线必须同时评估做多与做空两条方向：

- `long_only`：只做多历史盲测。
- `short_only`：只做空历史盲测。
- `both`：只有当 long 和 short 都分别通过盲测后，才能作为主线双向策略上线。

## 上线门槛

单方向必须同时满足：

- validation 交易数达到最低样本门槛。
- test/blind 交易数达到最低样本门槛。
- validation 和 test/blind 净收益都为正。
- validation 和 test/blind Profit Factor 都超过门槛。
- 费用/滑点压力后不崩。

## 失败处理

- 未通过的方向只能作为 forward shadow 或 watchlist，不得写成主线盈利策略。
- 如果做空未通过，但做多通过，线上可开放做空开关用于前向验证，但页面和 API 必须标记 `short_forward_shadow_not_blind_promoted`。
- 后续升级优先补真实传感器和更长历史，不允许为了通过而回看 test/blind 调参。
