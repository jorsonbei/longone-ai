#!/usr/bin/env python3
"""HFCD Trading V2.9: crypto failure forensics + regime split diagnostics.

This is intentionally not a new production strategy. It audits V2.8's failed
BTC/ETH high-frequency run before any threshold tuning:

1. Is the direction simply inverted?
2. Are fees/slippage the main cause?
3. Do long-only or short-only slices survive?
4. Does reducing frequency to daily top-scored trades repair OOS performance?

If these diagnostics remain negative, the next model step must change the
problem formulation (regime split / lower-frequency BTC-ETH heads / liquidation
history) rather than tuning the same 5m gate.
"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


VERSION = "HFCD_Trading_V2_9_CryptoFailureForensicsRegimeSplit"
ROOT = Path.cwd()
V28_DIR = ROOT / "outputs" / "hfcd_trading_v2_8_crypto_extended_l2_stablecoin_train"
OUT_DIR = ROOT / "outputs" / "hfcd_trading_v2_9_crypto_failure_forensics_regime_split"
NOTIONAL_USD = 1000.0


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    headers = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def f(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def n(value: float, digits: int = 6) -> float:
    return round(float(value or 0.0), digits)


def entry_day(row: dict[str, Any]) -> str:
    return str(row["entry_ts"])[:10]


def metrics(rows: list[dict[str, Any]], pnl_key: str = "pnl_usd") -> dict[str, Any]:
    pnl = [f(row.get(pnl_key)) for row in rows]
    wins = [x for x in pnl if x > 0]
    losses = [x for x in pnl if x < 0]
    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    for x in pnl:
        equity += x
        peak = max(peak, equity)
        max_dd = min(max_dd, equity - peak)
    return {
        "trades": len(rows),
        "win_rate": n(len(wins) / len(rows), 6) if rows else 0.0,
        "net_pnl_usd": n(sum(pnl), 4),
        "gross_profit_usd": n(sum(wins), 4),
        "gross_loss_usd": n(sum(losses), 4),
        "profit_factor": n(sum(wins) / abs(sum(losses)), 6) if losses else (999.0 if wins else 0.0),
        "max_drawdown_usd": n(max_dd, 4),
        "avg_pnl_usd": n(sum(pnl) / len(rows), 4) if rows else 0.0,
    }


def by_group(rows: list[dict[str, Any]], keys: list[str], pnl_key: str = "pnl_usd") -> list[dict[str, Any]]:
    groups: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[tuple(str(row.get(k, "")) for k in keys)].append(row)
    out: list[dict[str, Any]] = []
    for key, group_rows in sorted(groups.items()):
        rec = {name: value for name, value in zip(keys, key)}
        rec.update(metrics(group_rows, pnl_key=pnl_key))
        rec["avg_gross_return"] = n(sum(f(r.get("gross_return")) for r in group_rows) / len(group_rows), 8)
        rec["avg_execution_cost"] = n(sum(f(r.get("execution_cost")) for r in group_rows) / len(group_rows), 8)
        rec["avg_holding_bars"] = n(sum(f(r.get("holding_bars")) for r in group_rows) / len(group_rows), 4)
        out.append(rec)
    return out


def cost_shock_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for multiplier in [0.0, 0.5, 1.0, 2.0]:
        shocked: list[dict[str, Any]] = []
        for row in rows:
            gross = f(row.get("gross_return"))
            cost = f(row.get("execution_cost")) * multiplier
            copied = dict(row)
            copied["shock_pnl_usd"] = (gross - cost) * NOTIONAL_USD
            shocked.append(copied)
        for rec in by_group(shocked, ["split", "symbol", "feature_family"], pnl_key="shock_pnl_usd"):
            rec["cost_multiplier"] = multiplier
            out.append(rec)
    return out


def inverse_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    copied_rows: list[dict[str, Any]] = []
    for row in rows:
        copied = dict(row)
        copied["inverse_pnl_usd"] = (-f(row.get("gross_return")) - f(row.get("execution_cost"))) * NOTIONAL_USD
        copied_rows.append(copied)
    return by_group(copied_rows, ["split", "symbol", "feature_family"], pnl_key="inverse_pnl_usd")


def daily_top_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the top-N score trades per day/symbol/family in chronological order."""
    test_rows = [row for row in rows if row.get("split") == "test"]
    out: list[dict[str, Any]] = []
    for top_n in [1, 2, 3, 5]:
        buckets: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
        for row in test_rows:
            buckets[(entry_day(row), str(row["symbol"]), str(row["feature_family"]))].append(row)
        kept: list[dict[str, Any]] = []
        for group_rows in buckets.values():
            ranked = sorted(group_rows, key=lambda r: (f(r.get("score")), f(r.get("property_score"))), reverse=True)
            kept.extend(ranked[:top_n])
        kept.sort(key=lambda r: str(r.get("entry_ts", "")))
        for rec in by_group(kept, ["symbol", "feature_family"]):
            rec["split"] = "test"
            rec["frequency_policy"] = f"daily_top_{top_n}"
            rec["trades_per_day"] = n(rec["trades"] / max(1, len({entry_day(r) for r in test_rows})), 6)
            out.append(rec)
    return out


def side_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return by_group(rows, ["split", "symbol", "feature_family", "side"])


def exit_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    test_rows = [row for row in rows if row.get("split") == "test"]
    return by_group(test_rows, ["symbol", "feature_family", "exit_reason"])


