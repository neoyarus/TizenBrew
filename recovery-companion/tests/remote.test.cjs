'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { create, parseCommand, keys } = require('../service/tvRemote.cjs');

function fixture(options = {}, dependencies = {}) {
  let now = 0, nextId = 0;
  const timers = new Map(), sockets = [], results = [];
  class WebSocket extends EventEmitter {
    constructor(url, settings) { super(); this.url = url; this.settings = settings; this.readyState = 1; this.sent = []; this._receiver = {}; sockets.push(this); }
    send(value, callback) { const packet = JSON.parse(value); this.sent.push(packet); if (!this.stall) callback(this.sendError); }
    close() { this.closeRequested = true; if (!this.stallClose) { this.readyState = 3; this.emit('close'); } }
    terminate() { this.terminated = true; this.readyState = 3; }
  }
  const remote = create({ tvRemoteToken: 'private-fixture-token', tvRemoteName: 'HomeAssistant', ...options }, { WebSocket,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); }, ...dependencies });
  function advance(ms) {
    const until = now + ms;
    while (true) { const pending = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at); if (!pending.length) break;
      const [id, timer] = pending[0]; now = timer.at; timers.delete(id); timer.callback(); }
    now = until;
  }
  function execute(command) { remote.execute(command, (error, value) => results.push({ error, value })); }
  return { remote, sockets, results, timers, advance, execute, connect() { const socket = sockets[sockets.length - 1]; socket.emit('open'); socket.emit('message', JSON.stringify({ event: 'ms.channel.connect', data: { token: 'never-return-this' } })); return socket; } };
}

test('remote commands are a fixed key allowlist and bounded integer holds', () => {
  for (const key of keys) assert.equal(parseCommand({ key }).key, key);
  for (const command of [{ key: 'KEY_REBOOT' }, { key: 'KEY_HOME', host: 'external' }, { key: 'KEY_HOME', holdMs: 499 },
    { key: 'KEY_HOME', holdMs: 10001 }, { key: 'KEY_HOME', holdMs: 500.5 }, { key: 'KEY_HOME', holdMs: '500' }, [], null]) assert.throws(() => parseCommand(command));
  assert.equal(parseCommand({ key: 'KEY_POWER', holdMs: 10000 }).holdMs, 10000);
});

