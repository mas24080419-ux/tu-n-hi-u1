from __future__ import annotations

import json
import math
import os
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from flask import Flask, jsonify, request

MODEL_DIR = Path(os.environ.get("MODEL_DIR", "model_artifacts"))
MODEL_PATH = MODEL_DIR / "load_factor_model.joblib"
META_PATH = MODEL_DIR / "metadata.json"
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "https://energyguard-ai.onrender.com")

if not MODEL_PATH.exists() or not META_PATH.exists():
    raise RuntimeError("ML artifacts are missing. Run train_model.py during build.")

model = joblib.load(MODEL_PATH)
metadata = json.loads(META_PATH.read_text(encoding="utf-8"))
FEATURES = metadata["featureOrder"]

app = Flask(__name__)


def clamp(v, lo, hi):
    return min(hi, max(lo, v))


def num(v, default):
    try:
        x = float(v)
        return x if math.isfinite(x) else default
    except (TypeError, ValueError):
        return default


def feature_row(r: dict, i: int) -> dict:
    hour = int(clamp(round(num(r.get("hour"), i % 24)), 0, 23))
    weekday = int(clamp(round(num(r.get("weekday"), 1)), 0, 6))
    month = int(clamp(round(num(r.get("month"), 1)), 1, 12))
    temp = clamp(num(r.get("temperatureC"), 25), -20, 60)
    humidity = clamp(num(r.get("humidityPct"), 60), 0, 100)
    # Open-Meteo defaults wind speed to km/h. Tetouan's historical field is treated
    # as m/s for transfer, so convert unless the caller explicitly supplies m/s.
    wind_kmh = clamp(num(r.get("windSpeedKmh"), 7.2), 0, 180)
    wind_ms = clamp(num(r.get("windSpeedMs"), wind_kmh / 3.6), 0, 50)
    ghi = clamp(num(r.get("ghiWm2"), 0), 0, 1400)
    diffuse = clamp(num(r.get("diffuseWm2"), ghi * 0.35), 0, 1400)

    return {
        "Temperature": temp,
        "Humidity": humidity,
        "Wind Speed": wind_ms,
        "general diffuse flows": ghi,
        "diffuse flows": diffuse,
        "hour_sin": math.sin(2 * math.pi * hour / 24.0),
        "hour_cos": math.cos(2 * math.pi * hour / 24.0),
        "dow_sin": math.sin(2 * math.pi * weekday / 7.0),
        "dow_cos": math.cos(2 * math.pi * weekday / 7.0),
        "month_sin": math.sin(2 * math.pi * (month - 1) / 12.0),
        "month_cos": math.cos(2 * math.pi * (month - 1) / 12.0),
    }


@app.after_request
def cors(resp):
    origin = request.headers.get("Origin", "")
    if origin == FRONTEND_ORIGIN or origin.startswith("http://localhost") or origin.startswith("http://127.0.0.1"):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "service": "energyguard-ml",
        "modelVersion": metadata["modelVersion"],
        "bestModel": metadata["bestModel"],
    })


@app.route("/metrics")
def metrics():
    return jsonify(metadata)


@app.route("/predict", methods=["POST", "OPTIONS"])
def predict():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    base_load_kw = clamp(num(body.get("baseLoadKw"), 1.0), 0.05, 10000)
    hours = body.get("hours")
    if not isinstance(hours, list) or not hours or len(hours) > 336:
        return jsonify({"error": "hours must be an array with 1-336 points"}), 400

    frame = pd.DataFrame([feature_row(r if isinstance(r, dict) else {}, i) for i, r in enumerate(hours)])
    frame = frame[FEATURES]
    factors = np.clip(np.asarray(model.predict(frame), dtype=float), 0.20, 3.0)
    forecast = []
    for i, factor in enumerate(factors):
        hour = int(clamp(round(num((hours[i] or {}).get("hour") if isinstance(hours[i], dict) else None, i % 24)), 0, 23))
        forecast.append({
            "index": i,
            "hour": hour,
            "loadFactor": round(float(factor), 4),
            "predictedLoadKw": round(float(factor * base_load_kw), 3),
        })

    return jsonify({
        "model": metadata["modelVersion"],
        "algorithm": metadata["bestModel"],
        "trained": True,
        "baseLoadKw": base_load_kw,
        "forecast": forecast,
        "benchmark": metadata["metrics"],
        "dataset": {
            "name": metadata["dataset"]["name"],
            "doi": metadata["dataset"]["doi"],
            "license": metadata["dataset"]["license"],
        },
        "limitations": metadata["limitations"],
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "10000"))
    app.run(host="0.0.0.0", port=port)