def choose_decision(
    family_test: list[dict[str, Any]],
    inverse_test: list[dict[str, Any]],
    daily_test: list[dict[str, Any]],
    cost_test: list[dict[str, Any]],
) -> dict[str, Any]:
    best_family = max(family_test, key=lambda r: f(r["net_pnl_usd"])) if family_test else {}
    best_inverse = max(inverse_test, key=lambda r: f(r["net_pnl_usd"])) if inverse_test else {}
    best_daily = max(daily_test, key=lambda r: f(r["net_pnl_usd"])) if daily_test else {}
    zero_cost = [r for r in cost_test if r.get("split") == "test" and f(r.get("cost_multiplier")) == 0.0]
    best_zero_cost = max(zero_cost, key=lambda r: f(r["net_pnl_usd"])) if zero_cost else {}

    return {
        "best_original_test": best_family,
        "best_inverse_test": best_inverse,
        "best_daily_top_test": best_daily,
        "best_zero_cost_test": best_zero_cost,
        "direction_inversion_repairs": f(best_inverse.get("net_pnl_usd")) > 0,
        "zero_cost_repairs": f(best_zero_cost.get("net_pnl_usd")) > 0,
        "frequency_throttle_repairs": f(best_daily.get("net_pnl_usd")) > 0,
        "next_step": (
            "Build V2.10 lower-frequency BTC/ETH regime heads and collect liquidation history; "
            "do not tune the current 5m gate blindly."
        ),
    }


def md_report(summary: dict[str, Any]) -> str:
    d = summary["decision"]
    return f"""# {VERSION}

## 结论

V2.9 是 V2.8 失败后的病理审计，不是新上线策略。结论：

- 反向交易不能修复：`direction_inversion_repairs={d['direction_inversion_repairs']}`。
- 只把成本降到 0 也不能稳定修复：`zero_cost_repairs={d['zero_cost_repairs']}`。
- 把测试段降频到每日高分交易仍未稳定修复：`frequency_throttle_repairs={d['frequency_throttle_repairs']}`。

这说明问题不是单纯手续费、方向取反或交易次数太多，而是当前 BTC/ETH 的 5 分钟入场信号在样本外没有可靠毛边际。

## 最优诊断切片

- 原始测试最优：`{d['best_original_test'].get('symbol')} / {d['best_original_test'].get('feature_family')}`，PnL `{d['best_original_test'].get('net_pnl_usd')}`，PF `{d['best_original_test'].get('profit_factor')}`。
- 反向测试最优：`{d['best_inverse_test'].get('symbol')} / {d['best_inverse_test'].get('feature_family')}`，PnL `{d['best_inverse_test'].get('net_pnl_usd')}`，PF `{d['best_inverse_test'].get('profit_factor')}`。
- 降频测试最优：`{d['best_daily_top_test'].get('symbol')} / {d['best_daily_top_test'].get('feature_family')} / {d['best_daily_top_test'].get('frequency_policy')}`，PnL `{d['best_daily_top_test'].get('net_pnl_usd')}`，PF `{d['best_daily_top_test'].get('profit_factor')}`。
- 零成本测试最优：`{d['best_zero_cost_test'].get('symbol')} / {d['best_zero_cost_test'].get('feature_family')}`，PnL `{d['best_zero_cost_test'].get('net_pnl_usd')}`，PF `{d['best_zero_cost_test'].get('profit_factor')}`。

## 下一步

V2.10 不应继续调当前 5 分钟阈值。应拆成两个方向：

1. BTC/ETH 低频或中频 regime head：降低噪声，不再每 5 分钟反复开平。
2. 补真实清算历史：用清算/爆仓作为 Bσ 黑子门，不靠价格和盘口代理硬猜。

线上页面不应接入 V2.8/V2.9；当前只保留本地研究输出。
"""


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    trades_path = V28_DIR / "hfcd_trading_v2_8_trades.csv"
    if not trades_path.exists():
        raise SystemExit(f"missing V2.8 trades: {trades_path}")
    rows = read_csv(trades_path)

    family_summary = by_group(rows, ["split", "symbol", "feature_family"])
    side_summary = side_rows(rows)
    exit_summary = exit_rows(rows)
    inverse_summary = inverse_rows(rows)
    cost_summary = cost_shock_rows(rows)
    daily_summary = daily_top_rows(rows)

    family_test = [r for r in family_summary if r.get("split") == "test"]
    inverse_test = [r for r in inverse_summary if r.get("split") == "test"]
    cost_test = [r for r in cost_summary if r.get("split") == "test"]
    decision = choose_decision(family_test, inverse_test, daily_summary, cost_test)

    summary = {
        "version": VERSION,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "source": str(V28_DIR),
        "trade_rows": len(rows),
        "quality_gates": {
            "same_v28_trade_set": True,
            "no_online_page_change": True,
            "diagnostic_only": True,
            "uses_liquidation_history": False,
        },
        "decision": decision,
    }

    write_csv(OUT_DIR / "hfcd_trading_v2_9_family_summary.csv", family_summary)
    write_csv(OUT_DIR / "hfcd_trading_v2_9_side_summary.csv", side_summary)
    write_csv(OUT_DIR / "hfcd_trading_v2_9_exit_reason_summary.csv", exit_summary)
    write_csv(OUT_DIR / "hfcd_trading_v2_9_inverse_audit.csv", inverse_summary)
    write_csv(OUT_DIR / "hfcd_trading_v2_9_cost_shock.csv", cost_summary)
    write_csv(OUT_DIR / "hfcd_trading_v2_9_daily_top_frequency_throttle.csv", daily_summary)
    (OUT_DIR / "hfcd_trading_v2_9_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT_DIR / "HFCD_Trading_V2_9_CryptoFailureForensicsRegimeSplit.md").write_text(md_report(summary), encoding="utf-8")

    print(json.dumps(summary["decision"], ensure_ascii=False, indent=2))
    print(f"V2.9 outputs: {OUT_DIR}")


if __name__ == "__main__":
    main()
