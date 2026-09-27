const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 10000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://energyguard-ai.onrender.com';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const memoryContacts = [];
const rateBuckets = new Map();

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = origin === FRONTEND_ORIGIN || /^http:\/\/localhost(?::\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function round(v, digits = 3) { const p = 10 ** digits; return Math.round(v * p) / p; }

function rateLimit(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
  const now = Date.now();
  const key = `${ip}:${Math.floor(now / 60000)}`;
  const count = (rateBuckets.get(key) || 0) + 1;
  rateBuckets.set(key, count);
  if (rateBuckets.size > 3000) {
    for (const k of rateBuckets.keys()) if (!k.endsWith(String(Math.floor(now / 60000)))) rateBuckets.delete(k);
  }
  return count <= 120;
}

function readJson(req, maxBytes = 256_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validateCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'EnergyGuard/1.0' } });
    if (!r.ok) throw new Error(`Upstream HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

function estimatePvOutput(ghi, temperature, capacityKwp, derate) {
  const irradianceFactor = clamp(num(ghi, 0) / 1000, 0, 1.25);
  const tempPenalty = temperature > 25 ? clamp(1 - (temperature - 25) * 0.004, 0.82, 1) : 1;
  return round(capacityKwp * irradianceFactor * derate * tempPenalty, 3);
}

function baselineLoad(hour, temperature, humidity, weekday, baseLoadKw) {
  const morning = Math.exp(-((hour - 7.5) ** 2) / 7);
  const evening = Math.exp(-((hour - 19.5) ** 2) / 9);
  const midday = Math.exp(-((hour - 13.5) ** 2) / 14);
  const cooling = Math.max(0, temperature - 27) * 0.055;
  const humid = Math.max(0, humidity - 70) * 0.006;
  const weekend = [0, 6].includes(weekday) ? 0.12 : 0;
  return round(Math.max(0.15, baseLoadKw * (0.55 + 0.55 * morning + 0.95 * evening + 0.25 * midday + cooling + humid + weekend)), 3);
}

function optimizeBess(input) {
  const solar = Array.isArray(input.solarKw) ? input.solarKw.map(v => Math.max(0, num(v, 0))) : [];
  const load = Array.isArray(input.loadKw) ? input.loadKw.map(v => Math.max(0, num(v, 0))) : [];
  if (!solar.length || solar.length !== load.length || solar.length > 336) throw Object.assign(new Error('solarKw and loadKw must be equal-length arrays (1–336 points).'), { status: 400 });

  const cap = clamp(num(input.batteryCapacityKwh, 10), 0.5, 10000);
  const minSoc = clamp(num(input.minSocPct, 15), 0, 95) / 100;
  const maxSoc = clamp(num(input.maxSocPct, 95), minSoc * 100 + 1, 100) / 100;
  let energy = clamp(num(input.initialSocPct, 50) / 100, minSoc, maxSoc) * cap;
  const maxCharge = clamp(num(input.maxChargeKw, cap / 2), 0.1, cap * 2);
  const maxDischarge = clamp(num(input.maxDischargeKw, cap / 2), 0.1, cap * 2);
  const rtEff = clamp(num(input.roundTripEfficiency, 0.90), 0.5, 0.99);
  const chargeEff = Math.sqrt(rtEff);
  const dischargeEff = Math.sqrt(rtEff);
  const stepHours = clamp(num(input.stepHours, 1), 0.0833, 4);

  let totalImport = 0, totalExport = 0, totalCharge = 0, totalDischarge = 0;
  const schedule = [];

  for (let i = 0; i < solar.length; i++) {
    const s = solar[i], l = load[i];
    const net = s - l;
    let chargeKw = 0, dischargeKw = 0, gridImportKw = 0, gridExportKw = 0;

    if (net > 0) {
      const storageRoom = Math.max(0, maxSoc * cap - energy);
      chargeKw = Math.min(net, maxCharge, storageRoom / (chargeEff * stepHours));
      energy += chargeKw * chargeEff * stepHours;
      gridExportKw = Math.max(0, net - chargeKw);
    } else if (net < 0) {
      const deficit = -net;
      const available = Math.max(0, energy - minSoc * cap);
      dischargeKw = Math.min(deficit, maxDischarge, available * dischargeEff / stepHours);
      energy -= (dischargeKw / dischargeEff) * stepHours;
      gridImportKw = Math.max(0, deficit - dischargeKw);
    }

    totalImport += gridImportKw * stepHours;
    totalExport += gridExportKw * stepHours;
    totalCharge += chargeKw * stepHours;
    totalDischarge += dischargeKw * stepHours;
    schedule.push({
      index: i, solarKw: round(s), loadKw: round(l), chargeKw: round(chargeKw), dischargeKw: round(dischargeKw),
      gridImportKw: round(gridImportKw), gridExportKw: round(gridExportKw), socPct: round((energy / cap) * 100, 1)
    });
  }

  const loadEnergy = load.reduce((a, v) => a + v * stepHours, 0);
  const solarEnergy = solar.reduce((a, v) => a + v * stepHours, 0);
  const directSelfUse = Math.max(0, Math.min(loadEnergy, solarEnergy + totalDischarge));
  return {
    algorithm: 'self-consumption-greedy-v1',
    assumptions: { stepHours, roundTripEfficiency: rtEff, minSocPct: minSoc * 100, maxSocPct: maxSoc * 100 },
    summary: {
      loadKwh: round(loadEnergy, 2), solarKwh: round(solarEnergy, 2), gridImportKwh: round(totalImport, 2), gridExportKwh: round(totalExport, 2),
      batteryChargeKwh: round(totalCharge, 2), batteryDischargeKwh: round(totalDischarge, 2), finalSocPct: round((energy / cap) * 100, 1),
      solarCoveragePct: round(loadEnergy > 0 ? clamp((1 - totalImport / loadEnergy) * 100, 0, 100) : 0, 1),
      estimatedSelfUseKwh: round(directSelfUse, 2)
    },
    schedule
  };
}

function makeAdvisor(payload) {
  const solar = payload.solarKw || [];
  const load = payload.loadKw || [];
  const soc = num(payload.initialSocPct, 50);
  const points = Math.min(solar.length, load.length);
  const recs = [];
  if (points) {
    let peakLoad = -Infinity, peakIndex = 0, surplus = 0, surplusIndex = 0;
    for (let i = 0; i < points; i++) {
      if (load[i] > peakLoad) { peakLoad = load[i]; peakIndex = i; }
      const diff = solar[i] - load[i];
      if (diff > surplus) { surplus = diff; surplusIndex = i; }
    }
    recs.push({ priority: 'high', title: 'Giảm phụ tải giờ cao điểm', message: `Phụ tải cao nhất trong chuỗi dự báo ở mốc ${peakIndex}, khoảng ${round(peakLoad, 2)} kW. Ưu tiên dịch chuyển EV hoặc tải linh hoạt ra khỏi mốc này.` });
    if (surplus > 0.3) recs.push({ priority: 'medium', title: 'Tận dụng solar dư', message: `Solar dư lớn nhất ở mốc ${surplusIndex}, khoảng ${round(surplus, 2)} kW. Đây là thời điểm phù hợp để sạc battery hoặc EV.` });
  }
  if (soc < 25) recs.push({ priority: 'high', title: 'Bảo toàn pin dự phòng', message: 'SOC đang thấp. Hạn chế xả sâu và ưu tiên nạp từ solar trước khi bước vào giờ phụ tải cao.' });
  else if (soc > 85) recs.push({ priority: 'medium', title: 'Tạo khoảng trống cho solar', message: 'SOC đang cao. Nếu dự báo trưa có solar mạnh, có thể sử dụng một phần pin trước đó để tăng khả năng hấp thụ năng lượng tái tạo.' });
  if (!recs.length) recs.push({ priority: 'normal', title: 'Hệ thống cân bằng', message: 'Chưa phát hiện xung đột lớn giữa phụ tải, solar và SOC trong dữ liệu hiện tại.' });
  return { generatedBy: 'rule-based-energy-advisor-v1', recommendations: recs };
}

async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!rateLimit(req)) return send(res, 429, { error: 'Too many requests' });

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/') return send(res, 200, { name: 'EnergyGuard API', version: '1.0.0', docs: ['/health','/api/status','/api/weather','/api/nasa/history','/api/predict/load','/api/optimize/bess','/api/advisor'] });
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, service: 'energyguard-api', time: new Date().toISOString() });
    if (req.method === 'GET' && path === '/api/status') return send(res, 200, {
      ok: true,
      integrations: { openMeteo: true, nasaPower: true, googleLoginConfigured: Boolean(GOOGLE_CLIENT_ID), databaseProvisionedExternally: true },
      models: { loadForecast: 'transparent-baseline-v1', solarForecast: 'irradiance-derate-v1', bessOptimizer: 'self-consumption-greedy-v1', advisor: 'rule-based-energy-advisor-v1' }
    });

    if (req.method === 'GET' && path === '/api/weather') {
      const lat = num(url.searchParams.get('lat'), NaN), lon = num(url.searchParams.get('lon'), NaN);
      const days = clamp(Math.round(num(url.searchParams.get('days'), 2)), 1, 7);
      const capacityKwp = clamp(num(url.searchParams.get('capacity_kwp'), 5), 0.1, 5000);
      const derate = clamp(num(url.searchParams.get('derate'), 0.82), 0.5, 0.98);
      if (!validateCoords(lat, lon)) return send(res, 400, { error: 'Invalid lat/lon.' });
      const endpoint = new URL('https://api.open-meteo.com/v1/forecast');
      endpoint.searchParams.set('latitude', lat);
      endpoint.searchParams.set('longitude', lon);
      endpoint.searchParams.set('forecast_days', days);
      endpoint.searchParams.set('timezone', 'auto');
      endpoint.searchParams.set('current', 'temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m');
      endpoint.searchParams.set('hourly', 'temperature_2m,relative_humidity_2m,cloud_cover,precipitation,shortwave_radiation,direct_normal_irradiance');
      const data = await fetchJson(endpoint.toString());
      const h = data.hourly || {};
      const solarKw = (h.time || []).map((_, i) => estimatePvOutput(h.shortwave_radiation?.[i], h.temperature_2m?.[i], capacityKwp, derate));
      return send(res, 200, {
        source: 'Open-Meteo', coordinates: { latitude: data.latitude, longitude: data.longitude }, timezone: data.timezone,
        capacityKwp, derate, current: data.current,
        hourly: { time: h.time || [], temperatureC: h.temperature_2m || [], humidityPct: h.relative_humidity_2m || [], cloudCoverPct: h.cloud_cover || [], precipitationMm: h.precipitation || [], ghiWm2: h.shortwave_radiation || [], dniWm2: h.direct_normal_irradiance || [], estimatedSolarKw: solarKw },
        methodology: 'PV output is an engineering estimate from GHI × installed capacity × derating × temperature correction; it is not a site-calibrated PV model.'
      });
    }

    if (req.method === 'GET' && path === '/api/nasa/history') {
      const lat = num(url.searchParams.get('lat'), NaN), lon = num(url.searchParams.get('lon'), NaN);
      const start = (url.searchParams.get('start') || '').replace(/-/g, '');
      const end = (url.searchParams.get('end') || '').replace(/-/g, '');
      if (!validateCoords(lat, lon)) return send(res, 400, { error: 'Invalid lat/lon.' });
      if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return send(res, 400, { error: 'start/end must be YYYYMMDD or YYYY-MM-DD.' });
      const endpoint = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
      endpoint.searchParams.set('parameters', 'ALLSKY_SFC_SW_DWN,T2M');
      endpoint.searchParams.set('community', 'RE');
      endpoint.searchParams.set('longitude', lon);
      endpoint.searchParams.set('latitude', lat);
      endpoint.searchParams.set('start', start);
      endpoint.searchParams.set('end', end);
      endpoint.searchParams.set('format', 'JSON');
      endpoint.searchParams.set('time-standard', 'LST');
      const data = await fetchJson(endpoint.toString(), 30000);
      const p = data?.properties?.parameter || {};
      return send(res, 200, { source: 'NASA POWER', latitude: lat, longitude: lon, timeStandard: 'LST', daily: { dateToSolarKwhM2: p.ALLSKY_SFC_SW_DWN || {}, dateToTemperatureC: p.T2M || {} }, rawHeader: data?.header || null });
    }

    if (req.method === 'POST' && path === '/api/predict/load') {
      const body = await readJson(req);
      const baseLoadKw = clamp(num(body.baseLoadKw, 1.6), 0.1, 10000);
      let rows = Array.isArray(body.hours) ? body.hours.slice(0, 336) : null;
      if (!rows || !rows.length) {
        const now = new Date();
        rows = Array.from({ length: 24 }, (_, i) => ({ hour: i, temperatureC: 30, humidityPct: 75, weekday: now.getDay() }));
      }
      const forecast = rows.map((r, i) => {
        const hour = clamp(Math.round(num(r.hour, i % 24)), 0, 23);
        const temperatureC = clamp(num(r.temperatureC, 30), -10, 55);
        const humidityPct = clamp(num(r.humidityPct, 75), 0, 100);
        const weekday = clamp(Math.round(num(r.weekday, 1)), 0, 6);
        return { index: i, hour, predictedLoadKw: baselineLoad(hour, temperatureC, humidityPct, weekday, baseLoadKw) };
      });
      return send(res, 200, { model: 'transparent-baseline-v1', trained: false, note: 'This baseline is intentionally not presented as a trained ML model. Replace it after historical meter data is available.', baseLoadKw, forecast });
    }

    if (req.method === 'POST' && path === '/api/optimize/bess') {
      const body = await readJson(req);
      return send(res, 200, optimizeBess(body));
    }

    if (req.method === 'POST' && path === '/api/advisor') {
      const body = await readJson(req);
      return send(res, 200, makeAdvisor(body));
    }

    if (req.method === 'GET' && path === '/api/auth/google/config') return send(res, 200, { enabled: Boolean(GOOGLE_CLIENT_ID), clientId: GOOGLE_CLIENT_ID || null });

    if (req.method === 'POST' && path === '/api/auth/google/verify') {
      if (!GOOGLE_CLIENT_ID) return send(res, 503, { error: 'Google Login is not configured for this independent EnergyGuard deployment.' });
      const body = await readJson(req);
      const credential = String(body.credential || '');
      if (!credential || credential.length > 10000) return send(res, 400, { error: 'Missing credential.' });
      const token = await fetchJson(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
      if (token.aud !== GOOGLE_CLIENT_ID) return send(res, 401, { error: 'Invalid token audience.' });
      return send(res, 200, { ok: true, user: { sub: token.sub, email: token.email, name: token.name, picture: token.picture, emailVerified: token.email_verified === 'true' || token.email_verified === true } });
    }

    if (req.method === 'POST' && path === '/api/contact') {
      const body = await readJson(req, 64_000);
      const name = String(body.name || '').trim().slice(0, 100);
      const email = String(body.email || '').trim().slice(0, 200);
      const message = String(body.message || '').trim().slice(0, 3000);
      if (!name || !email || !message || !/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { error: 'Please provide a valid name, email and message.' });
      const item = { id: `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, email, message, createdAt: new Date().toISOString() };
      memoryContacts.push(item); if (memoryContacts.length > 100) memoryContacts.shift();
      return send(res, 201, { ok: true, id: item.id, persistence: 'temporary-memory', note: 'A dedicated Postgres instance has been provisioned; persistent wiring requires its database secret to be attached to this service.' });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    const status = err.status || (err.name === 'AbortError' ? 504 : 500);
    return send(res, status, { error: status === 500 ? 'Internal server error' : err.message });
  }
}

http.createServer(handler).listen(PORT, () => console.log(`EnergyGuard API listening on :${PORT}`));
