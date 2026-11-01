-- AgroSenser Tech - esquema inicial
-- Todas as tabelas de dados possuem org_id (isolamento entre organizações).

CREATE TABLE organizations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id               INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  username             TEXT NOT NULL COLLATE NOCASE,
  email                TEXT COLLATE NOCASE,
  name                 TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('admin','gestor','agronomo','operador','visualizador')),
  active               INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX users_username_uq ON users(username);
CREATE UNIQUE INDEX users_email_uq ON users(email) WHERE email IS NOT NULL AND email <> '';
CREATE INDEX users_org_idx ON users(org_id);

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,           -- sha256 do token
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  ip                  TEXT,
  user_agent          TEXT
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE password_resets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX password_resets_user_idx ON password_resets(user_id);

CREATE TABLE farms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  owner_name TEXT,
  city       TEXT,
  state      TEXT,
  area_ha    REAL CHECK (area_ha IS NULL OR area_ha >= 0),
  latitude   REAL CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
  longitude  REAL CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
  notes      TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX farms_org_idx ON farms(org_id);

CREATE TABLE user_farms (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, farm_id)
);

-- Talhões
CREATE TABLE plots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id          INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  crop             TEXT,
  variety          TEXT,
  area_ha          REAL CHECK (area_ha IS NULL OR area_ha >= 0),
  season           TEXT,
  planting_date    TEXT,
  harvest_forecast TEXT,
  status           TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('planejado','ativo','colhido','inativo')),
  boundary         TEXT,          -- GeoJSON (Polygon)
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX plots_org_farm_idx ON plots(org_id, farm_id);
CREATE INDEX plots_crop_idx ON plots(org_id, crop);

-- Arquivos (imagens e documentos). O conteúdo fica em disco/armazenamento de objetos, nunca no banco.
CREATE TABLE files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id     INTEGER REFERENCES farms(id) ON DELETE CASCADE,
  plot_id     INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  ref_type    TEXT NOT NULL CHECK (ref_type IN ('farm','plot','occurrence','ai_analysis','drone_mission','spray_operation','machine')),
  ref_id      INTEGER NOT NULL,
  title       TEXT,
  filename    TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX files_ref_idx ON files(org_id, ref_type, ref_id);

CREATE TABLE inspections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id      INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  plot_id      INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  lat          REAL CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
  lng          REAL CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180)),
  inspected_at TEXT NOT NULL,
  notes        TEXT,
  inspector_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX inspections_org_idx ON inspections(org_id, farm_id, inspected_at);

-- Pragas e doenças (ocorrências)
CREATE TABLE occurrences (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id          INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  plot_id          INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  category         TEXT NOT NULL DEFAULT 'praga' CHECK (category IN ('praga','doenca','daninha','deficiencia','outro')),
  name             TEXT NOT NULL,
  severity         TEXT NOT NULL DEFAULT 'media' CHECK (severity IN ('baixa','media','alta','critica')),
  status           TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','em_tratamento','resolvida')),
  lat              REAL CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
  lng              REAL CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180)),
  observed_at      TEXT NOT NULL,
  area_affected_ha REAL CHECK (area_affected_ha IS NULL OR area_affected_ha >= 0),
  description      TEXT,
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ia')),
  analysis_id      INTEGER,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX occurrences_org_idx ON occurrences(org_id, farm_id, observed_at);
CREATE INDEX occurrences_status_idx ON occurrences(org_id, status, severity);

-- Análises do AgroSenser IA
CREATE TABLE ai_analyses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id     INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  plot_id     INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  crop        TEXT,
  symptoms    TEXT,
  status      TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','concluida','indisponivel','erro')),
  result      TEXT,
  confidence  REAL,
  provider    TEXT,
  model       TEXT,
  message     TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  analyzed_at TEXT
);
CREATE INDEX ai_analyses_org_idx ON ai_analyses(org_id, farm_id, created_at);

-- Máquinas
CREATE TABLE machines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id          INTEGER REFERENCES farms(id) ON DELETE SET NULL,
  plot_id          INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'trator' CHECK (kind IN ('trator','pulverizador','colheitadeira','plantadeira','caminhao','outro')),
  brand            TEXT,
  model            TEXT,
  year             INTEGER CHECK (year IS NULL OR (year >= 1950 AND year <= 2100)),
  identifier       TEXT,
  hour_meter       REAL NOT NULL DEFAULT 0 CHECK (hour_meter >= 0),
  status           TEXT NOT NULL DEFAULT 'disponivel' CHECK (status IN ('disponivel','em_operacao','manutencao','inativo')),
  last_lat         REAL,
  last_lng         REAL,
  last_position_at TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX machines_org_idx ON machines(org_id, farm_id);

