#!/usr/bin/env python3
"""HFCD Commodity V5.22 property-filtered execution layer.

V5.22 does not create a new energy commodity signal. It preserves the current
V5.20 lineage execution layer, then uses the V5.21 10D energy property vector
only as a non-destructive execution gate for:

- OPEN / ADD confirmation
- REDUCE confirmation
- REVERSE confirmation or downgrade
- risk warnings on HOLD

This is intentionally a shadow audit. It should only be promoted after repeated
forward samples show fewer bad reversals and lower drawdown pressure without
damaging the V5.18/V5.20 lineage PnL.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
V520_SCRIPT = ROOT / "scripts" / "hfcd_commodity_v5_20_lineage_execution_layer.py"
V521_SCRIPT = ROOT / "scripts" / "hfcd_commodity_v5_21_energy_property_vector_fusion.py"

V520_DIR = ROOT / "outputs" / "hfcd_commodity_v5_20_lineage_execution_layer"
V520_SUMMARY = V520_DIR / "hfcd_commodity_v5_20_summary.json"

V521_DIR = ROOT / "outputs" / "hfcd_commodity_v5_21_energy_property_vector_fusion"
V521_SUMMARY = V521_DIR / "hfcd_commodity_v5_21_summary.json"
V521_LATEST_VECTORS = V521_DIR / "hfcd_commodity_v5_21_latest_property_vectors.csv"

OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_22_property_filtered_execution_layer"
OUT_DIR.mkdir(parents=True, exist_ok=True)

VERSION = "HFCD_Commodity_V5_22_PropertyFilteredExecutionLayer"
SUMMARY_PATH = OUT_DIR / "hfcd_commodity_v5_22_summary.json"
ACTION_COMPARISON_PATH = OUT_DIR / "hfcd_commodity_v5_22_action_comparison.csv"
GATE_AUDIT_PATH = OUT_DIR / "hfcd_commodity_v5_22_property_gate_audit.csv"
REPORT_PATH = OUT_DIR / "HFCD_Commodity_V5_22_PropertyFilteredExecutionLayer.md"
FIGURE_PATH = OUT_DIR / "HFCD_Commodity_V5_22_PropertyFilteredExecutionLayer.png"


DIMENSIONS = ["Q", "DeltaSigma", "C", "Pi", "Sigma", "Eta", "BSigma", "R", "Tau", "Omega"]

GATE_PROFILES: dict[str, dict[str, float]] = {
    "CL=F": {
        "min_property_score": 0.58,
        "min_open_add_score": 0.62,
        "min_reverse_score": 0.66,
        "min_signed_abs": 0.30,
        "max_bsigma": 0.70,
        "max_reverse_bsigma": 0.66,
        "min_c": 0.55,
        "min_sigma": 0.60,
        "min_tau": 0.50,
        "max_eta": 0.90,
    },
    "HO=F": {
        "min_property_score": 0.57,
        "min_open_add_score": 0.61,
        "min_reverse_score": 0.65,
        "min_signed_abs": 0.30,
        "max_bsigma": 0.72,
        "max_reverse_bsigma": 0.67,
        "min_c": 0.54,
        "min_sigma": 0.60,
        "min_tau": 0.50,
        "max_eta": 0.92,
    },
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def run_script(path: Path, timeout: int = 120) -> dict[str, Any]:
    result = subprocess.run(
        [sys.executable, str(path)],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "stdout_tail": result.stdout[-1400:],
        "stderr_tail": result.stderr[-1400:],
    }


def load_latest_vectors() -> dict[str, dict[str, Any]]:
    if not V521_LATEST_VECTORS.exists():
        return {}
    frame = pd.read_csv(V521_LATEST_VECTORS)
    if frame.empty:
        return {}
    latest = frame.sort_values(["symbol", "generated_at"]).groupby("symbol", as_index=False).tail(1)
    return {str(row["symbol"]): row.to_dict() for _, row in latest.iterrows()}


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
        if math.isfinite(out):
            return out
    except Exception:
        pass
    return default


def property_direction(vector: dict[str, Any]) -> str:
    signed = safe_float(vector.get("signed_signal"), 0.0)
    if signed > 0:
        return "long"
    if signed < 0:
        return "short"
    return "flat"


def property_confirms_side(vector: dict[str, Any], side: str, profile: dict[str, float], *, strict: bool) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    score = safe_float(vector.get("property_score"))
    signed = safe_float(vector.get("signed_signal"))
    direction = property_direction(vector)
    min_score = profile["min_reverse_score"] if strict else profile["min_open_add_score"]
    max_bsigma = profile["max_reverse_bsigma"] if strict else profile["max_bsigma"]

    if direction != side:
        reasons.append(f"property_direction_{direction}_not_{side}")
    if score < min_score:
        reasons.append(f"property_score_{score:.3f}_lt_{min_score:.3f}")
    if abs(signed) < profile["min_signed_abs"]:
        reasons.append(f"signed_signal_abs_{abs(signed):.3f}_lt_{profile['min_signed_abs']:.3f}")
    if safe_float(vector.get("C")) < profile["min_c"]:
        reasons.append(f"C_{safe_float(vector.get('C')):.3f}_lt_{profile['min_c']:.3f}")
    if safe_float(vector.get("Sigma")) < profile["min_sigma"]:
        reasons.append(f"Sigma_{safe_float(vector.get('Sigma')):.3f}_lt_{profile['min_sigma']:.3f}")
    if safe_float(vector.get("Tau")) < profile["min_tau"]:
        reasons.append(f"Tau_{safe_float(vector.get('Tau')):.3f}_lt_{profile['min_tau']:.3f}")
    if safe_float(vector.get("BSigma")) > max_bsigma:
        reasons.append(f"BSigma_{safe_float(vector.get('BSigma')):.3f}_gt_{max_bsigma:.3f}")
    if safe_float(vector.get("Eta")) > profile["max_eta"]:
        reasons.append(f"Eta_{safe_float(vector.get('Eta')):.3f}_gt_{profile['max_eta']:.3f}")

    return len(reasons) == 0, reasons


def property_risk_against_position(vector: dict[str, Any], current_side: str, profile: dict[str, float]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    direction = property_direction(vector)
    if current_side != "flat" and direction != "flat" and direction != current_side:
        reasons.append(f"property_direction_{direction}_opposes_current_{current_side}")
    if safe_float(vector.get("BSigma")) > profile["max_bsigma"]:
        reasons.append(f"BSigma_{safe_float(vector.get('BSigma')):.3f}_risk_high")
    if safe_float(vector.get("C")) < profile["min_c"] - 0.05:
        reasons.append(f"C_{safe_float(vector.get('C')):.3f}_liquidity_weak")
    if safe_float(vector.get("property_score")) < profile["min_property_score"]:
        reasons.append(f"property_score_{safe_float(vector.get('property_score')):.3f}_weak")
    return len(reasons) > 0, reasons


def filter_action(row: dict[str, Any], vector: dict[str, Any] | None) -> dict[str, Any]:
    symbol = str(row.get("symbol"))
    original = str(row.get("controller_action", "SKIP"))
    profile = GATE_PROFILES.get(symbol, GATE_PROFILES["CL=F"])
    current_side = str(row.get("current_side", "flat"))
    target_side = str(row.get("target_side", row.get("v5_18_side", "flat")))
    pnl_pct = safe_float(row.get("pnl_pct"), 0.0)
    out_action = original
    gate_status = "pass_through"
    gate_reason = "action_not_controlled_by_property_gate"
    blocked_reverse = False
    blocked_add = False
    blocked_open = False
    blocked_reduce = False
    risk_warning = False

    if vector is None:
        return {
            "filtered_action": "HOLD" if original != "SKIP" else "SKIP",
            "gate_status": "coverage_missing",
            "gate_reason": "missing_v5_21_property_vector",
            "blocked_reverse": original == "REVERSE_SHADOW",
            "blocked_add": original == "ADD_SHADOW",
            "blocked_open": original == "OPEN_SHADOW",
            "blocked_reduce": False,
            "risk_warning": False,
        }

    if original in {"OPEN_SHADOW", "ADD_SHADOW"}:
        ok, reasons = property_confirms_side(vector, target_side, profile, strict=False)
        if ok:
            gate_status = "approved"
            gate_reason = "property_vector_confirms_open_or_add"
        else:
            out_action = "SKIP" if original == "OPEN_SHADOW" else "HOLD"
            blocked_open = original == "OPEN_SHADOW"
            blocked_add = original == "ADD_SHADOW"
            gate_status = "blocked"
            gate_reason = ";".join(reasons)

    elif original == "REVERSE_SHADOW":
        ok, reasons = property_confirms_side(vector, target_side, profile, strict=True)
        if ok:
            gate_status = "approved"
            gate_reason = "property_vector_confirms_reverse"
        else:
            blocked_reverse = True
            out_action = "REDUCE_SHADOW" if pnl_pct < 0 else "HOLD"
            gate_status = "downgraded"
            gate_reason = "reverse_not_property_confirmed;" + ";".join(reasons)

    elif original == "REDUCE_SHADOW":
        risk, reasons = property_risk_against_position(vector, current_side, profile)
        target_ok, target_reasons = property_confirms_side(vector, target_side, profile, strict=False)
        if risk or target_ok:
            gate_status = "approved"
            gate_reason = "property_vector_confirms_reduce_risk" if risk else "property_vector_confirms_opposite_target"
            if risk:
                gate_reason += ";" + ";".join(reasons)
        else:
            out_action = "HOLD"
            blocked_reduce = True
            gate_status = "blocked"
            gate_reason = "reduce_not_property_confirmed;" + ";".join(target_reasons)

    elif original == "HOLD":
        risk, reasons = property_risk_against_position(vector, current_side, profile)
        if risk:
            risk_warning = True
            gate_status = "risk_warning"
            gate_reason = ";".join(reasons)
        else:
            gate_status = "pass_through"
            gate_reason = "hold_without_property_risk"

    return {
        "filtered_action": out_action,
        "gate_status": gate_status,
        "gate_reason": gate_reason,
        "blocked_reverse": blocked_reverse,
        "blocked_add": blocked_add,
        "blocked_open": blocked_open,
        "blocked_reduce": blocked_reduce,
        "risk_warning": risk_warning,
    }


def append_csv(path: Path, rows: list[dict[str, Any]], dedupe_subset: list[str] | None = None) -> pd.DataFrame:
    if not rows:
        return pd.read_csv(path) if path.exists() else pd.DataFrame()
    df = pd.DataFrame(rows)
    if path.exists():
        old = pd.read_csv(path)
        df = pd.concat([old, df], ignore_index=True)
    if dedupe_subset:
        df = df.drop_duplicates(subset=dedupe_subset, keep="last")
    df.to_csv(path, index=False)
    return df


def write_report(summary: dict[str, Any], comparison: list[dict[str, Any]]) -> None:
    lines = [
        f"# {VERSION}",
        "",
        "## 定位",
        "V5.22 不生成新的能源商品主信号。V5.20 仍是主执行层，V5.21 的 10 维物性向量只作为加仓、减仓、反手、跳过的确认闸门。",
        "",
        "## 本轮对比",
        "| 标的 | V5.20动作 | V5.22过滤后 | 当前方向 | 目标方向 | 物性方向 | 物性分 | Gate | 原因 |",
        "|---|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for row in comparison:
        lines.append(
            f"| {row['symbol']} | {row['original_action']} | {row['filtered_action']} | "
            f"{row['current_side']} | {row['target_side']} | {row['property_direction']} | "
            f"{row['property_score']:.3f} | {row['gate_status']} | {row['gate_reason']} |"
        )
    lines.extend(
        [
            "",
            "## 审计结论",
            f"- blocked_reverse_count: {summary['gate_counts']['blocked_reverse_count']}",
            f"- blocked_add_count: {summary['gate_counts']['blocked_add_count']}",
            f"- blocked_open_count: {summary['gate_counts']['blocked_open_count']}",
            f"- blocked_reduce_count: {summary['gate_counts']['blocked_reduce_count']}",
            f"- risk_warning_count: {summary['gate_counts']['risk_warning_count']}",
            "",
            "## 解释",
            "10 维物性向量在这里不是发动机，而是执行层的刹车和离合器。它的价值不是多开仓，而是减少未经物性确认的反手、加仓和减仓。",
            "",
            "## 下一步",
            "继续让 V5.22 跟随 V5.20 跑前向样本；只有当它稳定减少错误反手且不损伤 V5.18/V5.20 收益时，才考虑把它接入线上主执行。",
        ]
    )
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")


def write_figure(history: pd.DataFrame) -> None:
    if history.empty:
        return
    latest = history.tail(40)
    fig, axes = plt.subplots(1, 2, figsize=(11, 4))
    action_counts = latest[["original_action", "filtered_action"]].melt(var_name="kind", value_name="action")
    pivot = action_counts.groupby(["kind", "action"]).size().unstack(fill_value=0)
    pivot.plot(kind="bar", ax=axes[0], color=["#38bdf8", "#22c55e", "#f59e0b", "#ef4444", "#a78bfa"])
    axes[0].set_title("V5.20 original vs V5.22 filtered")
    axes[0].set_xlabel("")
    axes[0].tick_params(axis="x", labelrotation=0)
    for symbol, group in latest.groupby("symbol"):
        axes[1].plot(range(len(group)), group["property_score"].astype(float), marker="o", label=symbol)
    axes[1].axhline(0.58, color="#f59e0b", linestyle="--", linewidth=1)
    axes[1].set_title("Property score at action time")
    axes[1].legend(loc="best")
    for ax in axes:
        ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(FIGURE_PATH, dpi=160)
    plt.close(fig)


def main() -> None:
    started = time.time()
    now = utc_now()
    v520_run = run_script(V520_SCRIPT, timeout=90)
    v521_run = run_script(V521_SCRIPT, timeout=140)
    v520_summary = read_json(V520_SUMMARY, {})
    v521_summary = read_json(V521_SUMMARY, {})
    vectors = load_latest_vectors()

    comparison_rows: list[dict[str, Any]] = []
    gate_rows: list[dict[str, Any]] = []
    for action in v520_summary.get("actions_this_run", []):
        symbol = str(action.get("symbol"))
        vector = vectors.get(symbol)
        gate = filter_action(action, vector)
        property_score = safe_float(vector.get("property_score") if vector else None)
        signed_signal = safe_float(vector.get("signed_signal") if vector else None)
        row = {
            "generated_at": now.isoformat(),
            "symbol": symbol,
            "v5_20_generated_at": v520_summary.get("generated_at"),
            "v5_21_generated_at": v521_summary.get("generated_at"),
            "v5_18_signal_id": action.get("v5_18_signal_id", ""),
            "v5_18_action": action.get("v5_18_action", ""),
            "v5_18_side": action.get("v5_18_side", ""),
            "v5_18_score": safe_float(action.get("v5_18_score")),
            "micro_side": action.get("micro_side", ""),
            "micro_score": safe_float(action.get("micro_score")),
            "current_side": action.get("current_side", "flat"),
            "target_side": action.get("target_side", "flat"),
            "current_units": int(safe_float(action.get("current_units"), 0.0)),
            "pnl_pct": safe_float(action.get("pnl_pct")),
            "unrealized_pnl_usd": safe_float(action.get("unrealized_pnl_usd")),
            "original_action": action.get("controller_action", ""),
            "original_reason": action.get("reason", ""),
            "filtered_action": gate["filtered_action"],
            "gate_status": gate["gate_status"],
            "gate_reason": gate["gate_reason"],
            "property_score": property_score,
            "signed_signal": signed_signal,
            "property_direction": property_direction(vector or {}),
            **{key: safe_float(vector.get(key) if vector else None) for key in DIMENSIONS},
            "blocked_reverse": gate["blocked_reverse"],
            "blocked_add": gate["blocked_add"],
            "blocked_open": gate["blocked_open"],
            "blocked_reduce": gate["blocked_reduce"],
            "risk_warning": gate["risk_warning"],
        }
        comparison_rows.append(row)
        gate_rows.append(
            {
                "generated_at": row["generated_at"],
                "symbol": symbol,
                "original_action": row["original_action"],
                "filtered_action": row["filtered_action"],
                "gate_status": row["gate_status"],
                "gate_reason": row["gate_reason"],
                "property_score": row["property_score"],
                "signed_signal": row["signed_signal"],
                "property_direction": row["property_direction"],
                "blocked_reverse": row["blocked_reverse"],
                "risk_warning": row["risk_warning"],
            }
        )

    comparison_df = append_csv(ACTION_COMPARISON_PATH, comparison_rows, dedupe_subset=["generated_at", "symbol", "v5_18_signal_id"])
    append_csv(GATE_AUDIT_PATH, gate_rows, dedupe_subset=["generated_at", "symbol", "original_action"])

    gate_counts = {
        "blocked_reverse_count": int(sum(bool(r["blocked_reverse"]) for r in comparison_rows)),
        "blocked_add_count": int(sum(bool(r["blocked_add"]) for r in comparison_rows)),
        "blocked_open_count": int(sum(bool(r["blocked_open"]) for r in comparison_rows)),
        "blocked_reduce_count": int(sum(bool(r["blocked_reduce"]) for r in comparison_rows)),
        "risk_warning_count": int(sum(bool(r["risk_warning"]) for r in comparison_rows)),
    }
    action_counts = {
        "v5_20_original": pd.Series([r["original_action"] for r in comparison_rows]).value_counts().to_dict() if comparison_rows else {},
        "v5_22_filtered": pd.Series([r["filtered_action"] for r in comparison_rows]).value_counts().to_dict() if comparison_rows else {},
    }
    blocked_reverse_rows = [r for r in comparison_rows if r["blocked_reverse"]]
    decision = "shadow_filter_only_keep_v5_20_main"
    if blocked_reverse_rows:
        decision = "shadow_filter_downgraded_unconfirmed_reverse_keep_v5_20_main_until_forward_validated"

    summary = {
        "version": VERSION,
        "generated_at": now.isoformat(),
        "status": "property_filtered_execution_shadow_completed",
        "decision": decision,
        "rule": "V5.21 property vector confirms execution actions only; it does not create new main signals.",
        "v5_20_run": v520_run,
        "v5_21_run": v521_run,
        "v5_20_generated_at": v520_summary.get("generated_at"),
        "v5_21_generated_at": v521_summary.get("generated_at"),
        "action_counts": action_counts,
        "gate_counts": gate_counts,
        "actions_this_run": comparison_rows,
        "paper_pnl_reference": v520_summary.get("paper_pnl", {}),
        "property_vector_reference": v521_summary.get("latest_vectors", []),
        "runtime_sec": round(time.time() - started, 3),
        "outputs": {
            "summary_json": str(SUMMARY_PATH),
            "action_comparison_csv": str(ACTION_COMPARISON_PATH),
            "gate_audit_csv": str(GATE_AUDIT_PATH),
            "report_md": str(REPORT_PATH),
            "figure_png": str(FIGURE_PATH),
        },
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    write_report(summary, comparison_rows)
    write_figure(comparison_df)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
