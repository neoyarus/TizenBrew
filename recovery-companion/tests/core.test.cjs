'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const zlib = require('node:zlib');
const { EventEmitter, once } = require('node:events');
const { start, canonical, constants, validateWidgetAsync, validateManifest } = require('../service/core.cjs');
const { createClient } = require('../client/client.cjs');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const manifest = '<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets"><tizen:application id="xvvl3S1bvH.TizenBrewStandalone" package="xvvl3S1bvH"/></widget>';

function zip(entries = [{ name: 'config.xml', data: Buffer.from(manifest) }]) {
  const locals = [], records = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), plain = Buffer.from(entry.data);
    const data = entry.deflate ? zlib.deflateRawSync(plain) : plain;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    records.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function validate(body) { return new Promise((resolve, reject) => validateWidgetAsync(body, (error, value) => error ? reject(error) : resolve(value))); }
function signature(value, key = keys.privateKey) { return crypto.createSign('RSA-SHA256').update(value).sign(key, 'base64'); }
function fakeSocket() {
  const socket = new EventEmitter();
  socket.data = [];
  socket.setTimeout = (delay, callback) => { socket.idleDelay = delay; socket.idleCallback = callback; };
  socket.write = data => socket.data.push(data);
  socket.end = data => { if (data) socket.write(data); socket.destroy(); };
  socket.destroy = () => { if (socket.destroyed) return; socket.destroyed = true; socket.emit('close'); };
  socket.pipe = () => {};
  return socket;
}
function fixture() {
  let now = 1000, timerId = 0, handler;
  const timers = new Map(), files = new Map(), writes = [], commands = [], targets = [];
  const server = new EventEmitter();
  server.listen = (port, host) => { assert.equal(port, 8098); assert.equal(host, '0.0.0.0'); };
  server.close = () => { server.closed = true; };
  server.setTimeout = () => {};
  const shell = new EventEmitter(), adbStream = fakeSocket();
  const handle = start({ publicKey: keys.publicKey, tlsKey: 'private test stub', tlsCert: 'public test stub', port: 8098 }, {
    https: { createServer(options, fn) { assert.equal(options.secureProtocol, 'TLSv1_2_method'); assert.equal(options.handshakeTimeout, 10000); handler = fn; return server; } },
    fs: { existsSync: () => true, writeFileSync(path, data, options) { assert.equal(files.has(path), false); files.set(path, data); writes.push({ path, options }); }, unlinkSync: path => files.delete(path) },
    net: { connect(target) { targets.push(target); const socket = fakeSocket(); targets[targets.length - 1].socket = socket; return socket; } },
    adbhost: { createConnection(target) { assert.deepEqual(target, { host: '127.0.0.1', port: 26101 }); return { _stream: adbStream, createStream(command) { commands.push(command); return shell; } }; } },
    now: () => now,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  function request(method, route, body = Buffer.alloc(0), headers = {}, auth = true, emitEnd = true) {
    const req = new EventEmitter();
    req.method = method; req.url = route;
    req.headers = { 'content-length': String(body.length), ...headers };
    req.destroy = () => { req.destroyed = true; req.emit('aborted'); };
    if (auth) Object.assign(req.headers, authHeaders(method, route, body), headers);
    let complete;
    const res = { done: new Promise(resolve => { complete = resolve; }), writeHead(status) { res.status = status; }, end(data) { res.body = JSON.parse(data); res.finished = true; complete(res); } };
    handler(req, res);
    if (body.length) req.emit('data', body);
    if (emitEnd) req.emit('end');
    return { req, res };
  }
  function challenge() { return request('GET', '/challenge', Buffer.alloc(0), {}, false).res.body; }
  function authHeaders(method, route, body = Buffer.alloc(0), nonce = challenge().nonce) {
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    return { 'x-recovery-nonce': nonce, 'x-recovery-sha256': hash, 'x-recovery-bytes': String(body.length),
      'x-recovery-signature': signature(canonical(nonce, method, route, hash, body.length)) };
  }
  return { handle, server, files, writes, shell, commands, targets, timers, request, challenge, authHeaders,
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
    install(body = zip(), headers = {}) { return request('POST', '/install', body, { 'content-type': 'application/octet-stream', 'x-widget-signature': signature(body), ...headers }); },
    connect(headers, route = '/sdb', head = Buffer.alloc(0)) {
      const socket = fakeSocket();
      server.emit('secureConnection', socket);
      server.emit('connect', { method: 'CONNECT', url: route, headers: headers || authHeaders('CONNECT', route) }, socket, head);
      return socket;
    } };
}

test('challenges are unique, expire, and cannot be reused', () => {
  const h = fixture(), first = h.challenge(), second = h.challenge();
  assert.notEqual(first.nonce, second.nonce);
  const headers = h.authHeaders('GET', '/status', Buffer.alloc(0), first.nonce);
  assert.equal(h.request('GET', '/status', Buffer.alloc(0), headers, false).res.status, 200);
  assert.equal(h.request('GET', '/status', Buffer.alloc(0), headers, false).res.status, 401);
  const expired = h.authHeaders('GET', '/status', Buffer.alloc(0), second.nonce);
  h.advance(constants.NONCE_TTL);
  assert.equal(h.request('GET', '/status', Buffer.alloc(0), expired, false).res.status, 401);
});

test('authentication binds the method, exact path, body hash, and length', () => {
  for (const variation of [{ method: 'POST' }, { path: '/status?anything=1' }, { hash: 'b'.repeat(64) }, { bytes: '1' }]) {
    const h = fixture(), headers = h.authHeaders('GET', '/status');
    if (variation.hash) headers['x-recovery-sha256'] = variation.hash;
    if (variation.bytes) headers['x-recovery-bytes'] = variation.bytes;
    const result = h.request(variation.method || 'GET', variation.path || '/status', Buffer.alloc(0), headers, false);
    assert.equal(result.res.status, 401);
    assert.equal(h.commands.length, 0);
  }
});

test('public challenges are bounded and status logs require authentication', () => {
  const h = fixture();
  assert.equal(h.request('GET', '/status', Buffer.alloc(0), {}, false).res.status, 401);
  for (let i = 0; i < 32; i++) assert.ok(h.challenge().nonce);
  assert.equal(h.request('GET', '/challenge', Buffer.alloc(0), {}, false).res.status, 429);
  h.advance(30000);
  assert.equal(h.request('GET', '/challenge', Buffer.alloc(0), {}, false).res.status, 200);
});

test('stored and deflated manifests accept only the fixed target', async () => {
  for (const deflate of [false, true]) {
    assert.equal((await validate(zip([{ name: 'config.xml', data: Buffer.from(manifest), deflate }]))).packageId, constants.TARGET);
    await assert.rejects(validate(zip([{ name: 'config.xml', data: Buffer.from(manifest.replace(/xvvl3S1bvH/g, 'TbRecov001')), deflate }])));
  }
});

test('deflated manifest does not bypass later duplicate, unsafe, or malformed directory entries', async () => {
  for (const name of ['config.xml', '../escaped', '/absolute', 'bad\\path']) {
    await assert.rejects(validate(zip([{ name: 'config.xml', data: Buffer.from(manifest), deflate: true }, { name, data: Buffer.from('unexpected') }])));
  }
  const malformed = zip([{ name: 'config.xml', data: Buffer.from(manifest), deflate: true }, { name: 'icon.png', data: Buffer.from('icon') }]);
  const first = malformed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  malformed[first + 46 + 'config.xml'.length] = 0;
  await assert.rejects(validate(malformed));
});

test('namespace substitution, duplicate attributes, nested applications, DTD, and malformed XML are rejected', () => {
  const namespaceBypass = '<widget xmlns="http://www.w3.org/ns/widgets" xmlns:real="http://tizen.org/ns/widgets" xmlns:tizen="urn:fake"><real:application id="TbRecov001.RecoveryCompanion" package="TbRecov001"/><tizen:application id="xvvl3S1bvH.TizenBrewStandalone" package="xvvl3S1bvH"/></widget>';
  for (const xml of [namespaceBypass, manifest.replace('package="xvvl3S1bvH"', 'package="xvvl3S1bvH" package="TbRecov001"'), manifest.replace('<tizen:application', '<wrapper><tizen:application').replace('</widget>', '</wrapper></widget>'), '<!DOCTYPE widget>' + manifest, manifest.replace('</widget>', '')]) {
    assert.throws(() => validateManifest(Buffer.from(xml)));
  }
});

test('oversized compressed manifest is rejected without an unhandled stream error', async () => {
  const body = zip([{ name: 'config.xml', data: Buffer.from('x'.repeat(70000)), deflate: true }]);
  await assert.rejects(validate(body));
  const corrupt = zip([{ name: 'config.xml', data: Buffer.from(manifest), deflate: true }]);
  corrupt[30 + 'config.xml'.length] = 255;
  await assert.rejects(validate(corrupt));
});

test('signed target upload stages mode0600 and runs only the fixed localhost installer command', async () => {
  const h = fixture(), upload = h.install();
  await upload.res.done;
  assert.equal(upload.res.status, 202);
  assert.equal(h.writes[0].options.mode, 384);
  assert.equal(h.writes[0].options.flag, 'wx');
  assert.match(h.commands[0], /^shell:0 vd_appinstall xvvl3S1bvH \/home\/owner\/share\/tmp\/sdk_tools\/TizenBrew-recovery-[a-f0-9]{64}-[a-f0-9]{16}\.wgt$/);
  h.shell.emit('data', Buffer.from('install completed'));
  assert.equal(h.handle.state.result, 'completed');
  assert.equal(h.files.size, 0);
});

test('widget checksum, deployment signature, and companion target rejection happen before staging or SDB', async () => {
  for (const kind of ['signature', 'checksum', 'target']) {
    const h = fixture();
    const body = kind === 'target' ? zip([{ name: 'config.xml', data: Buffer.from(manifest.replace(/xvvl3S1bvH/g, 'TbRecov001')) }]) : zip();
    let result;
    if (kind === 'signature') result = h.install(body, { 'x-widget-signature': signature(Buffer.from('different body')) });
    else if (kind === 'checksum') {
      const headers = h.authHeaders('POST', '/install', Buffer.from('different body'));
      headers['x-recovery-bytes'] = String(body.length);
      headers['x-recovery-signature'] = signature(canonical(headers['x-recovery-nonce'], 'POST', '/install', headers['x-recovery-sha256'], body.length));
      result = h.request('POST', '/install', body, { ...headers, 'content-type': 'application/octet-stream', 'x-widget-signature': signature(body) }, false);
    } else result = h.install(body);
    await result.res.done;
    assert.ok([400, 401].includes(result.res.status));
    assert.equal(h.files.size, 0);
    assert.equal(h.commands.length, 0);
  }
});

test('inconclusive installer keeps its staged bytes and blocks another update', async () => {
  const h = fixture();
  await h.install().res.done;
  h.advance(120000);
  assert.equal(h.handle.state.result, 'inconclusive');
  assert.equal(h.files.size, 1);
  assert.equal(h.install().res.status, 409);
  assert.equal(h.commands.length, 1);
});

test('an aborted upload releases its slot without staging partial bytes', async () => {
  const h = fixture(), body = zip();
  const headers = { ...h.authHeaders('POST', '/install', body), 'content-type': 'application/octet-stream', 'x-widget-signature': signature(body) };
  const upload = h.request('POST', '/install', body, headers, false, false);
  upload.req.emit('aborted');
  assert.equal(h.files.size, 0);
  await h.install().res.done;
  assert.equal(h.commands.length, 1);
});

test('unauthenticated or altered tunnel requests cannot connect to any destination', () => {
  const h = fixture();
  assert.match(h.connect({}).data.join(''), /401/);
  const headers = h.authHeaders('CONNECT', '/sdb');
  assert.match(h.connect(headers, '/sdb?host=remote').data.join(''), /401/);
  assert.equal(h.targets.length, 0);
});

test('authenticated tunnels have a fixed destination, a two-connection cap, idle deadline and hard TTL', () => {
  const h = fixture(), first = h.connect(), second = h.connect(), third = h.connect();
  assert.equal(h.targets.length, 2);
  assert.match(third.data.join(''), /409/);
  for (const target of h.targets) {
    assert.equal(target.host, '127.0.0.1');
    assert.equal(target.port, 26101);
    assert.equal(target.socket.idleDelay, 30000);
    target.socket.emit('connect');
  }
  assert.match(first.data.join(''), /200 Connection Established/);
  assert.equal(first.idleDelay, 30000);
  h.advance(constants.TUNNEL_TTL);
  assert.ok(first.destroyed && second.destroyed && h.targets.every(target => target.socket.destroyed));
  assert.equal(h.request('GET', '/status').res.body.tunnels, 0);
});

test('closing or listener failure exposes a closed handle and destroys all tunnel sockets', () => {
  for (const failure of [false, true]) {
    const h = fixture(), socket = h.connect();
    if (failure) h.server.emit('error', new Error('Address unavailable')); else h.handle.close();
    assert.equal(h.handle.isClosed(), true);
    assert.ok(socket.destroyed && h.targets[0].socket.destroyed);
    assert.equal(h.server.closed, true);
  }
});

test('real pinned TLS client rejects wrong pin and wrong key, and proxies raw TCP only to the stubbed local SDB', async t => {
  const forge = require('node-forge');
  const tlsKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(tlsKeys.publicKey);
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60000);
  certificate.validity.notAfter = new Date(Date.now() + 3600000);
  certificate.setSubject([{ name: 'commonName', value: 'localhost' }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.sign(forge.pki.privateKeyFromPem(tlsKeys.privateKey), forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(certificate);
  const certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(), 'binary');
  const fixtureKey = require('node:path').join(require('node:os').tmpdir(), 'recovery-fixture-' + crypto.randomBytes(8).toString('hex') + '.pem');
  fs.writeFileSync(fixtureKey, keys.privateKey, { mode: 384 });
  t.after(() => fs.unlinkSync(fixtureKey));
  const serverConfig = { publicKey: keys.publicKey, tlsKey: tlsKeys.privateKey, tlsCert: certPem, port: 8098 };
  const clientConfig = { privateKeyPath: fixtureKey, certificateSha256: crypto.createHash('sha256').update(certDer).digest('hex') };
  const echo = net.createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); });
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const destinations = [];
  let receivedHttpRequests = 0;
  const handle = start(serverConfig, { https: { createServer(options, handler) {
    const server = https.createServer(options, (request, response) => { receivedHttpRequests++; handler(request, response); }), listen = server.listen.bind(server);
    server.listen = () => listen(0, '127.0.0.1');
    return server;
  } }, now: () => Date.now() - 86400000, net: { connect(target) { destinations.push(target); return net.connect(echo.address().port, '127.0.0.1'); } } });
  await once(handle.server, 'listening');
  const good = { ...clientConfig, host: '127.0.0.1', port: handle.server.address().port };
  const client = createClient(good);
  t.after(() => { client.close(); handle.close(); echo.close(); });
  assert.equal((await client.status()).target, constants.TARGET);
  const countBeforeBadPin = receivedHttpRequests;
  const badPin = createClient({ ...good, certificateSha256: '0'.repeat(64) });
  await assert.rejects(badPin.status(), /pin mismatch/);
  badPin.close();
  assert.equal(receivedHttpRequests, countBeforeBadPin, 'a wrong pin must be rejected before any HTTP request is sent');
  const tempKey = require('node:path').join(require('node:os').tmpdir(), 'recovery-test-' + crypto.randomBytes(8).toString('hex') + '.pem');
  fs.writeFileSync(tempKey, tlsKeys.privateKey, { mode: 384 });
  const badKey = createClient({ ...good, privateKeyPath: tempKey });
  try { await assert.rejects(badKey.status(), /401/); } finally { badKey.close(); fs.unlinkSync(tempKey); }
  const tunnel = await client.tunnel(26102);
  const socket = net.connect(26102, '127.0.0.1');
  const data = once(socket, 'data');
  socket.on('error', () => {});
  socket.write(Buffer.from('opaque SDB payload'));
  assert.equal((await data)[0].toString(), 'opaque SDB payload');
  assert.deepEqual(destinations, [{ host: '127.0.0.1', port: 26101 }]);
  socket.destroy();
  tunnel.close();
  const launches = [];
  const launchHttp = { request(options, callback) {
    launches.push(options);
    const request = new EventEmitter();
    request.destroy = error => request.emit('error', error);
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('end');
      request.emit('close');
    };
    return request;
  } };
  const starter = createClient(good, { http: launchHttp });
  assert.equal((await starter.start()).ready, true);
  assert.deepEqual(launches[0], { host: '127.0.0.1', port: 8001, method: 'POST', path: '/api/v2/applications/TbRecov001.RecoveryCompanion', headers: { 'Content-Length': '0' } });
  starter.close();
  const rejectedStarter = createClient({ ...good, certificateSha256: '0'.repeat(64) }, { http: launchHttp });
  await assert.rejects(rejectedStarter.start(), /pin mismatch/);
  rejectedStarter.close();
  assert.equal(launches.length, 2, 'the failed readiness probe cannot trigger another native launch');
});
