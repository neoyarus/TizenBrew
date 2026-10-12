'use strict';

// PC-only: attach to an existing debugger; never launch, navigate, or restart it.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { execFile } = require('node:child_process');
const WebSocket = require('ws');
const { createClient } = require('./client.cjs');
const APP_ID = 'xvvl3S1bvH.TizenBrewStandalone';
const PNG_LIMIT = 8 * 1024 * 1024;
const CDP_LIMIT = 12 * 1024 * 1024;
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');
const ATTEST = '(function(){try{return tizen.application.getCurrentApplication().appInfo.id;}catch(e){return null;}})()';

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--config', '--sdb', '--port', '--out'].includes(key) || options[key.slice(2)] !== undefined || !args[i + 1]) throw new Error('Invalid capture arguments');
    options[key.slice(2)] = args[i + 1];
  }
  for (const key of ['config', 'sdb', 'out']) if (!options[key] || !path.isAbsolute(options[key])) throw new Error('Capture paths must be absolute');
  if (!/^[0-9]{5}$/.test(options.port || '') || Number(options.port) < 32768 || Number(options.port) > 65535) throw new Error('Invalid existing debug port');
  options.port = Number(options.port);
  return options;
}

function runSdb(executable, args) {
  return new Promise((resolve, reject) => execFile(executable, args, { timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true }, error => {
    if (error) reject(new Error('SDB command failed'));
    else resolve();
  }));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function getTargets(port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/list', agent: false }, response => {
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) request.destroy(new Error('Debugger target response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Debugger target response aborted')));
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('Debugger target list unavailable'));
        try {
          const targets = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Array.isArray(targets) || targets.length > 16) throw new Error();
          resolve(targets);
        } catch (_) { reject(new Error('Invalid debugger target list')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Debugger target list timed out')), timeout);
    request.once('error', reject);
    request.once('close', () => clearTimeout(timer));
  });
}

function readLauncherToken(config, io = fs) {
  if (config.tizenbrewLauncherTokenPath === undefined) return null;
  try {
    const input = config.tizenbrewLauncherTokenPath;
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error();
    const resolved = io.realpathSync(input);
    const relative = path.relative(path.resolve(__dirname, '../..'), resolved);
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) throw new Error();
    if (io.statSync(resolved).size > 128) throw new Error();
    const descriptor = io.openSync(resolved, 'r');
    const bytes = Buffer.alloc(129);
    let count;
    try { count = io.readSync(descriptor, bytes, 0, bytes.length, 0); }
    finally { io.closeSync(descriptor); }
    if (count > 128) throw new Error();
    const token = bytes.subarray(0, count).toString('utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error();
    return token;
  } catch (_) { throw new Error('Invalid private launcher token configuration'); }
}

function getLauncherStatus(port, token, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/status', agent: false,
      headers: { Authorization: 'Bearer ' + token, Connection: 'close' } }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) request.destroy(new Error('Launcher attestation response too large'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('Launcher attestation response failed')));
      response.on('aborted', () => reject(new Error('Launcher attestation response aborted')));
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('Launcher attestation refused'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(new Error('Invalid launcher attestation response')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Launcher attestation timed out')), timeout);
    request.once('error', () => reject(new Error('Launcher attestation request failed')));
    request.once('close', () => clearTimeout(timer));
  });
}

function launcherSession(status, debugPort) {
  if (!status || status.enabled !== true || status.ready !== true || status.debuggerAttached !== true || status.phase !== 'idle' ||
      status.lastDebugPort !== debugPort || !Number.isSafeInteger(status.debugLaunches) || status.debugLaunches < 1) throw new Error('Cannot attest the active TizenBrew debug session');
  const session = { lastDebugPort: status.lastDebugPort, debugLaunches: status.debugLaunches };
  for (const key of ['debuggerGeneration', 'generation', 'operationId', 'requestsStarted']) {
    if (status[key] !== undefined) {
      if (!Number.isSafeInteger(status[key]) || status[key] < 0) throw new Error('Invalid launcher session counter');
      session[key] = status[key];
    }
  }
  return session;
}

