'use strict';
// Cliente SMTP mínimo (sem dependências). Só é usado quando SMTP_HOST e SMTP_FROM estão configurados.
const net = require('net');
const tls = require('tls');
const config = require('../config');

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const opts = { host: cfg.host, port: cfg.port };
    const sock = cfg.secure ? tls.connect({ ...opts, servername: cfg.host }) : net.connect(opts);
    const onErr = (e) => reject(e);
    sock.once('error', onErr);
    sock.setTimeout(15000, () => { sock.destroy(new Error('Tempo esgotado na conexão SMTP.')); });
    sock.once(cfg.secure ? 'secureConnect' : 'connect', () => { sock.removeListener('error', onErr); resolve(sock); });
  });
}

function makeReader(sock) {
  let buf = '';
  let waiters = [];
  const flush = () => {
    while (waiters.length) {
      const lines = buf.split('\r\n');
      // procura uma resposta completa (última linha com "NNN " sem hífen)
      let end = -1;
      for (let i = 0; i < lines.length - 1; i += 1) if (/^\d{3} /.test(lines[i])) { end = i; break; }
      if (end === -1) return;
      const resp = lines.slice(0, end + 1);
      buf = lines.slice(end + 1).join('\r\n');
      waiters.shift().resolve({ code: Number(resp[end].slice(0, 3)), lines: resp });
    }
  };
  const onData = (d) => { buf += d.toString('utf8'); flush(); };
  sock.on('data', onData);
  sock.on('error', (e) => { waiters.forEach((w) => w.reject(e)); waiters = []; });
  sock.on('close', () => { waiters.forEach((w) => w.reject(new Error('Conexão SMTP encerrada.'))); waiters = []; });
  return {
    read: () => new Promise((resolve, reject) => { waiters.push({ resolve, reject }); flush(); }),
    detach: () => sock.removeListener('data', onData),
  };
}

async function send({ to, subject, text }) {
  const cfg = config.smtp;
  if (!cfg.enabled) throw new Error('SMTP não configurado.');
  let sock = await connect(cfg);
  let rd = makeReader(sock);
  const cmd = async (line, expect) => {
    if (line !== null) sock.write(line + '\r\n');
    const r = await rd.read();
    if (expect && !expect.includes(r.code)) throw new Error(`SMTP: resposta inesperada (${r.lines.join(' | ')})`);
    return r;
  };
  try {
    await cmd(null, [220]);
    let ehlo = await cmd('EHLO agrosensor', [250]);
    if (!cfg.secure && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
      await cmd('STARTTLS', [220]);
      rd.detach();
      sock = tls.connect({ socket: sock, servername: cfg.host });
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      rd = makeReader(sock);
      ehlo = await cmd('EHLO agrosensor', [250]);
    }
    if (cfg.user) {
      const plain = Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64');
      await cmd(`AUTH PLAIN ${plain}`, [235]);
    }
    const fromAddr = (/<([^>]+)>/.exec(cfg.from) || [null, cfg.from])[1];
    await cmd(`MAIL FROM:<${fromAddr}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const enc = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
    const body = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    const msg = [
      `From: ${cfg.from}`, `To: <${to}>`, `Subject: ${enc(subject)}`, `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body, '.',
    ].join('\r\n');
    await cmd(msg, [250]);
    await cmd('QUIT', null).catch(() => {});
  } finally {
    sock.destroy();
  }
}

module.exports = { send, enabled: () => config.smtp.enabled };
