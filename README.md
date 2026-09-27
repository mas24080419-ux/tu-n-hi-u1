# EnergyGuard API

Independent backend for the EnergyGuard smart-energy website.

## Live service

- API: https://energyguard-api.onrender.com
- Frontend: https://energyguard-ai.onrender.com

## Endpoints

- `GET /health` — service health
- `GET /api/status` — integrations and model status
- `GET /api/weather?lat=&lon=&days=&capacity_kwp=` — Open-Meteo weather + transparent PV estimate
- `GET /api/nasa/history?lat=&lon=&start=&end=` — NASA POWER daily solar/temperature history
- `POST /api/predict/load` — transparent baseline load forecast (not presented as trained ML)
- `POST /api/optimize/bess` — battery self-consumption optimizer
- `POST /api/advisor` — rule-based energy recommendations
- `GET /api/auth/google/config` — Google OAuth readiness
- `POST /api/auth/google/verify` — verifies Google ID token when `GOOGLE_CLIENT_ID` is configured
- `POST /api/contact` — contact intake; currently temporary memory until a database URL is attached

## Data integrity

EnergyGuard does not invent weather measurements. If the Render-hosted Open-Meteo proxy is rate-limited, the frontend falls back to a direct browser request to Open-Meteo. The PV estimate is explicitly labelled as an engineering estimate from irradiance, installed capacity, derating and temperature correction.

The load model is intentionally labelled `transparent-baseline-v1` and `trained: false` until real smart-meter history is provided. A production ML model should only be trained and benchmarked after sufficient historical load data is available.

## Separation from FloodGuard

This backend is deployed from a separate repository and Render service. It does not modify or share runtime code with FloodGuard.