function sameLauncherSession(before, after) {
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length || keys.some(key => before[key] !== after[key])) throw new Error('TizenBrew debug session changed during capture');
}

function targetSocketUrl(target, port) {
  if (!target || target.type && target.type !== 'page' || typeof target.webSocketDebuggerUrl !== 'string') return null;
  try {
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || !/^\/devtools\/page\/[A-Za-z0-9_.:-]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password) return null;
    // Ignore target-provided hosts/ports; every connection stays on our PC forward.
    return 'ws://127.0.0.1:' + port + url.pathname;
  } catch (_) { return null; }
}

function openCdp(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: CDP_LIMIT, handshakeTimeout: timeout, perMessageDeflate: false });
    // ws4 clients otherwise create an unlimited receiver despite maxPayload.
    const originalSetSocket = ws.setSocket;
    ws.setSocket = function (socket, head) { return originalSetSocket.call(this, socket, head, CDP_LIMIT); };
    const pending = new Map();
    let nextId = 1;
    let opened = false;
    const connectionTimer = setTimeout(() => { ws.terminate(); reject(new Error('Debugger connection timed out')); }, timeout);
    function fail() {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Debugger connection closed')); }
      pending.clear();
      if (!opened) reject(new Error('Debugger connection failed'));
    }
    ws.on('error', fail);
    ws.on('close', fail);
    ws.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch (_) { return ws.terminate(); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return ws.terminate();
      // CDP also sends unsolicited method notifications; only responses have ids.
      if (message.id === undefined && typeof message.method === 'string') return;
      if (!Number.isSafeInteger(message.id) || message.id < 1) return ws.terminate();
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error('Debugger command unavailable'));
      else item.resolve(message.result);
    });
    ws.once('open', () => {
      opened = true;
      clearTimeout(connectionTimer);
      resolve({
        call(method, params, deadline = 3000) {
          return new Promise((done, failed) => {
            const id = nextId++;
            const timer = setTimeout(() => { pending.delete(id); failed(new Error('Debugger command timed out')); }, deadline);
            pending.set(id, { resolve: done, reject: failed, timer });
            ws.send(JSON.stringify({ id, method, params }), error => {
              if (!error || !pending.has(id)) return;
              pending.delete(id); clearTimeout(timer); failed(new Error('Debugger send failed'));
            });
          });
        },
        close() { clearTimeout(connectionTimer); ws.terminate(); fail(); }
      });
    });
    ws.once('close', () => clearTimeout(connectionTimer));
  });
}

