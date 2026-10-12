'use strict';

const https = require('node:https');
const http = require('node:http');
const tls = require('node:tls');
const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { canonical, constants, validateWidgetAsync } = require('../service/core.cjs');
const { parseCommand, transportCode } = require('../service/tvRemote.cjs');
const { createNativeRemote } = require('./nativeRemote.cjs');

function createClient(config, dependencies = {}) {
  if (!config || typeof config.host !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(config.host) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(config.certificateSha256) || typeof config.privateKeyPath !== 'string') throw new Error('Invalid client configuration');
  const privateKey = fs.readFileSync(config.privateKeyPath);
  const expectedPin = Buffer.from(config.certificateSha256, 'hex');
  const nativeRemote = config.tvRemoteToken === undefined ? null : createNativeRemote(config, dependencies.nativeRemote);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = function (options, callback) {
    let completed = false;
    const socket = tls.connect({ host: config.host, port: config.port, rejectUnauthorized: false,
      minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('TLS connection timed out'), { code: 'ETIMEDOUT' })), Math.min(7000, options.recoveryTimeoutMs || 7000));
    function finish(error) {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      callback(error, error ? undefined : socket);
    }
    socket.once('error', finish);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      const actual = certificate.raw && crypto.createHash('sha256').update(certificate.raw).digest();
      if (!actual || !crypto.timingSafeEqual(actual, expectedPin)) {
        const error = Object.assign(new Error('Recovery TLS certificate pin mismatch'), { code: 'TLS_PIN_MISMATCH' });
        finish(error);
        socket.destroy();
        return;
      }
      finish();
    });
    // Agent writes HTTP only after this callback has verified the leaf certificate.
  };

  function rawRequest(method, route, headers, body, tunnel, timeoutMs = 35000) {
    return new Promise((resolve, reject) => {
      const request = https.request({ host: config.host, port: config.port, method, path: route, agent, recoveryTimeoutMs: timeoutMs,
        headers: { 'Content-Length': String(body.length), ...headers } });
      const timer = setTimeout(() => request.destroy(Object.assign(new Error('Recovery request timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
      request.on('error', error => { clearTimeout(timer); reject(error); });
      request.on('connect', (response, socket, head) => {
        clearTimeout(timer);
        if (!tunnel || response.statusCode !== 200) {
          socket.destroy();
          reject(new Error('Recovery tunnel refused (' + response.statusCode + ')'));
          return;
        }
        resolve({ socket, head });
      });
      request.on('response', response => {
        let bytes = 0;
        const chunks = [];
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 100000) return request.destroy(new Error('Recovery response limit'));
          chunks.push(chunk);
        });
        response.on('error', error => { clearTimeout(timer); reject(error); });
        response.on('aborted', () => { clearTimeout(timer); reject(Object.assign(new Error('Recovery response aborted'), { code: 'ECONNRESET' })); });
        response.on('end', () => {
          clearTimeout(timer);
          let result;
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch (error) { return reject(new Error('Invalid recovery response')); }
          if (response.statusCode < 200 || response.statusCode >= 300) return reject(Object.assign(new Error('Recovery request refused (' + response.statusCode + '): ' + (result.error || 'Unknown error')), {
            code: 'STATUS_' + response.statusCode, transportCode: result.transportCode ? transportCode({ code: result.transportCode }) : undefined,
            diagnosticDetail: typeof result.diagnosticDetail === 'string' ? result.diagnosticDetail.replace(/(?:https?|wss?):\/\/[^\s"'<>)]*/gi, '[url]').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 256) : undefined
          }));
          resolve(result);
        });
      });
      request.end(body);
    });
  }
  function sign(value) { return crypto.createSign('RSA-SHA256').update(value).sign(privateKey, 'base64'); }
  async function authenticated(method, route, body = Buffer.alloc(0), extraHeaders = {}, tunnel = false, deadline) {
    function budget() {
      if (deadline === undefined) return 35000;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Object.assign(new Error('Recovery readiness timed out'), { code: 'ETIMEDOUT' });
      return Math.min(3000, remaining);
    }
    const challenge = await rawRequest('GET', '/challenge', {}, Buffer.alloc(0), false, budget());
    // The server owns nonce expiry; PC and TV wall clocks need not agree.
    if (challenge.protocol !== 'TBRC1' || !/^[a-f0-9]{64}$/.test(challenge.nonce) || !Number.isFinite(challenge.expiresAt)) throw new Error('Invalid recovery challenge');
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const headers = { 'x-recovery-nonce': challenge.nonce, 'x-recovery-sha256': hash, 'x-recovery-bytes': String(body.length),
      'x-recovery-signature': sign(canonical(challenge.nonce, method, route, hash, body.length)), ...extraHeaders };
    return rawRequest(method, route, headers, body, tunnel, budget());
  }
  async function install(file) {
    const size = fs.statSync(file).size;
    if (size < 1 || size > constants.LIMIT) throw new Error('Widget size limit');
    const body = fs.readFileSync(file);
    await new Promise((resolve, reject) => validateWidgetAsync(body, (error, result) => error ? reject(error) : resolve(result)));
    return authenticated('POST', '/install', body, { 'Content-Type': 'application/octet-stream', 'x-widget-signature': sign(body) });
  }
  function remote(key, holdMs) {
    const command = parseCommand({ key, holdMs });
    if (nativeRemote) return nativeRemote.execute(command);
    return authenticated('POST', '/remote', Buffer.from(JSON.stringify(command)), { 'Content-Type': 'application/json' });
  }
  async function tunnel(localPort = 26102) {
    if (!Number.isInteger(localPort) || localPort !== 0 && localPort < 1024 || localPort > 65535) throw new Error('Invalid local port');
    // Verify authorization and the server pin before advertising a usable PC listener.
    await authenticated('GET', '/status');
    const connections = new Set();
    const localConnections = new Set();
    const local = net.createServer(socket => {
      connections.add(socket);
      localConnections.add(socket);
      socket.pause();
      socket.on('error', () => {});
      socket.on('close', () => { connections.delete(socket); localConnections.delete(socket); });
      if (localConnections.size > 2) return socket.destroy();
      authenticated('CONNECT', '/sdb', Buffer.alloc(0), {}, true).then(remote => {
        if (socket.destroyed) { remote.socket.destroy(); return; }
        connections.add(remote.socket);
        remote.socket.on('error', () => socket.destroy());
        remote.socket.on('close', () => { connections.delete(remote.socket); socket.destroy(); });
        socket.on('close', () => remote.socket.destroy());
        if (remote.head.length) socket.write(remote.head);
        socket.pipe(remote.socket);
        remote.socket.pipe(socket);
        socket.resume();
      }).catch(() => socket.destroy());
    });
    await new Promise((resolve, reject) => { local.once('error', reject); local.listen(localPort, '127.0.0.1', resolve); });
    return { port: local.address().port, server: local, close() { connections.forEach(socket => socket.destroy()); local.close(); } };
  }
  async function startCompanion() {
    await new Promise((resolve, reject) => {
      const request = (dependencies.http || http).request({ host: config.host, port: 8001, method: 'POST',
        path: '/api/v2/applications/TbRecov001.RecoveryCompanion', headers: { 'Content-Length': '0' } }, response => {
        response.resume();
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) reject(new Error('Native companion launch refused (' + response.statusCode + ')'));
          else resolve();
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('Native companion launch response aborted')));
      });
      const timer = setTimeout(() => request.destroy(new Error('Native companion launch timed out')), 3000);
      request.once('error', error => { clearTimeout(timer); reject(error); });
      request.once('close', () => clearTimeout(timer));
      request.end();
    });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { return { requested: true, ready: true, status: await authenticated('GET', '/status', Buffer.alloc(0), {}, false, deadline) }; }
      catch (error) {
        // Launching is explicit. Authentication and pin failures never trigger a fallback.
        if (!['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'STATUS_503'].includes(error.code)) throw error;
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
      }
    }
    throw new Error('Native launch acknowledged; authenticated recovery readiness was not confirmed');
  }
  return { status: () => authenticated('GET', '/status'), capabilities: () => authenticated('GET', '/capabilities'), start: startCompanion, install, remote, tunnel,
    close() { if (nativeRemote) nativeRemote.close(); agent.destroy(); } };
}

module.exports = { createClient };
