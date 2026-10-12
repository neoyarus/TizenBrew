'use strict';

// Keep this source compatible with the TV's Node 4.4 runtime.
var https = require('https');
var crypto = require('crypto');
var fs = require('fs');
var net = require('net');
var zlib = require('zlib');
var TARGET = 'xvvl3S1bvH';
var APP_ID = TARGET + '.TizenBrewStandalone';
var STAGE = '/home/owner/share/tmp/sdk_tools';
var LIMIT = 8 * 1024 * 1024;
var EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');
var NONCE_TTL = 30000;
var TUNNEL_TTL = 300000;

function canonical(nonce, method, route, hash, bytes) {
  return ['TBRC1', nonce, method, route, hash, String(bytes), ''].join('\n');
}

function signatureValid(key, value, signature) {
  if (typeof signature !== 'string' || signature.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  try { return crypto.createVerify('RSA-SHA256').update(value).verify(key, signature, 'base64'); }
  catch (error) { return false; }
}

function validateWidget(body) {
  // Read only the bounded manifest from the ZIP. Never extract an uploaded archive.
  if (!Buffer.isBuffer(body) || body.length < 22 || body.length > LIMIT) throw new Error('Invalid widget');
  var end = -1;
  for (var offset = body.length - 22; offset >= Math.max(0, body.length - 65557); offset--) {
    if (body.readUInt32LE(offset) === 0x06054b50 && offset + 22 + body.readUInt16LE(offset + 20) === body.length) { end = offset; break; }
  }
  if (end < 0 || body.readUInt16LE(end + 4) || body.readUInt16LE(end + 6)) throw new Error('Invalid ZIP');
  var count = body.readUInt16LE(end + 10);
  var size = body.readUInt32LE(end + 12);
  var start = body.readUInt32LE(end + 16);
  if (!count || count > 512 || body.readUInt16LE(end + 8) !== count || start + size !== end) throw new Error('Invalid ZIP directory');
  var cursor = start;
  var manifest = null;
  var deflated = null;
  var names = Object.create(null);
  for (var i = 0; i < count; i++) {
    if (cursor + 46 > end || body.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    var flags = body.readUInt16LE(cursor + 8);
    var method = body.readUInt16LE(cursor + 10);
    var compressed = body.readUInt32LE(cursor + 20);
    var plain = body.readUInt32LE(cursor + 24);
    var nameLength = body.readUInt16LE(cursor + 28);
    var next = cursor + 46 + nameLength + body.readUInt16LE(cursor + 30) + body.readUInt16LE(cursor + 32);
    var local = body.readUInt32LE(cursor + 42);
    if (next > end || flags & 1 || body.readUInt16LE(cursor + 34)) throw new Error('Unsupported ZIP entry');
    var name = body.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (!name || name.indexOf('\x00') !== -1 || name.charAt(0) === '/' || name.indexOf('\\') !== -1 || name.split('/').indexOf('..') !== -1 || names[name]) throw new Error('Unsafe ZIP name');
    names[name] = true;
    if (name === 'config.xml') {
      if (plain < 1 || plain > 65536 || compressed > 131072 || local + 30 > start || body.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid manifest entry');
      if (body.readUInt16LE(local + 6) !== flags || body.readUInt16LE(local + 8) !== method) throw new Error('ZIP manifest mismatch');
      var localNameLength = body.readUInt16LE(local + 26);
      var dataStart = local + 30 + localNameLength + body.readUInt16LE(local + 28);
      if (body.toString('utf8', local + 30, local + 30 + localNameLength) !== name || dataStart + compressed > start) throw new Error('ZIP manifest mismatch');
      var data = body.slice(dataStart, dataStart + compressed);
      if (method === 0) manifest = data;
      else if (method === 8) {
        // Node 4 has no maxOutputLength option. Bound inflate input/output by streaming below.
        deflated = { compressedManifest: data, expectedLength: plain };
      } else throw new Error('Unsupported manifest compression');
      if (manifest && manifest.length !== plain) throw new Error('Manifest size mismatch');
    }
    cursor = next;
  }
  if (cursor !== end || !manifest && !deflated) throw new Error('Missing manifest');
  if (deflated) return deflated;
  return validateManifest(manifest);
}

function validateManifest(data) {
  if (data.length > 65536) throw new Error('Manifest limit');
  var xml = data.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|\x00/i.test(xml)) throw new Error('Unsupported manifest');
  var parser = require('sax').parser(true, { xmlns: true });
  var depth = 0;
  var applications = 0;
  var roots = 0;
  var attributes;
  parser.onopentagstart = function () { attributes = Object.create(null); };
  parser.onattribute = function (attribute) {
    if (attributes[attribute.name]) throw new Error('Duplicate manifest attribute');
    attributes[attribute.name] = true;
  };
  parser.onopentag = function (tag) {
    if (depth === 0) {
      roots++;
      if (roots !== 1 || tag.local !== 'widget' || tag.uri !== 'http://www.w3.org/ns/widgets') throw new Error('Invalid widget root');
    }
    if (tag.local === 'application') {
      applications++;
      if (applications !== 1 || depth !== 1 || tag.uri !== 'http://tizen.org/ns/widgets' ||
          !tag.attributes.package || tag.attributes.package.uri || tag.attributes.package.value !== TARGET ||
          !tag.attributes.id || tag.attributes.id.uri || tag.attributes.id.value !== APP_ID) throw new Error('Wrong package');
    }
    if (++depth > 32) throw new Error('Manifest depth limit');
  };
  parser.onclosetag = function () { depth--; };
  parser.onerror = function () { throw new Error('Malformed manifest'); };
  parser.write(xml).close();
  if (roots !== 1 || applications !== 1 || depth !== 0) throw new Error('Invalid application manifest');
  return { packageId: TARGET, appId: APP_ID };
}

function validateWidgetAsync(body, callback) {
  var result;
  try { result = validateWidget(body); } catch (error) { return callback(error); }
  if (!result.compressedManifest) return callback(null, result);
  var inflate = zlib.createInflateRaw();
  var chunks = [];
  var size = 0;
  var finished = false;
  function finish(error, value) {
    if (finished) return;
    finished = true;
    inflate.removeAllListeners();
    inflate.on('error', function () {});
    if (error) {
      // Zlib streams on Node 4 expose close(), but not destroy().
      try { if (inflate.destroy) inflate.destroy(); else { inflate.pause(); inflate.close(); } } catch (ignored) {}
    }
    callback(error, value);
  }
  inflate.on('error', function () { finish(new Error('Invalid compressed manifest')); });
  inflate.on('data', function (chunk) {
    size += chunk.length;
    if (size > result.expectedLength || size > 65536) return finish(new Error('Manifest limit'));
    chunks.push(chunk);
  });
  inflate.on('end', function () {
    if (size !== result.expectedLength) return finish(new Error('Manifest size mismatch'));
    try { finish(null, validateManifest(Buffer.concat(chunks))); } catch (error) { finish(error); }
  });
  inflate.end(result.compressedManifest);
}

function start(options, dependencies) {
  if (!options || typeof options.publicKey !== 'string' || !/^-----BEGIN (RSA )?PUBLIC KEY-----/.test(options.publicKey) || !options.tlsKey || !options.tlsCert) throw new Error('Invalid recovery configuration');
  var port = options.port === undefined ? 8098 : options.port;
  if (port !== 8098) throw new Error('Invalid recovery port');
  var deps = dependencies || {};
  var disk = deps.fs || fs;
  var tcp = deps.net || net;
  var random = deps.randomBytes || crypto.randomBytes;
  var now = deps.now || Date.now;
  var later = deps.setTimeout || setTimeout;
  var cancel = deps.clearTimeout || clearTimeout;
  var nonces = Object.create(null);
  var issuanceStart = now();
  var issued = 0;
  var sockets = [];
  var tunnels = [];
  var uploadBusy = false;
  var closed = false;
  var installClient;
  var installTimer;
  var state = { phase: 'ready', operation: 0, result: null, log: '', tunnels: 0 };

  function send(response, status, value) {
    if (response.finished || response.writableEnded || response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
    response.end(JSON.stringify(value));
  }
  function prune() { Object.keys(nonces).forEach(function (nonce) { if (nonces[nonce] <= now()) delete nonces[nonce]; }); }
  function authenticate(request) {
    prune();
    var nonce = request.headers['x-recovery-nonce'];
    var hash = request.headers['x-recovery-sha256'];
    var bytes = request.headers['x-recovery-bytes'];
    if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce) || !nonces[nonce] || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || typeof bytes !== 'string' || !/^(0|[1-9][0-9]{0,7})$/.test(bytes)) return null;
    if (!signatureValid(options.publicKey, canonical(nonce, request.method, request.url, hash, bytes), request.headers['x-recovery-signature'])) return null;
    delete nonces[nonce];
    return { hash: hash, bytes: Number(bytes) };
  }
  function empty(request, auth) {
    return auth && auth.bytes === 0 && auth.hash === EMPTY_HASH && !request.headers['transfer-encoding'] && (!request.headers['content-length'] || request.headers['content-length'] === '0');
  }
  function directory(path) {
    if (disk.existsSync(path)) return;
    directory(path.slice(0, path.lastIndexOf('/')) || '/');
    disk.mkdirSync(path, 448);
  }
  function install(body, hash) {
    var stagePath = STAGE + '/TizenBrew-recovery-' + hash + '-' + random(8).toString('hex') + '.wgt';
    var settled = false;
    state.operation++;
    state.phase = 'installing';
    state.result = null;
    state.log = '';
    function finish(result) {
      if (settled) return;
      settled = true;
      cancel(installTimer);
      state.result = result;
      state.phase = result;
      if (installClient && installClient._stream) installClient._stream.destroy();
      // An inconclusive installer may still be running on the OS; do not launch another.
      if (result !== 'inconclusive') uploadBusy = false;
      if (result !== 'inconclusive') { try { disk.unlinkSync(stagePath); } catch (error) {} }
    }
    try {
      directory(STAGE);
      disk.writeFileSync(stagePath, body, { flag: 'wx', mode: 384 });
      var adb = deps.adbhost || require('adbhost');
      installClient = adb.createConnection({ host: '127.0.0.1', port: 26101 });
      installTimer = later(function () { finish('inconclusive'); }, 120000);
      installClient._stream.on('error', function () { finish('inconclusive'); });
      installClient._stream.on('close', function () { finish('inconclusive'); });
      var shell = installClient.createStream('shell:0 vd_appinstall ' + TARGET + ' ' + stagePath);
      shell.on('data', function (chunk) {
        if (settled) return;
        state.log = (state.log + chunk.toString()).slice(-65536);
        if (/install failed|installation failed/i.test(state.log)) finish('failed');
        else if (/install completed|successfully installed/i.test(state.log)) finish('completed');
      });
      shell.on('error', function () { finish('inconclusive'); });
      shell.on('finish', function () { finish('inconclusive'); });
      shell.on('end', function () { finish('inconclusive'); });
      shell.on('close', function () { finish('inconclusive'); });
    } catch (error) { finish('failed'); }
  }

  var server = (deps.https || https).createServer({ key: options.tlsKey, cert: options.tlsCert, secureProtocol: 'TLSv1_2_method', handshakeTimeout: 10000 }, function (request, response) {
    if (request.socket) cancel(request.socket.recoveryHeaderTimer);
    if (closed) return send(response, 503, { error: 'Unavailable' });
    if (request.method === 'GET' && request.url === '/challenge') {
      prune();
      if (now() - issuanceStart >= 60000) { issuanceStart = now(); issued = 0; }
      if (issued >= 128 || Object.keys(nonces).length >= 32) return send(response, 429, { error: 'Challenge limit' });
      var nonce = random(32).toString('hex');
      if (nonces[nonce]) return send(response, 503, { error: 'Challenge unavailable' });
      var expires = now() + NONCE_TTL;
      nonces[nonce] = expires;
      issued++;
      return send(response, 200, { protocol: 'TBRC1', nonce: nonce, expiresAt: expires });
    }
    var auth = authenticate(request);
    if (!auth) return send(response, 401, { error: 'Authentication required' });
    if (request.method === 'GET' && request.url === '/status') {
      if (!empty(request, auth)) return send(response, 400, { error: 'Empty body required' });
      return send(response, 200, { phase: state.phase, operation: state.operation, result: state.result, log: state.log, tunnels: tunnels.length, target: TARGET });
    }
    if (request.method !== 'POST' || request.url !== '/install') return send(response, 404, { error: 'Unknown route' });
    if (uploadBusy) return send(response, 409, { error: 'Installer unavailable' });
    if (auth.bytes < 1 || auth.bytes > LIMIT || request.headers['content-length'] !== String(auth.bytes) || request.headers['transfer-encoding'] || request.headers['content-type'] !== 'application/octet-stream') return send(response, 400, { error: 'Invalid widget body' });
    uploadBusy = true;
    var chunks = [];
    var size = 0;
    var ended = false;
    var timer = later(function () { abort(); request.destroy(); }, 30000);
    function abort() { if (ended) return; ended = true; cancel(timer); chunks = []; uploadBusy = false; }
    request.on('aborted', abort);
    request.on('error', abort);
    request.on('data', function (chunk) {
      if (ended) return;
      size += chunk.length;
      if (size > auth.bytes) { abort(); send(response, 413, { error: 'Widget size limit' }); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', function () {
      if (ended) return;
      ended = true;
      cancel(timer);
      var body = Buffer.concat(chunks);
      chunks = [];
      function reject(status, message) { uploadBusy = false; send(response, status, { error: message }); }
      if (size !== auth.bytes || crypto.createHash('sha256').update(body).digest('hex') !== auth.hash) return reject(400, 'Widget checksum mismatch');
      if (!signatureValid(options.publicKey, body, request.headers['x-widget-signature'])) return reject(401, 'Widget signature invalid');
      validateWidgetAsync(body, function (error) {
        if (closed) return reject(503, 'Unavailable');
        if (error) return reject(400, 'Widget target invalid');
        install(body, auth.hash);
        send(response, state.phase === 'failed' ? 500 : 202, { accepted: state.phase !== 'failed', operation: state.operation });
      });
    });
  });

  server.on('connect', function (request, socket, head) {
    cancel(socket.recoveryHeaderTimer);
    var auth = authenticate(request);
    function refuse(status) { socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
    if (!auth) return refuse('401 Unauthorized');
    if (request.url !== '/sdb' || !empty(request, auth) || head && head.length) return refuse('400 Bad Request');
    if (closed || uploadBusy || tunnels.length >= 2) return refuse('409 Conflict');
    var destination;
    var tunnel = { client: socket, destination: null, timer: null, closed: false };
    tunnels.push(tunnel);
    function closeTunnel() {
      if (tunnel.closed) return;
      tunnel.closed = true;
      cancel(tunnel.timer);
      var index = tunnels.indexOf(tunnel);
      if (index !== -1) tunnels.splice(index, 1);
      socket.destroy();
      if (destination) destination.destroy();
    }
    tunnel.close = closeTunnel;
    tunnel.timer = later(closeTunnel, TUNNEL_TTL);
    socket.setTimeout(30000, closeTunnel);
    socket.on('error', closeTunnel);
    socket.on('close', closeTunnel);
    try {
      destination = tunnel.destination = tcp.connect({ host: '127.0.0.1', port: 26101 });
      destination.setTimeout(30000, closeTunnel);
      destination.on('error', closeTunnel);
      destination.on('close', closeTunnel);
      destination.on('connect', function () {
        if (tunnel.closed || closed) return closeTunnel();
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.pipe(destination);
        destination.pipe(socket);
      });
    } catch (error) { closeTunnel(); }
  });
  server.maxConnections = 8;
  server.maxHeadersCount = 24;
  server.setTimeout(20000, function (socket) { socket.destroy(); });
  server.on('secureConnection', function (socket) {
    sockets.push(socket);
    socket.recoveryHeaderTimer = later(function () { socket.destroy(); }, 10000);
    socket.on('close', function () { cancel(socket.recoveryHeaderTimer); var index = sockets.indexOf(socket); if (index !== -1) sockets.splice(index, 1); });
  });
  server.on('tlsClientError', function (error, socket) { if (socket) socket.destroy(); });
  server.on('error', function () { close(); });
  function close() {
    if (closed) return;
    closed = true;
    nonces = Object.create(null);
    cancel(installTimer);
    tunnels.slice().forEach(function (tunnel) { tunnel.close(); });
    sockets.slice().forEach(function (socket) { socket.destroy(); });
    if (installClient && installClient._stream) installClient._stream.destroy();
    try { server.close(); } catch (error) {}
  }
  server.listen(port, '0.0.0.0');
  return { close: close, server: server, state: state, isClosed: function () { return closed; } };
}

module.exports = { start: start, canonical: canonical, validateManifest: validateManifest, validateWidget: validateWidget,
  validateWidgetAsync: validateWidgetAsync, constants: { TARGET: TARGET, APP_ID: APP_ID, LIMIT: LIMIT, EMPTY_HASH: EMPTY_HASH, NONCE_TTL: NONCE_TTL, TUNNEL_TTL: TUNNEL_TTL } };
