# HFCD Football V9 Accuracy-First 操作手册

HFCD Football OS 是物性论 OS 的足球预测能力模块。V9 版本从 `Market-Edge / EV` 导向切换为 `Accuracy-First` 导向：先判断哪种比赛结果最可能发生，再用历史命中率、Brier、log-loss、校准误差和模型一致性审计这条预测是否可靠。

## 核心思想

足球预测不再先问“这条线有没有投注价值”，而是先问“模型对这个结果是否足够准确、稳定、可校准”。赔率仍然可以作为输入特征，也可以作为参考展示，但赔率价值、edge、EV 不再决定高置信预测资格。

## 支持联赛

当前 feed 支持英超、西甲、德甲、意甲、法甲、荷甲、葡超、日职联、欧冠、欧联等主流赛事，具体以 `/api/football/fixtures` 返回的 `competition` 为准。

## 支持预测市场

- 1X2 / 胜平负
- DNB / 平局退款
- AH0 / 0 球让步
- +0.5 / 双重机会类保护结果
- Over / Under
- BTTS Yes/No

## 推荐等级

`official_accuracy` 是高置信预测。它必须通过概率置信度、历史命中率、校准稳定、跨赛季稳定和模型一致性检查；不要求 `edge > 0`，不要求 `EV > 0`，也不要求必须存在可执行赔率。

`watchlist` 是观察预测。它有预测信号，但概率、历史命中率、校准或一致性还未全部达到高置信门槛。

`rejected` 是模型拒绝。必须说明 failure/risk，例如 `low_model_probability`、`calibration_unstable` 或 `model_disagreement`。

`no_signal` 表示当前比赛没有足够稳定的预测信号。

## Accuracy Ledger 字段

- `model_prob`：模型认为预测结果会发生的概率。
- `predicted_result`：模型预测的结果。
- `historical_hit_rate`：相似历史样本下的命中率估计。
- `rolling_hit_rate`：滚动窗口命中率估计。
- `baseline_hit_rate`：不使用 HFCD 信号时的基线命中率。
- `hit_rate_lift`：相对基线提升。
- `brier_score`：概率预测误差，越低越好。
- `log_loss`：概率预测惩罚，越低越好。
- `calibration_error`：模型概率和实际命中稳定性的偏差，越低越好。
- `model_agreement`：多信号一致性评分。
- `prediction_confidence`：综合预测置信度。
- `accuracy_grade`：A/B/C 准确率等级。
- `failure_risk`：未进入高置信预测的主要风险。

## Accuracy-First 门槛

1X2：
- `top_result_prob >= 0.52`
- 滚动命中率至少高于基线 3%
- `calibration_error <= 0.08`
- 跨赛季稳定通过

BTTS：
- `p_yes >= 0.58` 或 `p_no >= 0.58`
- rolling accuracy 高于基线
- Brier 不劣于基线
- 校准稳定

Over/Under：
- `p_over >= 0.57` 或 `p_under >= 0.57`
- rolling accuracy 优于基线
- 不要求赔率 edge

Double Chance：
- `p_double_chance >= 0.68`
- 历史命中率稳定
- 不要求赔率价值

## 赔率边界

赔率、bookmaker、market_prob、edge、EV、Kelly、value_score 可以保留展示，但只能作为参考，不决定 `official_accuracy`。

如果用户问投注价值，必须单独说明：当前模块输出的是高置信比赛结果预测，不等同于投注价值建议。

BTTS Yes/No 的赔率必须使用 BTTS 市场真实赔率，不能用大小球、欧赔或亚盘赔率替代。缺少 BTTS 赔率不会阻止结果概率预测，但会阻止投注价值评估。

## 数据源角色

Titan007 / guess2.titan007.com：当前优先人工和爬虫赔率核对来源，特别用于中文赛程、盘口、公司名和赔率复核。

The Odds API：用于赛程、赔率、部分赛果和 bookmaker 赔率来源。

API-Football：用于 fixture id、球队信息、伤停、首发、赛程和比分补充。

Sportmonks：作为赛程、球队、伤停和赔率补充源。

## 高准确率组合

串关模块改名为“高准确率组合”。排序不再按最高 EV，而是按：

```text
combo_score =
  平均预测概率
  * 历史命中率
  * 模型一致性
  * 校准稳定性
  * 风险惩罚
```

每一腿必须显示联赛、比赛时间、预测市场、预测结果、模型概率、历史命中率、准确率等级和风险。

## 赛后结算

赛后结算使用真实比分或用户提交比分，对 `official_accuracy`、`watchlist` 和组合腿进行 paper-trading 与准确率审计。结算结果用于更新命中率、Brier、log-loss、校准误差、failure_risk 分布和模型稳定性。

## Gemini 协作边界

Gemini 只能解释、组织和审计 HFCD Football 后端结果。它不能绕过工具凭常识预测比赛，不能把观察预测说成高置信预测，不能把结果概率预测包装成投注收益承诺。
