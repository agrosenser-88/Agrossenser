'use strict';
// Integração meteorológica real (Open-Meteo, sem chave de API). Se a fonte falhar, o sistema informa indisponibilidade
// e não exibe valores inventados.
const config = require('../config');
const db = require('../lib/db');
const alerts = require('./alerts');

const cache = new Map();
const TZ = 'America/Sao_Paulo';

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), config.weather.timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const numOrNull = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function unavailable(reason, message) {
  return { available: false, reason, message };
}

async function fetchForecast(farm) {
  const key = `f:${farm.id}:${farm.latitude}:${farm.longitude}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < config.weather.cacheMinutes * 60000) return hit.data;
  const q = new URLSearchParams({
    latitude: String(farm.latitude), longitude: String(farm.longitude), timezone: TZ, forecast_days: '7', wind_speed_unit: 'kmh',
    current: 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max',
  });
  const j = await getJson(`${config.weather.apiBase}/v1/forecast?${q}`);
  if (!j || !j.current || !j.daily || !Array.isArray(j.daily.time)) throw new Error('Resposta inesperada da fonte meteorológica.');
  const c = j.current;
  const data = {
    available: true, source: 'Open-Meteo', fetched_at: new Date().toISOString(),
    current: {
      time: c.time, temperature: numOrNull(c.temperature_2m), humidity: numOrNull(c.relative_humidity_2m), precipitation: numOrNull(c.precipitation),
      wind_speed: numOrNull(c.wind_speed_10m), wind_dir: numOrNull(c.wind_direction_10m),
    },
    daily: j.daily.time.map((date, i) => ({
      date, tmax: numOrNull(j.daily.temperature_2m_max && j.daily.temperature_2m_max[i]), tmin: numOrNull(j.daily.temperature_2m_min && j.daily.temperature_2m_min[i]),
      precip_sum: numOrNull(j.daily.precipitation_sum && j.daily.precipitation_sum[i]), precip_prob: numOrNull(j.daily.precipitation_probability_max && j.daily.precipitation_probability_max[i]),
      wind_max: numOrNull(j.daily.wind_speed_10m_max && j.daily.wind_speed_10m_max[i]), gust_max: numOrNull(j.daily.wind_gusts_10m_max && j.daily.wind_gusts_10m_max[i]),
    })),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

function storeObservation(farm, data) {
  const c = data.current;
  if (!c || c.temperature === null) return;
  const at = new Date(Date.parse(c.time + ':00-03:00')).toISOString();
  try {
    db.run(
      'INSERT OR IGNORE INTO weather_records (org_id, farm_id, observed_at, temperature, humidity, precipitation, wind_speed, wind_dir, source) VALUES (?,?,?,?,?,?,?,?,?)',
      farm.org_id, farm.id, Number.isNaN(Date.parse(at)) ? new Date().toISOString() : at, c.temperature, c.humidity, c.precipitation, c.wind_speed, c.wind_dir, 'open-meteo',
    );
  } catch (e) { /* observação duplicada ou inválida: ignora */ }
}

async function forecastForFarm(farm) {
  if (!config.weather.enabled) return unavailable('desativado', 'O monitoramento climático está desativado nas configurações do servidor (WEATHER_ENABLED).');
  if (farm.latitude === null || farm.longitude === null || farm.latitude === undefined) {
    return unavailable('sem_coordenadas', 'Informe a latitude e a longitude da fazenda (ou o ponto do talhão) para consultar o clima.');
  }
  try {
    const data = await fetchForecast(farm);
    storeObservation(farm, data);
    data.alerts = alerts.weatherAlertsFor(data.daily);
    alerts.saveWeatherAlerts(farm.org_id, farm, data.daily);
    return data;
  } catch (e) {
    console.error('[clima] falha ao consultar fonte meteorológica:', e.message);
    return unavailable('indisponivel', 'A fonte meteorológica não respondeu. Os dados do clima estão indisponíveis no momento; tente novamente mais tarde.');
  }
}

async function history(farm, from, to) {
  if (!config.weather.enabled) return unavailable('desativado', 'O monitoramento climático está desativado.');
  if (farm.latitude === null || farm.longitude === null || farm.latitude === undefined) return unavailable('sem_coordenadas', 'Informe a latitude e a longitude da fazenda para consultar o histórico.');
  try {
    const q = new URLSearchParams({
      latitude: String(farm.latitude), longitude: String(farm.longitude), start_date: from, end_date: to, timezone: TZ, wind_speed_unit: 'kmh',
      daily: 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_max',
      hourly: 'relative_humidity_2m',
    });
    const j = await getJson(`${config.weather.archiveBase}/v1/archive?${q}`);
    if (!j || !j.daily || !Array.isArray(j.daily.time)) throw new Error('Resposta inesperada.');
    const hum = {};
    if (j.hourly && Array.isArray(j.hourly.time)) {
      j.hourly.time.forEach((t, i) => {
        const v = j.hourly.relative_humidity_2m[i];
        if (typeof v === 'number') { const d = t.slice(0, 10); (hum[d] = hum[d] || []).push(v); }
      });
    }
    const days = j.daily.time.map((date, i) => ({
      date, tmax: numOrNull(j.daily.temperature_2m_max[i]), tmin: numOrNull(j.daily.temperature_2m_min[i]), tmean: numOrNull(j.daily.temperature_2m_mean[i]),
      precip_sum: numOrNull(j.daily.precipitation_sum[i]), wind_max: numOrNull(j.daily.wind_speed_10m_max[i]),
      humidity: hum[date] ? Math.round((hum[date].reduce((a, b) => a + b, 0) / hum[date].length) * 10) / 10 : null,
    }));
    return { available: true, source: 'Open-Meteo (histórico)', days };
  } catch (e) {
    console.error('[clima] falha no histórico:', e.message);
    // Alternativa: observações já armazenadas pelo sistema para esta fazenda
    const rows = db.all(
      `SELECT substr(observed_at,1,10) AS date, MAX(temperature) AS tmax, MIN(temperature) AS tmin, AVG(temperature) AS tmean,
              SUM(precipitation) AS precip_sum, MAX(wind_speed) AS wind_max, AVG(humidity) AS humidity
         FROM weather_records WHERE farm_id = ? AND substr(observed_at,1,10) BETWEEN ? AND ? GROUP BY substr(observed_at,1,10) ORDER BY date`, farm.id, from, to);
    if (rows.length) return { available: true, source: 'Observações armazenadas pelo sistema', partial: true, days: rows };
    return unavailable('indisponivel', 'O histórico climático está indisponível no momento e ainda não há observações armazenadas para este período.');
  }
}

async function refreshOrgWeather(orgId) {
  if (!config.weather.enabled) return;
  const farms = db.all('SELECT id, org_id, name, latitude, longitude FROM farms WHERE org_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL', orgId);
  for (const f of farms) await forecastForFarm(f);
}

module.exports = { forecastForFarm, history, refreshOrgWeather };