test('missing configuration never opens a socket; fixed native target uses only the private token', () => {
  const disabled = fixture({ tvRemoteToken: undefined });
  disabled.execute({ key: 'KEY_HOME' });
  assert.equal(disabled.results[0].error.code, 'REMOTE_UNAVAILABLE');
  assert.equal(disabled.sockets.length, 0);
  const h = fixture(); h.execute({ key: 'KEY_HOME' });
  const socket = h.connect();
  assert.equal(socket.url, 'wss://127.0.0.1:8002/api/v2/channels/samsung.remote.control?name=SG9tZUFzc2lzdGFudA%3D%3D&token=private-fixture-token');
  assert.equal(socket.settings.rejectUnauthorized, false);
  assert.equal(socket.settings.handshakeTimeout, 5000);
  assert.equal(socket.settings.followRedirects, false);
  assert.deepEqual(socket.sent, [{ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_HOME', Option: 'false', TypeOfRemote: 'SendRemoteKey' } }]);
  assert.equal(h.results[0].value.sent, true);
  assert.equal(JSON.stringify(h.results).includes('private-fixture-token'), false);
  assert.equal(JSON.stringify(h.results).includes('never-return-this'), false);
});

test('hold serializes one operation and always releases after the requested interval', () => {
  const h = fixture(); h.execute({ key: 'KEY_POWER', holdMs: 5000 });
  const socket = h.connect();
  h.execute({ key: 'KEY_HOME' });
  assert.equal(h.results[0].error.code, 'REMOTE_BUSY');
  h.advance(4999); assert.deepEqual(socket.sent.map(packet => packet.params.Cmd), ['Press']);
  h.advance(1); assert.deepEqual(socket.sent.map(packet => packet.params.Cmd), ['Press', 'Release']);
  assert.equal(h.results[1].value.mode, 'hold');
  assert.equal(socket.terminated, true);
  assert.equal(h.timers.size, 0);
});

test('errors and service shutdown after Press attempt Release without retrying or pairing', () => {
  for (const scenario of ['error', 'send-error', 'shutdown']) {
    const h = fixture(); h.execute({ key: 'KEY_UP', holdMs: 1000 });
    const socket = h.sockets[0];
    if (scenario === 'send-error') socket.sendError = new Error('private-fixture-token');
    h.connect();
    if (scenario === 'error') socket.emit('error', new Error('private-fixture-token'));
    if (scenario === 'shutdown') h.remote.close();
    assert.deepEqual(socket.sent.map(packet => packet.params.Cmd), ['Press', 'Release']);
    assert.ok(h.results[0].error);
    assert.equal(h.results[0].value, undefined);
    assert.equal(h.results[0].error.message.includes('private-fixture-token'), false);
    assert.equal(h.sockets.length, 1);
    assert.equal(socket.terminated, true);
  }
});

test('authorization failure, transport loss and deadlines never claim successful TV effects', () => {
  const denied = fixture(); denied.execute({ key: 'KEY_HOME' });
  denied.sockets[0].emit('message', JSON.stringify({ event: 'ms.channel.unauthorized', data: { token: 'secret' } }));
  assert.match(denied.results[0].error.message, /authorization refused/);
  assert.equal(denied.sockets[0].sent.length, 0);
  assert.equal(denied.sockets.length, 1);
  const lost = fixture(); lost.execute({ key: 'KEY_POWER', holdMs: 500 });
  const closedSocket = lost.connect(); closedSocket.readyState = 3; closedSocket.emit('close');
  assert.ok(lost.results[0].error);
  assert.equal(lost.results[0].value, undefined);
  const timed = fixture(); timed.execute({ key: 'KEY_POWER', holdMs: 500 });
  const socket = timed.sockets[0]; socket.stall = true; timed.connect();
  timed.advance(14500); assert.deepEqual(socket.sent.map(packet => packet.params.Cmd), ['Press', 'Release']);
  assert.equal(timed.results.length, 0);
  timed.advance(500); assert.equal(timed.results[0].error.code, 'REMOTE_TIMEOUT');
  assert.equal(socket.terminated, true);
  assert.equal(timed.timers.size, 0);
});

test('graceful close gets a bounded drain window without exceeding the hard deadline', () => {
  const h = fixture(); h.execute({ key: 'KEY_ENTER' });
  const socket = h.sockets[0]; socket.stallClose = true; h.connect();
  assert.equal(socket.closeRequested, true); assert.equal(socket.terminated, undefined);
  h.advance(249); assert.equal(h.results.length, 0);
  h.advance(1); assert.equal(socket.terminated, true); assert.equal(h.results[0].value.sent, true);
  assert.equal(h.timers.size, 0);
});

test('null, scalar, array and malformed remote messages cannot crash the service', () => {
  for (const payload of ['null', 'false', '[]', '{}', 'invalid']) {
    const h = fixture(); h.execute({ key: 'KEY_HOME' });
    assert.doesNotThrow(() => h.sockets[0].emit('message', payload));
    assert.match(h.results[0].error.message, /Invalid TV remote response/);
    assert.equal(h.sockets[0].sent.length, 0);
  }
});

test('transport diagnostics return only allowlisted codes, never private error text', () => {
  for (const code of ['ECONNREFUSED', 'ERR_SSL_DH_KEY_TOO_SMALL', 'wss://secret-token@example.invalid']) {
    const h = fixture(); h.execute({ key: 'KEY_HOME' });
    h.sockets[0].emit('error', Object.assign(new Error('private-fixture-token and private URL'), { code }));
    assert.equal(h.results[0].error.transportCode, code.startsWith('wss:') ? 'UNKNOWN' : code);
    assert.equal(h.results[0].error.message, 'TV remote connection failed');
    assert.equal(h.results[0].error.message.includes('private-fixture-token'), false);
  }
});

test('constructor diagnostic details redact raw and encoded tokens, URLs and control characters without stack output', () => {
  const token = 'secret/token?42';
  const h = fixture({ tvRemoteToken: token }, { WebSocket: function () {
    throw new TypeError('Unsupported function\nraw=' + token + ' encoded=' + encodeURIComponent(token) +
      ' wss://192.168.1.200:8002/path?token=' + encodeURIComponent(token) + '\x1b' + 'x'.repeat(300));
  } });
  h.execute({ key: 'KEY_HOME' });
  const error = h.results[0].error;
  assert.equal(error.transportCode, 'UNKNOWN');
  assert.ok(error.diagnosticDetail.startsWith('TypeError: Unsupported function'));
  assert.ok(error.diagnosticDetail.length <= 256);
  assert.equal(error.diagnosticDetail.includes(token), false);
  assert.equal(error.diagnosticDetail.includes(encodeURIComponent(token)), false);
  assert.equal(error.diagnosticDetail.includes('wss://'), false);
  assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(error.diagnosticDetail), false);
  assert.equal(error.diagnosticDetail.includes('at '), false);
  assert.equal(h.sockets.length, 0);
});

test('a private LAN target is accepted only when it is this TV process own noninternal IPv4 address', () => {
  const os = { networkInterfaces: () => ({ ethernet: [
    { family: 'IPv4', internal: false, address: '192.168.1.200' },
    { family: 4, internal: false, address: '192.168.1.201' },
    { family: 'IPv4', internal: true, address: '127.0.0.2' },
    { family: 'IPv6', internal: false, address: '::1' }
  ] }) };
  const local = fixture({ tvRemoteHost: '192.168.1.200' }, { os });
  local.execute({ key: 'KEY_HOME' }); local.connect();
  assert.ok(local.sockets[0].url.startsWith('wss://192.168.1.200:8002/'));
  for (const host of ['192.168.1.202', '127.0.0.2', 'external.example', '192.168.1.200@external.example', '::1']) {
    const rejected = fixture({ tvRemoteHost: host }, { os }); rejected.execute({ key: 'KEY_HOME' });
    assert.equal(rejected.remote.enabled, false);
    assert.equal(rejected.sockets.length, 0);
    assert.equal(rejected.results[0].error.code, 'REMOTE_UNAVAILABLE');
  }
  const unavailable = fixture({ tvRemoteHost: '192.168.1.200' }, { os: { networkInterfaces() { throw new Error('Denied'); } } });
  assert.equal(unavailable.remote.enabled, false);
});

test('unexpected HTTP handshake responses expose only static allowed status codes', () => {
  for (const status of [403, 503, 999]) {
    const h = fixture(); h.execute({ key: 'KEY_HOME' });
    h.sockets[0].emit('unexpected-response', {}, { statusCode: status, url: 'private-token' });
    assert.equal(h.results[0].error.transportCode, status === 999 ? 'UNKNOWN' : 'HTTP_' + status);
    assert.equal(h.results[0].error.message, 'TV remote handshake refused');
  }
});

test('the actual ws4 receiver rejects an oversized frame before delivering a message', async t => {
  const WebSocket = require('ws');
  const server = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  let receivedMessages = 0;
  let receiverLimit;
  const remote = create({ tvRemoteToken: 'test-token' }, { WebSocket: function (url, options) {
    assert.ok(url.startsWith('wss://127.0.0.1:8002/'));
    const socket = new WebSocket('ws://127.0.0.1:' + server.address().port, options);
    socket.on('open', () => { receiverLimit = socket._receiver._maxPayload; });
    socket.on('message', () => { receivedMessages++; });
    return socket;
  } });
  server.on('connection', socket => { socket.on('error', () => {}); socket.send('x'.repeat(8193)); });
  t.after(() => { remote.close(); server.clients.forEach(socket => socket.terminate()); server.close(); });
  const error = await new Promise(resolve => remote.execute({ key: 'KEY_HOME' }, resolve));
  assert.equal(receiverLimit, 8192);
  assert.equal(receivedMessages, 0);
  assert.equal(error.code, 'REMOTE_SEND_FAILED');
});

test('the actual ws4 peer receives Click and Press followed by Release before close', async t => {
  const WebSocket = require('ws');
  const server = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  const received = [];
  server.on('connection', socket => {
    socket.on('error', () => {});
    socket.on('message', value => received.push(JSON.parse(value)));
    socket.send('{"event":"ms.channel.connect"}');
  });
  const remote = create({ tvRemoteToken: 'fixture-token' }, { WebSocket: function (url, options) {
    assert.ok(url.startsWith('wss://127.0.0.1:8002/'));
    return new WebSocket('ws://127.0.0.1:' + server.address().port, options);
  } });
  t.after(() => { remote.close(); server.clients.forEach(socket => socket.terminate()); server.close(); });
  function execute(command) { return new Promise((resolve, reject) => remote.execute(command, (error, result) => error ? reject(error) : resolve(result))); }
  assert.equal((await execute({ key: 'KEY_HOME' })).sent, true);
  assert.equal((await execute({ key: 'KEY_UP', holdMs: 500 })).sent, true);
  assert.deepEqual(received.map(packet => packet.params.Cmd), ['Click', 'Press', 'Release']);
  assert.deepEqual(received.map(packet => packet.params.DataOfCmd), ['KEY_HOME', 'KEY_UP', 'KEY_UP']);
});