function decodePng(result) {
  const data = result && result.data;
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(PNG_LIMIT / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid screenshot payload');
  const png = Buffer.from(data, 'base64');
  if (png.length > PNG_LIMIT || png.length < 8 || !png.subarray(0, 8).equals(PNG_HEADER) || png.toString('base64') !== data) throw new Error('Invalid PNG screenshot');
  return png;
}

async function captureApp(options, dependencies = {}) {
  if (!options || !path.isAbsolute(options.config || '') || !path.isAbsolute(options.sdb || '') || !path.isAbsolute(options.out || '') || !Number.isInteger(options.port) || options.port < 32768 || options.port > 65535) throw new Error('Invalid capture options');
  const io = dependencies.fs || fs;
  if (io.existsSync(options.out)) throw new Error('Screenshot output already exists');
  if (io.statSync(options.config).size > 100000) throw new Error('Client configuration too large');
  let config;
  try { config = JSON.parse(io.readFileSync(options.config, 'utf8')); } catch (_) { throw new Error('Invalid client configuration'); }
  const launcherToken = readLauncherToken(config, io);
  const client = (dependencies.createClient || createClient)(config);
  const sdb = args => (dependencies.runSdb || runSdb)(options.sdb, args);
  let tunnel, serial, localPort, cdp, launcherPort, initialSession;
  let launcherForwarded = false;
  let connected = false, forwarded = false;
  try {
    tunnel = await client.tunnel(0);
    serial = '127.0.0.1:' + tunnel.port;
    connected = true; // A timed-out connect can still have established this transport.
    await sdb(['connect', serial]);
    if (launcherToken) {
      launcherPort = await (dependencies.freePort || freePort)();
      if (!Number.isInteger(launcherPort) || launcherPort < 1024 || launcherPort > 65535) throw new Error('Invalid local launcher forward port');
      launcherForwarded = true;
      await sdb(['-s', serial, 'forward', 'tcp:' + launcherPort, 'tcp:8097']);
      initialSession = launcherSession(await (dependencies.getLauncherStatus || getLauncherStatus)(launcherPort, launcherToken), options.port);
    }
    localPort = await (dependencies.freePort || freePort)();
    if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535 || localPort === launcherPort) throw new Error('Invalid local forward port');
    forwarded = true; // A timed-out command may still have created this exact forward.
    await sdb(['-s', serial, 'forward', 'tcp:' + localPort, 'tcp:' + options.port]);
    let targets;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { targets = await (dependencies.getTargets || getTargets)(localPort); break; }
      catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    const eligible = targets.filter(target => targetSocketUrl(target, localPort));
    if (launcherToken && eligible.length !== 1) throw new Error('Launcher attestation requires exactly one app page target');
    for (const target of eligible) {
      const url = targetSocketUrl(target, localPort);
      if (!url) continue;
      try {
        cdp = await (dependencies.openCdp || openCdp)(url);
        if (launcherToken) break; // Ownership was attested by fixed app launcher and port.
        const result = await cdp.call('Runtime.evaluate', { expression: ATTEST, returnByValue: true });
        if (result && !result.exceptionDetails && result.result && result.result.type === 'string' && result.result.value === APP_ID) break;
      } catch (_) { /* Unattestable targets are never captured. */ }
      if (cdp) cdp.close();
      cdp = null;
    }
    if (!cdp) throw new Error('Cannot attest the existing TizenBrew app debugger');
    if (launcherToken) sameLauncherSession(initialSession, launcherSession(await (dependencies.getLauncherStatus || getLauncherStatus)(launcherPort, launcherToken), options.port));
    const png = decodePng(await cdp.call('Page.captureScreenshot', { format: 'png' }, 5000));
    if (launcherToken) sameLauncherSession(initialSession, launcherSession(await (dependencies.getLauncherStatus || getLauncherStatus)(launcherPort, launcherToken), options.port));
    io.writeFileSync(options.out, png, { flag: 'wx', mode: 0o600 });
    return { appId: APP_ID, bytes: png.length, output: options.out, scope: 'app-document', attestation: launcherToken ? 'pinned-tunnel-launcher-status' : 'page-app-id' };
  } finally {
    if (cdp) cdp.close();
    if (forwarded) { try { await sdb(['-s', serial, 'forward', '--remove', 'tcp:' + localPort]); } catch (_) { /* Disconnect below also retires our transport. */ } }
    if (launcherForwarded) { try { await sdb(['-s', serial, 'forward', '--remove', 'tcp:' + launcherPort]); } catch (_) {} }
    if (connected) { try { await sdb(['disconnect', serial]); } catch (_) {} }
    if (tunnel) tunnel.close();
    client.close();
  }
}

if (require.main === module) {
  Promise.resolve().then(() => captureApp(parseArgs(process.argv.slice(2)))).then(result => console.log(JSON.stringify(result))).catch(error => {
    // Do not print transport URLs, private configuration, command output or stacks.
    console.error('App capture failed: ' + (error.message || 'Unknown error').replace(/[\r\n]/g, ' ').slice(0, 160));
    process.exitCode = 1;
  });
}

module.exports = { captureApp, parseArgs, decodePng, targetSocketUrl, getTargets, openCdp, readLauncherToken, getLauncherStatus, launcherSession, sameLauncherSession, APP_ID };