CREATE TABLE machine_operations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  machine_id    INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  farm_id       INTEGER REFERENCES farms(id) ON DELETE SET NULL,
  plot_id       INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  operation     TEXT NOT NULL,
  op_date       TEXT NOT NULL,
  hours         REAL NOT NULL DEFAULT 0 CHECK (hours >= 0),
  hour_meter_end REAL CHECK (hour_meter_end IS NULL OR hour_meter_end >= 0),
  operator_name TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX machine_ops_idx ON machine_operations(org_id, machine_id, op_date);

CREATE TABLE machine_fuel (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  farm_id    INTEGER REFERENCES farms(id) ON DELETE SET NULL,
  fuel_date  TEXT NOT NULL,
  liters     REAL NOT NULL CHECK (liters >= 0),
  cost       REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
  hour_meter REAL,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX machine_fuel_idx ON machine_fuel(org_id, machine_id, fuel_date);

CREATE TABLE machine_maintenance (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  machine_id      INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  farm_id         INTEGER REFERENCES farms(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'preventiva' CHECK (kind IN ('preventiva','corretiva')),
  description     TEXT NOT NULL,
  service_date    TEXT NOT NULL,
  cost            REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
  hour_meter      REAL,
  next_due_date   TEXT,
  next_due_hours  REAL,
  status          TEXT NOT NULL DEFAULT 'concluida' CHECK (status IN ('agendada','concluida')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX machine_maint_idx ON machine_maintenance(org_id, machine_id, service_date);

-- Drones
CREATE TABLE drones (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id       INTEGER REFERENCES farms(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  model         TEXT,
  serial_number TEXT,
  capacity_l    REAL CHECK (capacity_l IS NULL OR capacity_l >= 0),
  flight_hours  REAL NOT NULL DEFAULT 0 CHECK (flight_hours >= 0),
  status        TEXT NOT NULL DEFAULT 'disponivel' CHECK (status IN ('disponivel','em_missao','manutencao','inativo')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX drones_org_idx ON drones(org_id, farm_id);

CREATE TABLE drone_batteries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  drone_id   INTEGER NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  farm_id    INTEGER REFERENCES farms(id) ON DELETE SET NULL,
  label      TEXT NOT NULL,
  cycles     INTEGER NOT NULL DEFAULT 0 CHECK (cycles >= 0),
  health_pct REAL CHECK (health_pct IS NULL OR (health_pct >= 0 AND health_pct <= 100)),
  status     TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','atencao','substituir')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE drone_missions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  drone_id        INTEGER NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  farm_id         INTEGER REFERENCES farms(id) ON DELETE SET NULL,
  plot_id         INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  mission_type    TEXT NOT NULL DEFAULT 'inspecao' CHECK (mission_type IN ('pulverizacao','mapeamento','inspecao','outro')),
  mission_date    TEXT NOT NULL,
  planned_area_ha REAL CHECK (planned_area_ha IS NULL OR planned_area_ha >= 0),
  covered_area_ha REAL CHECK (covered_area_ha IS NULL OR covered_area_ha >= 0),
  operator_name   TEXT,
  flight_minutes  REAL CHECK (flight_minutes IS NULL OR flight_minutes >= 0),
  status          TEXT NOT NULL DEFAULT 'planejada' CHECK (status IN ('planejada','em_andamento','concluida','cancelada')),
  checklist       TEXT,
  report          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX drone_missions_idx ON drone_missions(org_id, drone_id, mission_date);

CREATE TABLE drone_maintenance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  drone_id     INTEGER NOT NULL REFERENCES drones(id) ON DELETE CASCADE,
  farm_id      INTEGER REFERENCES farms(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'inspecao' CHECK (kind IN ('inspecao','preventiva','corretiva')),
  description  TEXT NOT NULL,
  service_date TEXT NOT NULL,
  cost         REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Pulverização
CREATE TABLE spray_operations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id           INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id          INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  plot_id          INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  crop             TEXT,
  op_date          TEXT NOT NULL,
  planned_area_ha  REAL CHECK (planned_area_ha IS NULL OR planned_area_ha >= 0),
  executed_area_ha REAL CHECK (executed_area_ha IS NULL OR executed_area_ha >= 0),
  product          TEXT,
  volume_l         REAL CHECK (volume_l IS NULL OR volume_l >= 0),
  input_qty        REAL CHECK (input_qty IS NULL OR input_qty >= 0),
  input_unit       TEXT,
  machine_id       INTEGER REFERENCES machines(id) ON DELETE SET NULL,
  drone_id         INTEGER REFERENCES drones(id) ON DELETE SET NULL,
  operator_name    TEXT,
  status           TEXT NOT NULL DEFAULT 'planejada' CHECK (status IN ('planejada','em_andamento','concluida','cancelada')),
  cost             REAL CHECK (cost IS NULL OR cost >= 0),
  geo_planned      TEXT,
  geo_executed     TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX spray_org_idx ON spray_operations(org_id, farm_id, op_date);

-- Sensores e leituras
CREATE TABLE sensors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id         INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  plot_id         INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'umidade_solo' CHECK (kind IN ('umidade_solo','temperatura','umidade_ar','chuva','irrigacao','outro')),
  unit            TEXT NOT NULL DEFAULT '%',
  device_id       TEXT NOT NULL,
  key_hash        TEXT NOT NULL,
  min_limit       REAL,
  max_limit       REAL,
  lat             REAL,
  lng             REAL,
  status          TEXT NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando','online','offline','inativo')),
  last_reading_at TEXT,
  last_value      REAL,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, device_id)
);
CREATE UNIQUE INDEX sensors_device_uq ON sensors(device_id);

CREATE TABLE sensor_readings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id    INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sensor_id INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  value     REAL NOT NULL,
  read_at   TEXT NOT NULL,
  is_demo   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sensor_readings_idx ON sensor_readings(sensor_id, read_at);

-- Clima (observações armazenadas a partir da fonte meteorológica)
CREATE TABLE weather_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id       INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  observed_at   TEXT NOT NULL,
  temperature   REAL,
  humidity      REAL,
  precipitation REAL,
  wind_speed    REAL,
  wind_dir      REAL,
  source        TEXT NOT NULL,
  UNIQUE (farm_id, observed_at, source)
);

-- Custos e economia
CREATE TABLE costs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id     INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  plot_id     INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  category    TEXT NOT NULL CHECK (category IN ('insumos','combustivel','manutencao','operacao_maquinas','terceirizados','pulverizacao','outros')),
  description TEXT NOT NULL,
  amount      REAL NOT NULL CHECK (amount >= 0),
  cost_date   TEXT NOT NULL,
  area_ha     REAL CHECK (area_ha IS NULL OR area_ha >= 0),
  spray_id    INTEGER REFERENCES spray_operations(id) ON DELETE SET NULL,
  machine_id  INTEGER REFERENCES machines(id) ON DELETE SET NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX costs_org_idx ON costs(org_id, farm_id, cost_date);

CREATE TABLE cost_references (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id      INTEGER REFERENCES farms(id) ON DELETE CASCADE,
  category     TEXT CHECK (category IS NULL OR category IN ('insumos','combustivel','manutencao','operacao_maquinas','terceirizados','pulverizacao','outros')),
  label        TEXT NOT NULL,
  cost_per_ha  REAL NOT NULL CHECK (cost_per_ha > 0),
  valid_from   TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE harvests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id      INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  plot_id      INTEGER REFERENCES plots(id) ON DELETE SET NULL,
  season       TEXT NOT NULL,
  crop         TEXT,
  area_ha      REAL CHECK (area_ha IS NULL OR area_ha > 0),
  quantity     REAL CHECK (quantity IS NULL OR quantity >= 0),
  unit         TEXT NOT NULL DEFAULT 'sc',
  revenue      REAL CHECK (revenue IS NULL OR revenue >= 0),
  harvest_date TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX harvests_org_idx ON harvests(org_id, farm_id, season);

-- Notificações
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  farm_id     INTEGER REFERENCES farms(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- NULL = todos da organização
  category    TEXT NOT NULL CHECK (category IN ('praga','sensor','manutencao','operacao','clima','tarefa','admin')),
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','atencao','critico')),
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  dedup_key   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  UNIQUE (org_id, dedup_key)
);
CREATE INDEX notifications_org_idx ON notifications(org_id, created_at);

CREATE TABLE notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TEXT NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);

-- Auditoria
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    INTEGER,
  username   TEXT,
  farm_id    INTEGER,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  summary    TEXT,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX audit_org_idx ON audit_log(org_id, created_at);
CREATE INDEX audit_entity_idx ON audit_log(org_id, entity, entity_id);
