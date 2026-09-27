from __future__ import annotations

import io
import json
import math
import os
import zipfile
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import requests
from sklearn.compose import TransformedTargetRegressor
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBRegressor

ARTIFACT_DIR = Path(os.environ.get("MODEL_DIR", "model_artifacts"))
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

UCI_ZIP = "https://archive.ics.uci.edu/static/public/849/power%2Bconsumption%2Bof%2Btetouan%2Bcity.zip"
MIRROR_CSV = "https://raw.githubusercontent.com/sunny2309/datasets/master/Tetuan%20City%20power%20consumption.csv"
EXPECTED_COLS = [
    "DateTime",
    "Temperature",
    "Humidity",
    "Wind Speed",
    "general diffuse flows",
    "diffuse flows",
    "Zone 1 Power Consumption",
]
FEATURES = [
    "Temperature",
    "Humidity",
    "Wind Speed",
    "general diffuse flows",
    "diffuse flows",
    "hour_sin",
    "hour_cos",
    "dow_sin",
    "dow_cos",
    "month_sin",
    "month_cos",
]


def download_dataset() -> tuple[pd.DataFrame, str]:
    errors = []
    try:
        r = requests.get(UCI_ZIP, timeout=60)
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
            csv_names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
            if not csv_names:
                raise RuntimeError("No CSV found in UCI archive")
            with zf.open(csv_names[0]) as fh:
                df = pd.read_csv(fh)
        return df, "UCI Machine Learning Repository"
    except Exception as exc:
        errors.append(f"UCI: {exc}")

    try:
        r = requests.get(MIRROR_CSV, timeout=60)
        r.raise_for_status()
        df = pd.read_csv(io.BytesIO(r.content))
        return df, "GitHub mirror of UCI Tetouan dataset"
    except Exception as exc:
        errors.append(f"mirror: {exc}")

    raise RuntimeError("Could not download training data: " + " | ".join(errors))


def prepare(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, dict]:
    missing = [c for c in EXPECTED_COLS if c not in df.columns]
    if missing:
        raise RuntimeError(f"Unexpected dataset schema. Missing: {missing}")
    if len(df) < 50000:
        raise RuntimeError(f"Dataset unexpectedly small: {len(df)} rows")

    work = df.copy()
    work["DateTime"] = pd.to_datetime(work["DateTime"], dayfirst=True, errors="coerce")
    work = work.dropna(subset=["DateTime"])

    numeric_cols = [
        "Temperature",
        "Humidity",
        "Wind Speed",
        "general diffuse flows",
        "diffuse flows",
        "Zone 1 Power Consumption",
    ]
    for c in numeric_cols:
        work[c] = pd.to_numeric(work[c], errors="coerce")
    work = work.dropna(subset=numeric_cols)

    # Convert 10-minute measurements to an hourly profile. Weather and power values
    # are averaged within each clock hour to create a stable forecasting target.
    work["hour_ts"] = work["DateTime"].dt.floor("h")
    hourly = work.groupby("hour_ts", as_index=False)[numeric_cols].mean()

    dt = hourly["hour_ts"]
    hour = dt.dt.hour.astype(float)
    dow = dt.dt.dayofweek.astype(float)
    month = dt.dt.month.astype(float)

    hourly["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)
    hourly["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)
    hourly["dow_sin"] = np.sin(2 * np.pi * dow / 7.0)
    hourly["dow_cos"] = np.cos(2 * np.pi * dow / 7.0)
    hourly["month_sin"] = np.sin(2 * np.pi * (month - 1) / 12.0)
    hourly["month_cos"] = np.cos(2 * np.pi * (month - 1) / 12.0)

    mean_zone = float(hourly["Zone 1 Power Consumption"].mean())
    hourly["load_factor"] = hourly["Zone 1 Power Consumption"] / mean_zone

    X = hourly[FEATURES].astype(float)
    y = hourly["load_factor"].astype(float)

    meta = {
        "rawRows": int(len(df)),
        "hourlyRows": int(len(hourly)),
        "start": str(hourly["hour_ts"].min()),
        "end": str(hourly["hour_ts"].max()),
        "zone1MeanPower": mean_zone,
        "target": "Zone 1 Power Consumption normalized to load factor",
        "features": FEATURES,
        "aggregation": "10-minute records averaged to hourly",
    }
    return X, y, meta


def metrics(y_true, y_pred) -> dict:
    mae = float(mean_absolute_error(y_true, y_pred))
    rmse = float(math.sqrt(mean_squared_error(y_true, y_pred)))
    r2 = float(r2_score(y_true, y_pred))
    denom = np.maximum(np.abs(np.asarray(y_true)), 1e-6)
    mape = float(np.mean(np.abs((np.asarray(y_true) - np.asarray(y_pred)) / denom)) * 100)
    return {"MAE": mae, "RMSE": rmse, "R2": r2, "MAPE_pct": mape}


def train() -> dict:
    df, source = download_dataset()
    X, y, data_meta = prepare(df)

    # Chronological holdout: last 20% is never used for training.
    split = int(len(X) * 0.80)
    X_train, X_test = X.iloc[:split], X.iloc[split:]
    y_train, y_test = y.iloc[:split], y.iloc[split:]

    models = {
        "ridge": Pipeline([
            ("scale", StandardScaler()),
            ("model", Ridge(alpha=1.0)),
        ]),
        "random_forest": RandomForestRegressor(
            n_estimators=220,
            max_depth=18,
            min_samples_leaf=2,
            max_features=0.85,
            n_jobs=-1,
            random_state=42,
        ),
        "xgboost": XGBRegressor(
            n_estimators=500,
            max_depth=6,
            learning_rate=0.035,
            subsample=0.90,
            colsample_bytree=0.90,
            reg_lambda=1.2,
            objective="reg:squarederror",
            tree_method="hist",
            n_jobs=2,
            random_state=42,
        ),
    }

    results = {}
    trained = {}
    for name, model in models.items():
        model.fit(X_train, y_train)
        pred = np.clip(model.predict(X_test), 0.20, 3.0)
        results[name] = metrics(y_test, pred)
        trained[name] = model
        print(name, json.dumps(results[name]))

    best_name = min(results, key=lambda n: results[n]["MAE"])
    best_model = trained[best_name]
    joblib.dump(best_model, ARTIFACT_DIR / "load_factor_model.joblib")

    meta = {
        "modelVersion": "tetouan-load-factor-v1",
        "bestModel": best_name,
        "trained": True,
        "dataset": {
            "name": "Power Consumption of Tetouan City",
            "source": source,
            "officialUrl": "https://archive.ics.uci.edu/dataset/849/power+consumption+of+tetouan+city",
            "doi": "10.24432/C5B034",
            "license": "CC BY 4.0",
            **data_meta,
        },
        "split": {
            "type": "chronological",
            "trainRows": int(len(X_train)),
            "testRows": int(len(X_test)),
            "trainFraction": 0.80,
        },
        "metrics": results,
        "selectedBy": "lowest holdout MAE",
        "limitations": [
            "The training population is Tetouan, Morocco (2017), not Hanoi or the user's own meter.",
            "Predictions are normalized load factors and are scaled by the user's baseLoadKw.",
            "This model should be retrained with local smart-meter history before operational deployment.",
        ],
        "featureOrder": FEATURES,
    }
    (ARTIFACT_DIR / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(json.dumps(meta, indent=2))
    return meta


if __name__ == "__main__":
    train()
