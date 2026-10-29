'use strict';
// Configuração central. Lê variáveis de ambiente e, se existir, o arquivo .env (sem dependências externas).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile(process.env.ENV_FILE || path.join(ROOT, '.env'));

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'sim'].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const isProd = env.NODE_ENV === 'production';
const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));

const config = {
  root: ROOT,
  isProd,
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  trustProxy: bool(env.TRUST_PROXY, isProd),
  publicDir: path.join(ROOT, 'public'),
  dataDir,
  dbPath: path.resolve(env.DB_PATH || path.join(dataDir, 'agrosensor.db')),
  uploadDir: path.resolve(env.UPLOAD_DIR || path.join(dataDir, 'uploads')),
  maxUploadMb: num(env.MAX_UPLOAD_MB, 10),
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  sessionIdleHours: num(env.SESSION_IDLE_HOURS, 12),
  sessionMaxDays: num(env.SESSION_MAX_DAYS, 7),
  seed: {
    orgName: env.ORG_NAME || 'AgroSensor Tech',
    username: env.ADMIN_USERNAME || 'admin',
    password: env.ADMIN_PASSWORD || '',
    name: env.ADMIN_NAME || 'Administrador',
    email: env.ADMIN_EMAIL || '',
  },
  ai: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.AI_MODEL || 'claude-sonnet-5-5',
    apiBase: (env.AI_API_BASE || 'https://api.anthropic.com').replace(/\/$/, ''),
    timeoutMs: num(env.AI_TIMEOUT_MS, 60000),
  },
  weather: {
    enabled: bool(env.WEATHER_ENABLED, true),
    provider: 'open-meteo',
    apiBase: (env.WEATHER_API_BASE || 'https://api.open-meteo.com').replace(/\/$/, ''),
    archiveBase: (env.WEATHER_ARCHIVE_API_BASE || 'https://archive-api.open-meteo.com').replace(/\/$/, ''),
    timeoutMs: num(env.WEATHER_TIMEOUT_MS, 10000),
    cacheMinutes: num(env.WEATHER_CACHE_MINUTES, 30),
  },
  alertsIntervalMinutes: num(env.ALERTS_INTERVAL_MINUTES, 10),
  smtp: {
    host: env.SMTP_HOST || '',
    port: num(env.SMTP_PORT, 587),
    secure: bool(env.SMTP_SECURE, false),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || '',
  },
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
};

config.smtp.enabled = Boolean(config.smtp.host && config.smtp.from);
config.ai.enabled = Boolean(config.ai.apiKey);

module.exports = config;
