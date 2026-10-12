'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const https = require('node:https');
const tls = require('node:tls');
const { EventEmitter, once } = require('node:events');
const { createClient } = require('../client/client.cjs');
const { createNativeRemote } = require('../client/nativeRemote.cjs');

test('native remote is explicit, requires a pin and uses only the configured TV host without companion HTTP', async t => {
  const keyPath = require('node:path').join(require('node:os').tmpdir(), 'native-client-' + crypto.randomBytes(8).toString('hex'));
  fs.writeFileSync(keyPath, 'unused companion private key', { mode: 384 }); t.after(() => fs.unlinkSync(keyPath));
  const urls = [];
  class NativeSocket extends EventEmitter {
    constructor(url, options) { super(); this.readyState = 1; urls.push(url); assert.ok(options.agent); process.nextTick(() => this.emit('message', '{"event":"ms.channel.connect"}')); }
    send(packet, callback) { assert.equal(JSON.parse(packet).params.Cmd, 'Click'); callback(); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() {}
  }
  const config = { host: '192.168.1.200', port: 8098, certificateSha256: '0'.repeat(64), privateKeyPath: keyPath,
    tvRemoteToken: 'native-private-token', tvRemoteName: 'HomeAssistant', tvRemoteCertificateSha256: '1'.repeat(64) };
  const client = createClient(config, { nativeRemote: { WebSocket: NativeSocket }, http: { request() { throw new Error('Native mode must not launch companion'); } } });
  t.after(() => client.close());
  const result = await client.remote('KEY_ENTER');
  assert.equal(result.source, 'pc-native'); assert.equal(result.sent, true);
  assert.ok(urls[0].startsWith('wss://192.168.1.200:8002/'));
  assert.equal(JSON.stringify(result).includes('native-private-token'), false);
  await assert.rejects(async () => client.remote('KEY_ENTER', 1), /Invalid remote command/);
  assert.throws(() => createNativeRemote({ ...config, tvRemoteCertificateSha256: undefined }), /Invalid private/);
  assert.throws(() => createNativeRemote({ ...config, host: 'trusted@evil.example' }), /Invalid private/);
});

test('native TLS pin is verified before any token-bearing WebSocket upgrade; failure never falls back', async t => {
  const forge = require('node-forge'), WebSocket = require('ws');
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const certificate = forge.pki.createCertificate(); certificate.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  certificate.serialNumber = '02'; certificate.validity.notBefore = new Date(Date.now() - 60000); certificate.validity.notAfter = new Date(Date.now() + 3600000);
  certificate.setSubject([{ name: 'commonName', value: 'native-test' }]); certificate.setIssuer(certificate.subject.attributes);
  certificate.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(certificate), certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(), 'binary');
  const server = https.createServer({ key: keys.privateKey, cert: certPem });
  const native = new WebSocket.Server({ server });
  let upgrades = 0; const packets = [];
  native.on('connection', socket => { upgrades++; socket.on('error', () => {}); socket.on('message', packet => packets.push(JSON.parse(packet))); socket.send('{"event":"ms.channel.connect"}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const dependencies = { tls: { connect(options) { assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 8002); return tls.connect({ ...options, port: server.address().port }); } } };
  const config = { host: '127.0.0.1', tvRemoteToken: 'only-after-pin', tvRemoteCertificateSha256: crypto.createHash('sha256').update(certDer).digest('hex') };
  const good = createNativeRemote(config, dependencies), wrongPin = createNativeRemote({ ...config, tvRemoteCertificateSha256: '0'.repeat(64) }, dependencies);
  t.after(() => { good.close(); wrongPin.close(); native.clients.forEach(socket => socket.terminate()); native.close(); server.close(); });
  await assert.rejects(wrongPin.execute({ key: 'KEY_HOME' }), error => error.transportCode === 'TLS_PIN_MISMATCH');
  assert.equal(upgrades, 0, 'wrong pin must not send the token-bearing upgrade request');
  assert.equal((await good.execute({ key: 'KEY_HOME' })).source, 'pc-native');
  assert.equal(upgrades, 1); assert.equal(packets[0].params.DataOfCmd, 'KEY_HOME');
  assert.equal((await good.execute({ key: 'KEY_UP', holdMs: 500 })).sent, true);
  assert.deepEqual(packets.map(packet => packet.params.Cmd), ['Click', 'Press', 'Release']);
});

test('pinned native transport consumes an authorization frame coalesced with HTTP101', async t => {
  const forge = require('node-forge');
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const certificate = forge.pki.createCertificate(); certificate.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  certificate.serialNumber = '03'; certificate.validity.notBefore = new Date(Date.now() - 60000); certificate.validity.notAfter = new Date(Date.now() + 3600000);
  certificate.setSubject([{ name: 'commonName', value: 'coalesced-native-test' }]); certificate.setIssuer(certificate.subject.attributes);
  certificate.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(certificate), certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(), 'binary');
  const server = https.createServer({ key: keys.privateKey, cert: certPem });
  const sockets = new Set(), packets = [], headLengths = [];
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const header = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const auth = Buffer.from('{"event":"ms.channel.connect"}');
    // A single TLS write deliberately puts the first message in the HTTP parser's head.
    socket.write(Buffer.concat([header, Buffer.from([0x81, auth.length]), auth]));
    let incoming = Buffer.alloc(0);
    socket.on('data', data => {
      incoming = Buffer.concat([incoming, data]);
      while (incoming.length >= 6) {
        const marker = incoming[1] & 0x7f, maskOffset = marker === 126 ? 4 : 2;
        assert.ok(marker < 127 && incoming[1] & 0x80, 'fixture expects bounded masked client frames');
        const length = marker === 126 ? incoming.readUInt16BE(2) : marker;
        if (incoming.length < maskOffset + 4 + length) return;
        const payload = Buffer.from(incoming.subarray(maskOffset + 4, maskOffset + 4 + length));
        for (let index = 0; index < length; index++) payload[index] ^= incoming[maskOffset + index % 4];
        const opcode = incoming[0] & 0x0f; incoming = incoming.subarray(maskOffset + 4 + length);
        if (opcode === 1) packets.push(JSON.parse(payload.toString()));
        if (opcode === 8) socket.end();
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const WebSocket = require('ws');
  class TracedWebSocket extends WebSocket {
    setSocket(socket, head, limit) { headLengths.push(head.length); return super.setSocket(socket, head, limit); }
  }
  const remote = createNativeRemote({ host: '127.0.0.1', tvRemoteToken: 'ephemeral-coalesced-token', tvRemoteCertificateSha256: crypto.createHash('sha256').update(certDer).digest('hex') }, {
    WebSocket: TracedWebSocket,
    tls: { connect(options) { return tls.connect({ ...options, port: server.address().port }); } }
  });
  t.after(() => { remote.close(); sockets.forEach(socket => socket.destroy()); server.close(); });
  assert.equal((await remote.execute({ key: 'KEY_ENTER' })).sent, true);
  assert.deepEqual(packets.map(packet => packet.params.Cmd), ['Click']);
  assert.ok(headLengths[0] > 0, 'authorization frame must reach ws through the HTTP upgrade head');
});
