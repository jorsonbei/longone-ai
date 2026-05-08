#!/usr/bin/env python3
"""HFCD Commodity V5.4: real exogenous hit-rate lift.

Local research only. No broker calls, no testnet calls, no online page changes.

Goal:
- Do not move NG/RB/CL/HO to forward ledger yet.
- Improve next-horizon direction hit rate by adding product-specific exogenous
  sensors instead of hard-tuning thresholds.
- Keep a no-leak train/validation/test protocol.

HFCD mapping used here:
- Q-core: trend identity and regime stability.
- C-cavity: volume/range carrying capacity.
- Sigma ledger: inventory, storage, refinery demand, crack spreads.
- B-sigma: volatility/supply contradiction and event-window fragility.
- Time phase: EIA release windows, heating/cooling/driving season.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


ROOT = Path.cwd()
VERSION = "HFCD_Commodity_V5_4_RealExogenousHitRateLift"
OUT_DIR = ROOT / "outputs" / "hfcd_commodity_v5_4_real_exogenous_hit_rate_lift"
V51_PATH = ROOT / "scripts" / "hfcd_commodity_v5_1_next_horizon_density_router.py"
V40_PATH = ROOT / "scripts" / "hfcd_commodity_v4_0_crude_oil_supply_forecast.py"

spec51 = importlib.util.spec_from_file_location("v51_density", V51_PATH)
v51 = importlib.util.module_from_spec(spec51)
assert spec51 and spec51.loader
sys.modules["v51_density"] = v51
spec51.loader.exec_module(v51)

spec40 = importlib.util.spec_from_file_location("v40_crude_supply", V40_PATH)
v40 = importlib.util.module_from_spec(spec40)
assert spec40 and spec40.loader
sys.modules["v40_crude_supply"] = v40
spec40.loader.exec_module(v40)


TARGET_SYMBOLS = ["CL=F", "RB=F", "HO=F", "NG=F"]
PEER_SYMBOLS = ["CL=F", "RB=F", "HO=F", "NG=F", "BZ=F"]
ROUTE_FREQS = v51.ROUTE_FREQS
BASE_NOTIONAL_USD = 500.0
NG_BULK_URL = "https://api.eia.gov/bulk/NG.zip"
NG_BULK_PATH = ROOT / "outputs" / "_cache" / "eia_ng_bulk" / "NG.zip"
NG_STORAGE_SERIES = "NG.NW2_EPG0_SWO_R48_BCF.W"
WEATHER_CACHE_DIR = ROOT / "outputs" / "_cache" / "open_meteo_energy_weather"
OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
WEATHER_LOCATIONS = [
    {"name": "chicago", "lat": 41.8781, "lon": -87.6298, "weight": 0.18, "region": "midwest"},
    {"name": "new_york", "lat": 40.7128, "lon": -74.0060, "weight": 0.18, "region": "northeast"},
    {"name": "boston", "lat": 42.3601, "lon": -71.0589, "weight": 0.10, "region": "northeast"},
    {"name": "houston", "lat": 29.7604, "lon": -95.3698, "weight": 0.17, "region": "gulf"},
    {"name": "dallas", "lat": 32.7767, "lon": -96.7970, "weight": 0.12, "region": "texas"},
    {"name": "atlanta", "lat": 33.7490, "lon": -84.3880, "weight": 0.10, "region": "southeast"},
    {"name": "los_angeles", "lat": 34.0522, "lon": -118.2437, "weight": 0.15, "region": "west"},
]
EIA_SURPRISE_VARIABLES = [
    "crude_stocks",
    "cushing_stocks",
    "gasoline_stocks",
    "distillate_stocks",
    "crude_production",
    "crude_imports",
    "refinery_utilization",
    "refinery_inputs",
]


@dataclass(frozen=True)
class ExogenousPolicy:
    symbol: str
    cadence: str
    model_name: str
    confidence_threshold: float
    min_consensus: int
    min_hfcd_quality: float
    max_units: int

    @property
    def name(self) -> str:
        return (
            f"{self.symbol}_{self.cadence}_{self.model_name}_conf{self.confidence_threshold:.2f}_"
            f"cons{self.min_consensus}_q{self.min_hfcd_quality:.2f}_max{self.max_units}"
        )


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if rows:
        v40.write_csv(path, rows)
    else:
        pd.DataFrame(columns=columns or []).to_csv(path, index=False)


def zscore(s: pd.Series, window: int = 96) -> pd.Series:
    return v51.zscore(pd.to_numeric(s, errors="coerce").fillna(0.0), window)


def profit_factor(pnls: list[float]) -> float:
    return float(v40.profit_factor(pnls))


def max_drawdown_from_pnls(pnls: list[float]) -> float:
    return float(v40.max_drawdown_from_pnls(pnls))


def split_masks(timestamps: pd.Series) -> tuple[pd.Timestamp, pd.Timestamp]:
    return v51.split_masks(timestamps)


def split_name(ts: pd.Timestamp, cut1: pd.Timestamp, cut2: pd.Timestamp) -> str:
    return v51.split_name(ts, cut1, cut2)


def download_ng_bulk(force: bool = False) -> Path:
    NG_BULK_PATH.parent.mkdir(parents=True, exist_ok=True)
    if NG_BULK_PATH.exists() and NG_BULK_PATH.stat().st_size > 1_000_000 and not force:
        return NG_BULK_PATH
    req = urllib.request.Request(NG_BULK_URL, headers={"User-Agent": "HFCD research crawler"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        NG_BULK_PATH.write_bytes(resp.read())
    return NG_BULK_PATH


def load_ng_storage_features() -> tuple[pd.DataFrame, dict[str, Any]]:
    metadata: dict[str, Any] = {
        "source": "EIA NG bulk official",
        "series_id": NG_STORAGE_SERIES,
        "status": "missing",
        "rows": 0,
    }
    try:
        zip_path = download_ng_bulk()
        records: list[dict[str, Any]] = []
        with zipfile.ZipFile(zip_path) as zf, zf.open("NG.txt") as fh:
            for raw in fh:
                obj = json.loads(raw)
                if obj.get("series_id") != NG_STORAGE_SERIES:
                    continue
                for period, value in obj.get("data", []):
                    if value is None:
                        continue
                    records.append({"report_date": pd.to_datetime(str(period)), "ng_storage_bcf": float(value)})
                metadata.update(
                    {
                        "status": "loaded",
                        "name": obj.get("name"),
                        "units": obj.get("units"),
                        "frequency": obj.get("f"),
                        "start": obj.get("start"),
                        "end": obj.get("end"),
                        "rows": len(records),
                    }
                )
                break
        if not records:
            return pd.DataFrame(), metadata
        df = pd.DataFrame(records).drop_duplicates("report_date").sort_values("report_date").reset_index(drop=True)
        df["report_date"] = pd.to_datetime(df["report_date"], utc=True)
        # Conservative no-leak approximation: storage week ending Friday becomes
        # tradable after the following Thursday morning US release.
        df["available_time"] = df["report_date"] + pd.Timedelta(days=6, hours=15, minutes=30)
        df["ng_storage_change"] = df["ng_storage_bcf"].diff()
        df["ng_storage_forecast_change"] = df["ng_storage_change"].rolling(4, min_periods=2).mean().shift(1)
        df["ng_storage_surprise"] = df["ng_storage_change"] - df["ng_storage_forecast_change"]
        df["ng_storage_surprise_z"] = v40.zscore(df["ng_storage_surprise"], 52)
        df["ng_storage_change_z"] = v40.zscore(df["ng_storage_change"], 52)
        df["weekofyear"] = df["report_date"].dt.isocalendar().week.astype(int)
        seasonal = df.groupby("weekofyear")["ng_storage_bcf"].transform(lambda x: x.shift(1).rolling(8, min_periods=2).mean())
        df["ng_storage_seasonal_norm"] = seasonal.ffill()
        df["ng_storage_deficit"] = df["ng_storage_bcf"] - df["ng_storage_seasonal_norm"]
        df["ng_storage_deficit_z"] = v40.zscore(df["ng_storage_deficit"], 52)
        # Positive means storage is tighter or injections are weaker than usual.
        df["ng_storage_tightness"] = (-0.65 * df["ng_storage_deficit_z"] - 0.35 * df["ng_storage_change_z"]).clip(-4, 4).fillna(0.0)
        return df, metadata
    except Exception as exc:
        metadata["status"] = "failed"
        metadata["error"] = repr(exc)
        return pd.DataFrame(), metadata


def fetch_open_meteo_location(location: dict[str, Any], start_date: str, end_date: str) -> pd.DataFrame:
    WEATHER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = WEATHER_CACHE_DIR / f"{location['name']}_{start_date}_{end_date}.json"
    if cache_path.exists() and cache_path.stat().st_size > 100:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        query = (
            f"{OPEN_METEO_ARCHIVE}?latitude={location['lat']}&longitude={location['lon']}"
            f"&start_date={start_date}&end_date={end_date}"
            "&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=UTC"
        )
        req = urllib.request.Request(query, headers={"User-Agent": "HFCD research weather crawler"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        cache_path.write_text(json.dumps(data), encoding="utf-8")
    hourly = data.get("hourly", {})
    times = hourly.get("time", [])
    temps = hourly.get("temperature_2m", [])
    frame = pd.DataFrame(
        {
            "timestamp": pd.to_datetime(times, utc=True),
            f"{location['name']}_temp_f": pd.to_numeric(pd.Series(temps), errors="coerce"),
        }
    )
    return frame.dropna(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)


def load_weather_basket_features(start_ts: pd.Timestamp, end_ts: pd.Timestamp) -> tuple[pd.DataFrame, dict[str, Any]]:
    meta: dict[str, Any] = {
        "source": "Open-Meteo archive fallback for NOAA-style city temperature basket",
        "noaa_status": "not_configured_token_required_for_historical_cdo",
        "status": "missing",
        "locations": [x["name"] for x in WEATHER_LOCATIONS],
        "rows": 0,
    }
    try:
        start_date = pd.Timestamp(start_ts).date().isoformat()
        end_date = pd.Timestamp(end_ts).date().isoformat()
        merged: pd.DataFrame | None = None
        temp_cols: list[str] = []
        for loc in WEATHER_LOCATIONS:
            frame = fetch_open_meteo_location(loc, start_date, end_date)
            col = f"{loc['name']}_temp_f"
            temp_cols.append(col)
            merged = frame if merged is None else pd.merge(merged, frame, on="timestamp", how="outer")
        if merged is None or merged.empty:
            return pd.DataFrame(), meta
        merged = merged.sort_values("timestamp").ffill().reset_index(drop=True)
        weights = {f"{loc['name']}_temp_f": float(loc["weight"]) for loc in WEATHER_LOCATIONS}
        weight_sum = sum(weights.values())
        merged["weather_basket_temp_f"] = sum(merged[col] * weights[col] for col in temp_cols) / weight_sum
        northeast_cols = [f"{loc['name']}_temp_f" for loc in WEATHER_LOCATIONS if loc["region"] == "northeast"]
        texas_cols = [f"{loc['name']}_temp_f" for loc in WEATHER_LOCATIONS if loc["region"] in {"texas", "gulf"}]
        merged["northeast_temp_f"] = merged[northeast_cols].mean(axis=1)
        merged["texas_gulf_temp_f"] = merged[texas_cols].mean(axis=1)
        merged["hdd_65"] = (65.0 - merged["weather_basket_temp_f"]).clip(lower=0)
        merged["cdd_65"] = (merged["weather_basket_temp_f"] - 65.0).clip(lower=0)
        merged["northeast_hdd_65"] = (65.0 - merged["northeast_temp_f"]).clip(lower=0)
        merged["texas_cdd_65"] = (merged["texas_gulf_temp_f"] - 65.0).clip(lower=0)
        for col in ["hdd_65", "cdd_65", "northeast_hdd_65", "texas_cdd_65"]:
            merged[f"{col}_z"] = zscore(merged[col], 168)
            merged[f"{col}_delta_6h_z"] = zscore(merged[col].diff(6), 168)
        merged["ng_weather_pressure"] = (
            merged["hdd_65_z"].clip(-3, 3) * 0.40
            + merged["cdd_65_z"].clip(-3, 3) * 0.25
            + merged["hdd_65_delta_6h_z"].clip(-3, 3) * 0.20
            + merged["cdd_65_delta_6h_z"].clip(-3, 3) * 0.15
        )
        merged["rb_driving_weather"] = (
            (1.0 / (1.0 + np.abs(merged["texas_cdd_65_z"]))).clip(0, 1) * 0.35
            + merged["cdd_65_z"].clip(-2, 2) * 0.20
            - merged["hdd_65_z"].clip(-2, 2) * 0.10
        )
        merged["ho_heating_weather"] = (
            merged["northeast_hdd_65_z"].clip(-3, 3) * 0.55
            + merged["northeast_hdd_65_delta_6h_z"].clip(-3, 3) * 0.30
            + merged["hdd_65_z"].clip(-3, 3) * 0.15
        )
        # Conservative no-leak: hourly archive observation is usable after the hour closes.
        merged["available_time"] = merged["timestamp"] + pd.Timedelta(hours=1)
        meta.update({"status": "loaded", "rows": len(merged), "start": start_date, "end": end_date})
        return merged, meta
    except Exception as exc:
        meta["status"] = "failed"
        meta["error"] = repr(exc)
        return pd.DataFrame(), meta


def add_calendar_weather_proxy(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    ts = pd.to_datetime(out["timestamp"], utc=True)
    doy = ts.dt.dayofyear.astype(float)
    month = ts.dt.month.astype(int)
    dow = ts.dt.dayofweek.astype(int)
    hour = ts.dt.hour.astype(int)
    out["season_sin"] = np.sin(2 * np.pi * doy / 365.25)
    out["season_cos"] = np.cos(2 * np.pi * doy / 365.25)
    out["heating_season_pressure"] = month.isin([11, 12, 1, 2, 3]).astype(float)
    out["cooling_season_pressure"] = month.isin([6, 7, 8, 9]).astype(float)
    out["shoulder_season_flag"] = month.isin([4, 5, 10]).astype(float)
    out["driving_season_pressure"] = month.isin([5, 6, 7, 8, 9]).astype(float)
    out["injection_season_flag"] = month.isin([4, 5, 6, 7, 8, 9, 10]).astype(float)
    out["withdrawal_season_flag"] = month.isin([11, 12, 1, 2, 3]).astype(float)
    out["eia_petroleum_release_window"] = ((dow == 2) & (hour >= 14) & (hour <= 20)).astype(float)
    out["eia_ng_storage_release_window"] = ((dow == 3) & (hour >= 14) & (hour <= 20)).astype(float)
    return out


def add_peer_features(out: pd.DataFrame, peers: dict[str, pd.DataFrame]) -> pd.DataFrame:
    def price_series(col: str, fallback: pd.Series) -> pd.Series:
        if col in out.columns:
            return pd.to_numeric(out[col], errors="coerce").ffill()
        return pd.to_numeric(fallback, errors="coerce").ffill()

    for peer_symbol, peer in peers.items():
        frame = peer[["timestamp", "close"]].rename(columns={"close": f"{peer_symbol}_close"}).sort_values("timestamp")
        out = pd.merge_asof(
            out.sort_values("timestamp"),
            frame,
            on="timestamp",
            direction="nearest",
            tolerance=pd.Timedelta("45min"),
        )
        px = price_series(f"{peer_symbol}_close", out["close"])
        out[f"{peer_symbol}_ret1"] = px.pct_change(1).fillna(0.0)
        out[f"{peer_symbol}_ret2"] = px.pct_change(2).fillna(0.0)
        out[f"{peer_symbol}_ret4"] = px.pct_change(4).fillna(0.0)
        out[f"{peer_symbol}_mom_z"] = zscore(px.pct_change(4).fillna(0.0), 96)
    cl = price_series("CL=F_close", out["close"])
    rb = price_series("RB=F_close", out["close"])
    ho = price_series("HO=F_close", out["close"])
    ng = price_series("NG=F_close", out["close"])
    bz = price_series("BZ=F_close", cl)
    out["rb_crack_z_v53"] = zscore(np.log((rb + 1e-9) / (cl + 1e-9)), 96)
    out["ho_crack_z_v53"] = zscore(np.log((ho + 1e-9) / (cl + 1e-9)), 96)
    out["ng_oil_ratio_z_v53"] = zscore(np.log((ng + 1e-9) / (cl + 1e-9)), 96)
    out["brent_wti_spread_z_v53"] = zscore(bz - cl, 96)
    out["rb_ho_spread_z"] = zscore(np.log((rb + 1e-9) / (ho + 1e-9)), 96)
    out["rb_crack_delta_z_v54"] = zscore(out["rb_crack_z_v53"].diff(2), 96)
    out["ho_crack_delta_z_v54"] = zscore(out["ho_crack_z_v53"].diff(2), 96)
    out["ng_oil_ratio_delta_z_v54"] = zscore(out["ng_oil_ratio_z_v53"].diff(2), 96)
    out["brent_wti_spread_delta_z_v54"] = zscore(out["brent_wti_spread_z_v53"].diff(2), 96)
    out["rb_ho_spread_delta_z_v54"] = zscore(out["rb_ho_spread_z"].diff(2), 96)
    return out


def add_inventory_surprise_features(out: pd.DataFrame) -> pd.DataFrame:
    for base in EIA_SURPRISE_VARIABLES:
        change_col = f"{base}_change"
        forecast_col = f"{base}_forecast_change"
        surprise_col = f"{base}_surprise"
        z_col = f"{base}_surprise_z"
        if change_col in out.columns and forecast_col in out.columns:
            out[surprise_col] = pd.to_numeric(out[change_col], errors="coerce") - pd.to_numeric(
                out[forecast_col], errors="coerce"
            )
        else:
            out[surprise_col] = 0.0
        out[z_col] = zscore(pd.to_numeric(out[surprise_col], errors="coerce").fillna(0.0), 96)
    return out


def attach_exogenous(
    df: pd.DataFrame,
    symbol: str,
    peers: dict[str, pd.DataFrame],
    supply: pd.DataFrame,
    ng_storage: pd.DataFrame,
    weather: pd.DataFrame,
) -> pd.DataFrame:
    out = v51.add_energy_features(df, symbol, peers, supply)
    out = add_inventory_surprise_features(out)
    out = add_calendar_weather_proxy(out)
    out = add_peer_features(out, peers)

    if not weather.empty:
        weather_for_merge = weather.drop(columns=["timestamp"], errors="ignore")
        out = pd.merge_asof(
            out.sort_values("timestamp"),
            weather_for_merge.sort_values("available_time"),
            left_on="timestamp",
            right_on="available_time",
            direction="backward",
        )

    if not ng_storage.empty:
        out = pd.merge_asof(
            out.sort_values("timestamp"),
            ng_storage.sort_values("available_time"),
            left_on="timestamp",
            right_on="available_time",
            direction="backward",
        )
    for col in [
        "ng_storage_bcf",
        "ng_storage_change_z",
        "ng_storage_deficit_z",
        "ng_storage_tightness",
        "ng_storage_surprise_z",
        "ng_storage_forecast_change",
        "weather_basket_temp_f",
        "hdd_65_z",
        "cdd_65_z",
        "hdd_65_delta_6h_z",
        "cdd_65_delta_6h_z",
        "northeast_hdd_65_z",
        "northeast_hdd_65_delta_6h_z",
        "texas_cdd_65_z",
        "texas_cdd_65_delta_6h_z",
        "ng_weather_pressure",
        "rb_driving_weather",
        "ho_heating_weather",
    ]:
        if col not in out:
            out[col] = 0.0
        out[col] = pd.to_numeric(out[col], errors="coerce").ffill().fillna(0.0)

    out["ret_sign_1"] = np.sign(out["bar_return"]).replace(0, np.nan).ffill().fillna(0.0)
    out["ret_sign_4_sum"] = np.sign(out["bar_return"]).rolling(4, min_periods=2).sum().fillna(0.0)
    out["vol_compression"] = (1.0 / (1.0 + out["eta_noise"].clip(0, 5))).fillna(0.5)
    out["eia_event_risk"] = (
        out["eia_petroleum_release_window"] * (1.0 if symbol in {"CL=F", "RB=F", "HO=F"} else 0.0)
        + out["eia_ng_storage_release_window"] * (1.0 if symbol == "NG=F" else 0.0)
    ).clip(0, 1)

    # Product-specific Sigma ledger. Positive should be bullish pressure.
    if symbol == "NG=F":
        out["v53_sigma_ledger"] = (
            out["ng_storage_tightness"].clip(-3, 3) * 0.26
            - out["ng_storage_surprise_z"].clip(-3, 3) * 0.18
            + out["ng_weather_pressure"].clip(-3, 3) * 0.24
            + out["ng_oil_ratio_delta_z_v54"].clip(-2, 2) * 0.12
            + out["NG=F_mom_z"].clip(-2, 2) * 0.20
        )
    elif symbol == "RB=F":
        out["v53_sigma_ledger"] = (
            -out["gasoline_stocks_surprise_z"].clip(-3, 3) * 0.24
            + out["rb_crack_z_v53"].clip(-2, 2) * 0.22
            + out["rb_crack_delta_z_v54"].clip(-2, 2) * 0.16
            + out["driving_season_pressure"] * 0.12
            + out["rb_driving_weather"].clip(-2, 2) * 0.10
            + out["refinery_demand"].clip(-2, 2) * 0.10
            + out["RB=F_mom_z"].clip(-2, 2) * 0.06
        )
    elif symbol == "HO=F":
        out["v53_sigma_ledger"] = (
            -out["distillate_stocks_surprise_z"].clip(-3, 3) * 0.24
            + out["ho_crack_z_v53"].clip(-2, 2) * 0.20
            + out["ho_crack_delta_z_v54"].clip(-2, 2) * 0.16
            + out["ho_heating_weather"].clip(-3, 3) * 0.18
            + out["brent_wti_spread_delta_z_v54"].clip(-2, 2) * 0.08
            + out["HO=F_mom_z"].clip(-2, 2) * 0.14
        )
    else:
        out["v53_sigma_ledger"] = (
            -out["crude_stocks_surprise_z"].clip(-3, 3) * 0.18
            - out["cushing_stocks_surprise_z"].clip(-3, 3) * 0.14
            + out["refinery_inputs_surprise_z"].clip(-3, 3) * 0.12
            + out["refinery_demand"].clip(-2, 2) * 0.14
            + out["brent_wti_spread_z_v53"].clip(-2, 2) * 0.12
            + out["brent_wti_spread_delta_z_v54"].clip(-2, 2) * 0.12
            + out["CL=F_mom_z"].clip(-2, 2) * 0.18
        )

    out["v53_q_core"] = (
        out["vol_compression"].clip(0, 1) * 0.35
        + out["cavity_score"].clip(0, 1) * 0.25
        + (1.0 / (1.0 + np.abs(out["ret_sign_4_sum"]))).clip(0, 1) * 0.15
        + (1.0 / (1.0 + np.abs(out["v53_sigma_ledger"]))).clip(0, 1) * 0.25
    ).fillna(0.0)
    out["v53_bsigma"] = (
        out["eta_noise"].clip(0, 5) * 0.24
        + out["range_z"].clip(0, 4) * 0.18
        + out["eia_event_risk"] * 0.25
        + np.maximum(0, -np.sign(out["v53_sigma_ledger"]) * np.sign(out["mom_2"])).fillna(0.0) * 0.18
        + np.abs(out["volume_z"]).clip(0, 3) * 0.05
    ).fillna(0.0)
    out["v53_c_cavity"] = (out["cavity_score"].clip(0, 1) * out["vol_compression"].clip(0, 1)).fillna(0.0)
    out["v53_phase_alignment"] = (np.sign(out["v53_sigma_ledger"]) * np.sign(out["mom_4"])).replace([np.inf, -np.inf], 0).fillna(0.0)
    out["v53_manifest_quality"] = (
        out["v53_q_core"].clip(0, 1) * 0.30
        + out["v53_c_cavity"].clip(0, 1) * 0.25
        + (1.0 / (1.0 + out["v53_bsigma"].clip(0, 5))) * 0.25
        + (0.5 + 0.5 * out["v53_phase_alignment"].clip(-1, 1)) * 0.20
    ).fillna(0.0)
    return out


def build_feature_cache() -> tuple[dict[tuple[str, str], pd.DataFrame], list[dict[str, Any]], dict[str, Any]]:
    eia, metadata = v40.load_eia_series(v40.SERIES)
    supply = v40.build_supply_features(eia)
    ng_storage, ng_meta = load_ng_storage_features()
    base_cache: dict[str, pd.DataFrame] = {}
    coverage: list[dict[str, Any]] = []
    for symbol in PEER_SYMBOLS:
        try:
            base = v51.load_base_bars(symbol)
            base_cache[symbol] = base
            coverage.append(
                {
                    "symbol": symbol,
                    "base_rows": len(base),
                    "start": base["timestamp"].min().isoformat() if len(base) else "",
                    "end": base["timestamp"].max().isoformat() if len(base) else "",
                    "status": "loaded" if len(base) else "empty",
                }
            )
        except Exception as exc:
            coverage.append({"symbol": symbol, "base_rows": 0, "status": "failed", "error": repr(exc)})

    if base_cache:
        start_ts = min(pd.Timestamp(frame["timestamp"].min()) for frame in base_cache.values() if len(frame))
        end_ts = max(pd.Timestamp(frame["timestamp"].max()) for frame in base_cache.values() if len(frame))
        weather, weather_meta = load_weather_basket_features(start_ts, end_ts)
    else:
        weather, weather_meta = pd.DataFrame(), {"status": "missing", "rows": 0}

    feature_cache: dict[tuple[str, str], pd.DataFrame] = {}
    for cadence, rule in ROUTE_FREQS:
        peers: dict[str, pd.DataFrame] = {}
        for symbol, base in base_cache.items():
            frame = v51.resample_bars(base, cadence, rule)
            if len(frame):
                peers[symbol] = frame
        for symbol in TARGET_SYMBOLS:
            if symbol not in peers:
                continue
            feat = v51.add_universal_features(peers[symbol])
            feat = attach_exogenous(feat, symbol, peers, supply, ng_storage, weather)
            feature_cache[(symbol, cadence)] = feat
    sensor_meta = {
        "petroleum_series": metadata,
        "natural_gas_storage": ng_meta,
        "weather_basket": weather_meta,
        "feature_note": "EIA petroleum surprise + EIA NG storage surprise + hourly city weather basket + crack/spread velocity + peer lag features",
    }
    return feature_cache, coverage, sensor_meta


BASE_FEATURES = [
    "bar_return",
    "mom_1",
    "mom_2",
    "mom_4",
    "mom_8",
    "mom_12",
    "range_pct",
    "body_pct",
    "volatility_8",
    "volatility_24",
    "volume_z",
    "range_z",
    "ret_z",
    "cavity_score",
    "eta_noise",
    "tod_sin",
    "tod_cos",
    "supply_pressure_score",
    "product_supply_score",
    "crude_stocks_change_z",
    "cushing_stocks_change_z",
    "gasoline_stocks_change_z",
    "distillate_stocks_change_z",
    "crude_production_change_z",
    "crude_imports_change_z",
    "refinery_utilization_change_z",
    "inventory_tightness",
    "production_tightness",
    "refinery_demand",
    "spread_support",
    "rb_crack_z",
    "ho_crack_z",
    "brent_wti_spread_z",
    "ng_oil_ratio_z",
    "ret_sign_1",
    "ret_sign_4_sum",
    "vol_compression",
    "season_sin",
    "season_cos",
    "heating_season_pressure",
    "cooling_season_pressure",
    "shoulder_season_flag",
    "driving_season_pressure",
    "injection_season_flag",
    "withdrawal_season_flag",
    "eia_petroleum_release_window",
    "eia_ng_storage_release_window",
    "crude_stocks_surprise_z",
    "cushing_stocks_surprise_z",
    "gasoline_stocks_surprise_z",
    "distillate_stocks_surprise_z",
    "crude_production_surprise_z",
    "crude_imports_surprise_z",
    "refinery_utilization_surprise_z",
    "refinery_inputs_surprise_z",
    "ng_storage_change_z",
    "ng_storage_deficit_z",
    "ng_storage_tightness",
    "ng_storage_surprise_z",
    "weather_basket_temp_f",
    "hdd_65_z",
    "cdd_65_z",
    "hdd_65_delta_6h_z",
    "cdd_65_delta_6h_z",
    "northeast_hdd_65_z",
    "northeast_hdd_65_delta_6h_z",
    "texas_cdd_65_z",
    "texas_cdd_65_delta_6h_z",
    "ng_weather_pressure",
    "rb_driving_weather",
    "ho_heating_weather",
    "rb_crack_z_v53",
    "ho_crack_z_v53",
    "ng_oil_ratio_z_v53",
    "brent_wti_spread_z_v53",
    "rb_ho_spread_z",
    "rb_crack_delta_z_v54",
    "ho_crack_delta_z_v54",
    "ng_oil_ratio_delta_z_v54",
    "brent_wti_spread_delta_z_v54",
    "rb_ho_spread_delta_z_v54",
    "v53_sigma_ledger",
    "v53_q_core",
    "v53_bsigma",
    "v53_c_cavity",
    "v53_phase_alignment",
    "v53_manifest_quality",
]


def feature_columns(symbol: str) -> list[str]:
    peer_cols: list[str] = []
    for peer in PEER_SYMBOLS:
        peer_cols.extend([f"{peer}_ret1", f"{peer}_ret2", f"{peer}_ret4", f"{peer}_mom_z"])
    if symbol == "NG=F":
        product = [
            "ng_storage_bcf",
            "ng_storage_change_z",
            "ng_storage_deficit_z",
            "ng_storage_tightness",
            "ng_storage_surprise_z",
            "ng_weather_pressure",
            "hdd_65_delta_6h_z",
            "cdd_65_delta_6h_z",
        ]
    elif symbol == "RB=F":
        product = [
            "gasoline_stocks_change_z",
            "gasoline_stocks_surprise_z",
            "rb_crack_z_v53",
            "rb_crack_delta_z_v54",
            "driving_season_pressure",
            "rb_driving_weather",
            "rb_ho_spread_z",
        ]
    elif symbol == "HO=F":
        product = [
            "distillate_stocks_change_z",
            "distillate_stocks_surprise_z",
            "ho_crack_z_v53",
            "ho_crack_delta_z_v54",
            "ho_heating_weather",
            "heating_season_pressure",
            "rb_ho_spread_z",
        ]
    else:
        product = [
            "crude_stocks_change_z",
            "cushing_stocks_change_z",
            "crude_stocks_surprise_z",
            "cushing_stocks_surprise_z",
            "refinery_inputs_surprise_z",
            "brent_wti_spread_z_v53",
            "brent_wti_spread_delta_z_v54",
            "refinery_demand",
        ]
    return list(dict.fromkeys(BASE_FEATURES + peer_cols + product))


def clean_df(feature_df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    out = feature_df.copy()
    cols = feature_columns(symbol)
    for col in cols:
        if col not in out:
            out[col] = 0.0
        out[col] = pd.to_numeric(out[col], errors="coerce").replace([np.inf, -np.inf], np.nan).ffill().fillna(0.0)
    out["future_return"] = out["close"].shift(-1) / out["close"] - 1.0
    out["next_bar_return"] = out["future_return"]
    out = out.dropna(subset=["future_return", "next_bar_return"]).reset_index(drop=True)
    return out


def train_models(train_df: pd.DataFrame, symbol: str) -> dict[str, Any]:
    cols = feature_columns(symbol)
    x = train_df[cols].to_numpy(dtype=float)
    y = (train_df["future_return"].to_numpy(dtype=float) > 0).astype(int)
    models: dict[str, Any] = {}
    if len(train_df) < 80 or len(np.unique(y)) < 2:
        return models
    models["logit_balanced"] = make_pipeline(
        StandardScaler(),
        LogisticRegression(C=0.35, class_weight="balanced", max_iter=2500, random_state=42),
    ).fit(x, y)
    models["extra_trees"] = ExtraTreesClassifier(
        n_estimators=160,
        max_depth=5,
        min_samples_leaf=10,
        random_state=42,
        class_weight="balanced",
    ).fit(x, y)
    models["hist_gb"] = HistGradientBoostingClassifier(
        max_iter=80,
        learning_rate=0.04,
        max_leaf_nodes=7,
        l2_regularization=0.35,
        min_samples_leaf=18,
        random_state=42,
    ).fit(x, y)
    return models


def predict_model_scores(df: pd.DataFrame, symbol: str, models: dict[str, Any]) -> pd.DataFrame:
    cols = feature_columns(symbol)
    x = df[cols].to_numpy(dtype=float)
    out = df.copy()
    probs: list[np.ndarray] = []
    for name, model in models.items():
        p = model.predict_proba(x)[:, 1]
        out[f"{name}_prob_up"] = p
        probs.append(p)
    if probs:
        stack = np.vstack(probs)
        out["ensemble_prob_up"] = np.mean(stack, axis=0)
        votes = (stack >= 0.5).astype(int)
        up_votes = votes.sum(axis=0)
        out["ensemble_consensus"] = np.maximum(up_votes, len(probs) - up_votes)
    else:
        out["ensemble_prob_up"] = 0.5
        out["ensemble_consensus"] = 0
    return out


def target_units(row: pd.Series, policy: ExogenousPolicy) -> int:
    if policy.model_name == "ensemble":
        p = float(row["ensemble_prob_up"])
        consensus = int(row.get("ensemble_consensus", 0))
    else:
        p = float(row[f"{policy.model_name}_prob_up"])
        consensus = 4
    confidence = max(p, 1.0 - p)
    if confidence < policy.confidence_threshold:
        return 0
    if consensus < policy.min_consensus:
        return 0
    if float(row.get("v53_manifest_quality", 0.0)) < policy.min_hfcd_quality:
        return 0
    if float(row.get("v53_bsigma", 0.0)) > 3.2 and confidence < policy.confidence_threshold + 0.08:
        return 0
    extra = int((confidence - policy.confidence_threshold) / 0.08)
    units = min(policy.max_units, 1 + max(0, extra))
    return units if p >= 0.5 else -units


def replay(df: pd.DataFrame, policy: ExogenousPolicy) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cost_rate = v51.trade_cost(policy.symbol, policy.cadence)
    position = 0
    rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    for i in range(len(df) - 1):
        row = df.iloc[i]
        ts = pd.Timestamp(row["timestamp"])
        desired = target_units(row, policy)
        delta = desired - position
        action = "hold"
        if delta != 0:
            if position == 0 and desired != 0:
                action = "open_long" if desired > 0 else "open_short"
            elif desired == 0:
                action = "flat"
            elif np.sign(desired) != np.sign(position):
                action = "reverse_to_long" if desired > 0 else "reverse_to_short"
            elif abs(desired) > abs(position):
                action = "add_long" if desired > 0 else "add_short"
            else:
                action = "reduce_long" if position > 0 else "reduce_short"
            events.append(
                {
                    "policy": policy.name,
                    "symbol": policy.symbol,
                    "cadence": policy.cadence,
                    "timestamp": ts.isoformat(),
                    "action": action,
                    "from_units": position,
                    "to_units": desired,
                    "close": round(float(row["close"]), 6),
                    "manifest_quality": round(float(row.get("v53_manifest_quality", 0.0)), 6),
                }
            )
        pnl_before_cost = desired * BASE_NOTIONAL_USD * float(row["next_bar_return"])
        turnover_cost = abs(delta) * BASE_NOTIONAL_USD * cost_rate
        pnl = pnl_before_cost - turnover_cost
        active = int(desired != 0)
        direction_hit = int(np.sign(desired) == np.sign(float(row["future_return"]))) if active else 0
        rows.append(
            {
                "policy": policy.name,
                "symbol": policy.symbol,
                "cadence": policy.cadence,
                "timestamp": ts.isoformat(),
                "close": round(float(row["close"]), 6),
                "decision": "long" if desired > 0 else ("short" if desired < 0 else "flat"),
                "position_units_before": position,
                "position_units_after": desired,
                "action": action,
                "model_name": policy.model_name,
                "confidence_threshold": policy.confidence_threshold,
                "min_consensus": policy.min_consensus,
                "min_hfcd_quality": policy.min_hfcd_quality,
                "future_return": round(float(row["future_return"]), 8),
                "direction_signal_active": active,
                "direction_hit": direction_hit,
                "manifest_quality": round(float(row.get("v53_manifest_quality", 0.0)), 6),
                "sigma_ledger": round(float(row.get("v53_sigma_ledger", 0.0)), 6),
                "q_core": round(float(row.get("v53_q_core", 0.0)), 6),
                "bsigma": round(float(row.get("v53_bsigma", 0.0)), 6),
                "pnl_before_cost_usd": round(float(pnl_before_cost), 6),
                "turnover_cost_usd": round(float(turnover_cost), 6),
                "pnl_usd": round(float(pnl), 6),
                "notional_per_unit_usd": BASE_NOTIONAL_USD,
                "gross_exposure_usd": abs(desired) * BASE_NOTIONAL_USD,
            }
        )
        position = desired
    return rows, events


def summarize(rows: list[dict[str, Any]], policy: ExogenousPolicy, split: str) -> dict[str, Any]:
    sub = [r for r in rows if r["split"] == split]
    pnls = [float(r["pnl_usd"]) for r in sub]
    active = [r for r in sub if int(r["direction_signal_active"]) == 1]
    events = [r for r in sub if r["action"] != "hold"]
    days = max(
        1e-9,
        (pd.Timestamp(sub[-1]["timestamp"]) - pd.Timestamp(sub[0]["timestamp"])).total_seconds() / 86400
        if len(sub) >= 2
        else 0.0,
    )
    return {
        "policy": policy.name,
        "symbol": policy.symbol,
        "cadence": policy.cadence,
        "model_name": policy.model_name,
        "confidence_threshold": policy.confidence_threshold,
        "min_consensus": policy.min_consensus,
        "min_hfcd_quality": policy.min_hfcd_quality,
        "max_units": policy.max_units,
        "split": split,
        "bars": len(sub),
        "actions": len(events),
        "actions_per_day": round(len(events) / days, 6) if sub else 0.0,
        "active_signal_bars": len(active),
        "active_signal_rate": round(len(active) / len(sub), 6) if sub else 0.0,
        "long_bars": sum(1 for r in sub if int(r["position_units_after"]) > 0),
        "short_bars": sum(1 for r in sub if int(r["position_units_after"]) < 0),
        "flat_bars": sum(1 for r in sub if int(r["position_units_after"]) == 0),
        "direction_hit_rate": round(sum(int(r["direction_hit"]) for r in active) / len(active), 6) if active else 0.0,
        "net_pnl_usd": round(sum(pnls), 6),
        "profit_factor": round(profit_factor(pnls), 6),
        "max_drawdown_usd": round(max_drawdown_from_pnls(pnls), 6),
        "turnover_cost_usd": round(sum(float(r["turnover_cost_usd"]) for r in sub), 6),
    }


def evaluate(feature_df: pd.DataFrame, symbol: str, cadence: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    df = clean_df(feature_df, symbol)
    if len(df) < 100:
        return [], [], []
    cut1, cut2 = split_masks(pd.to_datetime(df["timestamp"], utc=True))
    train = df[pd.to_datetime(df["timestamp"], utc=True) <= cut1]
    models = train_models(train, symbol)
    if not models:
        return [], [], []
    pred = predict_model_scores(df, symbol, models)
    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    model_names = list(models.keys()) + ["ensemble"]
    thresholds = [0.56, 0.62, 0.68, 0.74]
    quality_gates = [0.00, 0.45]
    for model_name in model_names:
        for threshold in thresholds:
            for consensus in ([2, 3] if model_name == "ensemble" else [1]):
                for quality in quality_gates:
                    for max_units in [1, 2]:
                        policy = ExogenousPolicy(symbol, cadence, model_name, threshold, consensus, quality, max_units)
                        rows, events = replay(pred, policy)
                        for row in rows:
                            row["split"] = split_name(pd.Timestamp(row["timestamp"]), cut1, cut2)
                        for event in events:
                            event["split"] = split_name(pd.Timestamp(event["timestamp"]), cut1, cut2)
                        by_split = {split: summarize(rows, policy, split) for split in ["train", "validation", "test"]}
                        combined: dict[str, Any] = {
                            "policy": policy.name,
                            "symbol": symbol,
                            "cadence": cadence,
                            "model_name": model_name,
                            "confidence_threshold": threshold,
                            "min_consensus": consensus,
                            "min_hfcd_quality": quality,
                            "max_units": max_units,
                        }
                        for split, vals in by_split.items():
                            for k, v in vals.items():
                                if k in combined or k in {"policy", "symbol", "cadence", "model_name", "split"}:
                                    continue
                                combined[f"{split}_{k}"] = v
                        val = by_split["validation"]
                        test = by_split["test"]
                        combined["target70_status"] = (
                            "target70_blind_confirmed"
                            if val["active_signal_bars"] >= 8
                            and test["active_signal_bars"] >= 5
                            and val["direction_hit_rate"] >= 0.68
                            and test["direction_hit_rate"] >= 0.68
                            and val["profit_factor"] >= 1.0
                            and test["profit_factor"] >= 1.0
                            else "not_target70"
                        )
                        combined["stable65_status"] = (
                            "stable65_candidate"
                            if val["active_signal_bars"] >= 12
                            and test["active_signal_bars"] >= 10
                            and val["direction_hit_rate"] >= 0.64
                            and test["direction_hit_rate"] >= 0.64
                            and val["profit_factor"] >= 1.0
                            and test["profit_factor"] >= 1.0
                            else "watchlist_or_blocked"
                        )
                        combined["selection_score"] = round(
                            120.0 * min(val["direction_hit_rate"], test["direction_hit_rate"])
                            + 20.0 * test["direction_hit_rate"]
                            + 10.0 * min(val["profit_factor"], 4.0)
                            + 10.0 * min(test["profit_factor"], 4.0)
                            + 2.0 * min(test["actions_per_day"], 8.0)
                            - abs(test["max_drawdown_usd"]) * 0.025
                            + 0.10 * test["net_pnl_usd"],
                            6,
                        )
                        summaries.append(combined)
                        all_rows.extend(rows)
                        all_events.extend(events)
    return all_rows, all_events, summaries


def select_routes(summary_df: pd.DataFrame) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    if summary_df.empty:
        return selected
    for (symbol, cadence), group in summary_df.groupby(["symbol", "cadence"], sort=False):
        candidates = group[group["target70_status"] == "target70_blind_confirmed"].sort_values("selection_score", ascending=False)
        if candidates.empty:
            candidates = group[group["stable65_status"] == "stable65_candidate"].sort_values("selection_score", ascending=False)
        if not candidates.empty:
            selected.append(candidates.iloc[0].to_dict())
    return sorted(selected, key=lambda r: (float(r.get("test_direction_hit_rate", 0)), float(r.get("test_profit_factor", 0))), reverse=True)


def make_report(run_summary: dict[str, Any], selected: list[dict[str, Any]], best_by_route: list[dict[str, Any]]) -> str:
    lines = [
        f"# {VERSION}",
        "",
        "## 结论",
        "",
        f"- 状态：`{run_summary['status']}`",
        f"- 路线总数：`{run_summary['route_count']}`；70%确认路线：`{run_summary['target70_count']}`；稳定65候选：`{run_summary['candidate_count']}`。",
        "- 本轮新增外生传感器：小时级城市天气篮子、HDD/CDD、EIA库存预期差、天然气库存预期差、裂解价差速度、Brent-WTI速度、跨品种滞后、HFCD Q/C/Bsigma/Manifest 门。",
        "- 模型只用 train 训练，阈值只看 validation 选择，test 是盲测。",
        "",
        "## 选中路线",
        "",
    ]
    if selected:
        lines.append("| 标的 | 周期 | 模型 | 阈值 | 共识 | 质量门 | 验证命中/PF | 测试命中/PF | 动作/天 | 测试PNL | 回撤 |")
        lines.append("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|")
        for r in selected:
            lines.append(
                f"| {r['symbol']} | {r['cadence']} | {r['model_name']} | {float(r['confidence_threshold']):.2f} | "
                f"{int(r['min_consensus'])} | {float(r['min_hfcd_quality']):.2f} | "
                f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
                f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
                f"{float(r['test_actions_per_day']):.2f} | {float(r['test_net_pnl_usd']):.2f} | {float(r['test_max_drawdown_usd']):.2f} |"
            )
    else:
        lines.append("没有路线同时通过验证段和盲测段。")
    lines += ["", "## 每条路线 validation-first 最优", ""]
    lines.append("| 标的 | 周期 | 模型 | 验证命中/PF | 测试命中/PF | 动作/天 | 测试PNL | 状态 |")
    lines.append("|---|---:|---|---:|---:|---:|---:|---|")
    for r in best_by_route:
        lines.append(
            f"| {r['symbol']} | {r['cadence']} | {r['model_name']} | "
            f"{float(r['validation_direction_hit_rate']):.2%}/{float(r['validation_profit_factor']):.2f} | "
            f"{float(r['test_direction_hit_rate']):.2%}/{float(r['test_profit_factor']):.2f} | "
            f"{float(r['test_actions_per_day']):.2f} | {float(r['test_net_pnl_usd']):.2f} | {r['stable65_status']} |"
        )
    lines += [
        "",
        "## 判断",
        "",
        "- 70%左右必须由 validation 和 blind test 同时支持；单独 test 高命中不晋级。",
        "- 如果候选动作/天太低，它仍是狙击型，不是电力式高频。",
        "- 如果本轮仍不到 65%-70%，下一步不能继续调阈值，应接更真实的合约期限结构、库存市场预期和更长历史。",
        "",
        "## 下一步行动计划",
        "",
        "若 V5.4 仍未产生稳定 70% 候选，V5.5 应接真实合约期限结构曲线、第三方库存预期差、NOAA/交易时可用天气预报，而不是继续用同类代理微调。",
        "",
    ]
    return "\n".join(lines)


def plot_results(selected: list[dict[str, Any]], best_by_route: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(2, 1, figsize=(14, 9), constrained_layout=True)
    labels = [f"{r['symbol']} {r['cadence']}" for r in best_by_route]
    vals = [float(r.get("test_direction_hit_rate", 0)) for r in best_by_route]
    axes[0].bar(labels, vals, color=["#059669" if v >= 0.68 else "#f59e0b" if v >= 0.64 else "#64748b" for v in vals])
    axes[0].axhline(0.70, color="#dc2626", linestyle="--", label="70% target")
    axes[0].axhline(0.64, color="#0891b2", linestyle="--", label="stable65 floor")
    axes[0].set_ylim(0, 1)
    axes[0].set_title("V5.4 blind-test direction hit rate by validation-first route")
    axes[0].tick_params(axis="x", rotation=45)
    axes[0].legend()
    axes[0].grid(axis="y", alpha=0.25)

    if selected:
        labels2 = [f"{r['symbol']} {r['cadence']}" for r in selected]
        vals2 = [float(r.get("test_actions_per_day", 0)) for r in selected]
        axes[1].bar(labels2, vals2, color="#10b981")
    axes[1].set_title("Selected route action density per day")
    axes[1].grid(axis="y", alpha=0.25)
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main() -> None:
    started = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    feature_cache, data_coverage, sensor_meta = build_feature_cache()
    all_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    all_summaries: list[dict[str, Any]] = []
    for (symbol, cadence), features in feature_cache.items():
        rows, events, summaries = evaluate(features, symbol, cadence)
        all_rows.extend(rows)
        all_events.extend(events)
        all_summaries.extend(summaries)
        print(f"[{VERSION}] evaluated {symbol} {cadence}: rows={len(features)} policies={len(summaries)}", flush=True)

    summary_df = pd.DataFrame(all_summaries)
    if not summary_df.empty:
        summary_df = summary_df.sort_values(["target70_status", "stable65_status", "selection_score"], ascending=[True, True, False])
    selected = select_routes(summary_df)
    best_by_route: list[dict[str, Any]] = []
    if not summary_df.empty:
        for (_, _), group in summary_df.groupby(["symbol", "cadence"], sort=False):
            eligible = group[group["validation_active_signal_bars"] >= 5]
            if eligible.empty:
                eligible = group
            best = eligible.sort_values(
                ["validation_direction_hit_rate", "validation_profit_factor", "test_direction_hit_rate", "test_profit_factor"],
                ascending=False,
            ).iloc[0]
            best_by_route.append(best.to_dict())
    status = "real_exogenous_candidates" if selected else "real_exogenous_watchlist_no_candidate"
    target70_count = int(sum(1 for r in selected if r.get("target70_status") == "target70_blind_confirmed"))

    write_csv(OUT_DIR / "hfcd_commodity_v5_4_data_coverage.csv", data_coverage)
    summary_df.to_csv(OUT_DIR / "hfcd_commodity_v5_4_policy_summary.csv", index=False)
    write_csv(OUT_DIR / "hfcd_commodity_v5_4_selected_routes.csv", selected, list(summary_df.columns))
    write_csv(OUT_DIR / "hfcd_commodity_v5_4_best_by_route.csv", best_by_route)
    write_csv(OUT_DIR / "hfcd_commodity_v5_4_bar_replay.csv", all_rows)
    write_csv(OUT_DIR / "hfcd_commodity_v5_4_position_events.csv", all_events)

    report_path = OUT_DIR / "HFCD_Commodity_V5_4_RealExogenousHitRateLift.md"
    chart_path = OUT_DIR / "HFCD_Commodity_V5_4_RealExogenousHitRateLift.png"
    run_summary = {
        "version": VERSION,
        "generated_at": now_iso(),
        "runtime_seconds": round(time.time() - started, 3),
        "status": status,
        "route_count": len(all_summaries),
        "candidate_count": len(selected),
        "target70_count": target70_count,
        "best_validation_hit_rate": float(summary_df["validation_direction_hit_rate"].max()) if not summary_df.empty else None,
        "best_test_hit_rate": float(summary_df["test_direction_hit_rate"].max()) if not summary_df.empty else None,
        "report": str(report_path),
        "chart": str(chart_path),
        "selected_routes": selected,
        "best_by_route": best_by_route,
        "data_coverage": data_coverage,
        "sensor_meta": sensor_meta,
        "notes": [
            "Local research only; no exchange orders.",
            "Exogenous sensor lift: EIA petroleum surprises, EIA NG storage surprises, city weather basket, event windows, crack/spread velocity, HFCD gates.",
            "Train-only models, validation-selected thresholds, blind test audit.",
        ],
    }
    (OUT_DIR / "hfcd_commodity_v5_4_summary.json").write_text(json.dumps(run_summary, ensure_ascii=False, indent=2), encoding="utf-8")
    report_path.write_text(make_report(run_summary, selected, best_by_route), encoding="utf-8")
    plot_results(selected, best_by_route, chart_path)
    print(json.dumps({"status": status, "candidate_count": len(selected), "target70_count": target70_count, "out_dir": str(OUT_DIR)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
