'use strict';
// Perfis e permissões. Ações: r = consultar, w = criar/editar, d = excluir.

const ROLES = {
  admin: 'Administrador geral',
  gestor: 'Gestor da fazenda',
  agronomo: 'Engenheiro agrônomo ou técnico',
  operador: 'Operador de máquinas',
  visualizador: 'Visualizador',
};

const MODULES = [
  'farms', 'plots', 'map', 'occurrences', 'ia', 'machines', 'machine_ops', 'maintenance', 'drones', 'missions',
  'spray', 'sensors', 'weather', 'reports', 'costs', 'alerts', 'users', 'audit', 'settings',
];

const READ_ALL = Object.fromEntries(MODULES.map((m) => [m, 'r']));
const NONE_ADMIN = { users: '', audit: '', settings: '' };

const MATRIX = {
  admin: Object.fromEntries(MODULES.map((m) => [m, 'rwd'])),
  gestor: {
    ...Object.fromEntries(MODULES.map((m) => [m, 'rwd'])),
    weather: 'r', reports: 'r', alerts: 'rw', ...NONE_ADMIN,
  },
  agronomo: {
    ...READ_ALL,
    plots: 'rw', map: 'rw', occurrences: 'rwd', ia: 'rw', spray: 'rw', sensors: 'rw', alerts: 'rw', ...NONE_ADMIN,
  },
  operador: {
    ...READ_ALL,
    map: 'rw', occurrences: 'rw', ia: 'rw', machine_ops: 'rw', missions: 'rw', spray: 'rw', alerts: 'rw',
    reports: '', costs: '', ...NONE_ADMIN,
  },
  visualizador: { ...READ_ALL, ...NONE_ADMIN },
};

function can(role, module, action = 'r') {
  const p = (MATRIX[role] && MATRIX[role][module]) || '';
  return p.includes(action);
}

function permissionsFor(role) {
  return { ...(MATRIX[role] || {}) };
}

module.exports = { ROLES, MODULES, MATRIX, can, permissionsFor };
