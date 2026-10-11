(function (__dirname) {
/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 447:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var AdbHostClient = __nccwpck_require__(104);

function createConnection(opts) {
  return new AdbHostClient(opts);
}

module.exports.createConnection = createConnection;

/***/ }),

/***/ 104:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var util         = __nccwpck_require__(23);
var EventEmitter = (__nccwpck_require__(53).EventEmitter);
var net          = __nccwpck_require__(278);
var stream       = __nccwpck_require__(203);
var AdbStream    = __nccwpck_require__(539);
var AdbPacket    = __nccwpck_require__(763);
var commands = AdbPacket.commands;

function streamFromOpts(opts) {
  var stream;
  if (opts && opts.stream)
    return stream;
  if (opts && (opts.path || opts.host || opts.port)) {
    if (opts.path)
      stream = net.connect(opts.path);
    else {
      if (opts.host && !opts.port)
         opts.port = 5555;
      stream = net.connect(opts.port, opts.host);
    }
    return stream;
  }
  // TODO: throw exception
  return null;
}

function AdbHostClient(opts) {
  if (!(this instanceof AdbHostClient)) return new AdbHostClient(opts);
  EventEmitter.call(this);
  this._stream = streamFromOpts(opts);
  this._packet = null;
  this._waitHeader = true;
  this._nextStreamId = 12345;
  this._userStreams = {};
  this._state = 0;
  var self = this;
  this._stream.on('readable', function() {
    while(1) {
      if (self._waitHeader) {
        var header = self._stream.read(24);
        if (header) {
          self._packet = AdbPacket.fromBuffer(header);
          if (self._packet.dataLength == 0) {
            self._onPacket(self.packet);
          } else {
            self._waitHeader = false;
          }
        } else break;
      } else {
        var data = self._stream.read(self._packet.dataLength);
        if (data) {
          self._packet.data = data;
          // TODO verify crc integrity here
          // self._packet.checkCRC();
          self._onPacket();
          self._waitHeader = true;
        } else break;
      }
    }
  });
  this._stream.on('connect', function() {
    self._state = 1;
    self._connected = true;
    // TODO: move version, maxdata, system-identity-string to options + set defaults
    self._writePacket(commands.CNXN, 0x01000000, 4096, 'host::');
  });
}
util.inherits(AdbHostClient, EventEmitter);

AdbHostClient.prototype._writePacket = function(type, arg1, arg2, data) {
  if (!this._connected)
    this._stream.once('connect', this._writePacket.bind(this, type, arg1, arg2, data));
  else {
    var cmd = Buffer(4); cmd.writeUInt32LE(type, 0);
    //console.log('WRITE:', cmd.toString(), arg1, arg2, data);
    this._stream.write(new AdbPacket(type, arg1, arg2, data).toBuffer());
  }
}

// dispatch incoming packets
AdbHostClient.prototype._onPacket = function() {
  packet = this._packet;
  //console.log('PACKET:', packet.toString());
  switch(packet.command) {
  case commands.WRTE:
    var localId = packet.arg2;
    var userStream = this._userStreams[localId];
    // TODO if (!stream)
    userStream.push(packet.data);
    // TODO handle user stream backpressure.
    this._writePacket(commands.OKAY, userStream.localId(), userStream.remoteId());
    break;
  case commands.OKAY:
    //console.log('OKAY: ', packet.arg1, packet.arg2);
    var localId = packet.arg2;
    var userStream = this._userStreams[localId];
    if (userStream._remoteId == -1) { // this is OK reply to OPEN
      userStream._remoteId = packet.arg1;
      this.emit('_CNXN'); // TODO: is there 'open' event in Stream2 ?
    }
    // TODO: handle backpressure
    break;
  case commands.CNXN:
    this._hostVersion = packet.arg1;
    this._hostMaxData = packet.arg2;
    this._banner = packet.data.toString().split(':');
    this._state = 2;
    this.emit('connect');
    break;
  case commands.CLSE:
    var localId = packet.arg2;
    var userStream = this._userStreams[localId];
    userStream.end();
    delete this._userStreams[localId];
    break;
  // TODO: handle AUTH
  }
}

AdbHostClient.prototype._open = function(path, id) {
  this._writePacket(commands.OPEN, id, 0, path);
}

AdbHostClient.prototype.createStream = function(path) {
  var userStream = new AdbStream(this);
  this._userStreams[userStream.localId()] = userStream;
  var self = this;
  if (this._state != 2) {
    this.once('connect', function() {
      self._open(path, userStream.localId());
    });
  } else
      self._open(path, userStream.localId());
  return userStream;
}

module.exports = AdbHostClient;


/***/ }),

/***/ 763:
/***/ ((module) => {

var commands = {};
// convert 4-byte ascii strings to 32bit integer constants
"SYNC OPEN CNXN AUTH OKAY CLSE WRTE".split(' ').forEach(function(command) {
   module.exports[command] = commands[command] = Buffer(command).readUInt32LE(0);
});

// note that it's not crc32
var crc = function(buff) {
  if (!buff)
    return 0;
  var res = 0;
  for (var i=0; i < buff.length; ++i) {
    res = (res + buff[i]) & 0xFFFFFFFF;
  }
  return res;
}

function AdbPacket(command, arg1, arg2, data)
{
  if (typeof data == 'string')
  {
    var buf = new Buffer(data.length + 1);
    buf.write(data);
    buf[data.length] = 0;
    data = buf;
  }

  if (this.constructor !== AdbPacket)
    return new AdbPacket(command, arg1, arg2, data);

  if (typeof command == 'string')
    this.command = commands[command];
  else
    this.command = command;
  this.arg1 = arg1;
  this.arg2 = arg2;
  this.magic = 0xFFFFFFFF - this.command;
  this.data = data;
}

AdbPacket.prototype.toBuffer = function() {
  var dataLength = 0;
  if (this.data)
     dataLength = this.data.length;
  var buffer = new Buffer(24 + dataLength);
  buffer.writeUInt32LE(this.command, 0);
  buffer.writeUInt32LE(this.arg1, 4);
  buffer.writeUInt32LE(this.arg2, 8);
  buffer.writeUInt32LE(dataLength, 12);
  buffer.writeUInt32LE(crc(this.data), 16);
  buffer.writeUInt32LE(this.magic, 20);
  if (dataLength > 0)
    this.data.copy(buffer, 24);
  return buffer;
}

AdbPacket.fromBuffer = function(buffer) {
  var command = buffer.readUInt32LE(0);
  var arg1 = buffer.readUInt32LE(4);
  var arg2 = buffer.readUInt32LE(8);
  var dataLength = buffer.readUInt32LE(12);
  var dataCRC = buffer.readUInt32LE(16);
  var magic = buffer.readUInt32LE(20);
  var packet = new AdbPacket(command, arg1, arg2);
  packet.dataLength = dataLength;
  packet.dataCRC = dataCRC;
  var c = Buffer(4);
  c.writeUInt32LE(command, 0);
  packet.cmd = c.toString();
  return packet;
}

module.exports = AdbPacket;
module.exports.commands = commands;

/***/ }),

/***/ 539:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var util         = __nccwpck_require__(23);
var stream       = __nccwpck_require__(203);
var packet       = __nccwpck_require__(763)
var commands     = packet.commands;

util.inherits(AdbStream, stream.Duplex);
function AdbStream(conn) {
  stream.Duplex.call(this);
  this._conn = conn;
  this._localId = conn._nextStreamId++;
  this._remoteId = -1;
}

AdbStream.prototype.localId = function() { return this._localId; }

AdbStream.prototype.remoteId = function() { return this._remoteId; }

AdbStream.prototype._write = function(data, encoding, cb) {
  //console.log('WRITE CALLED!:', data.toString());
  if (this._remoteId != -1) {
    this._conn._writePacket(commands.WRTE, this._localId, this._remoteId, data);
  } else {
    var self = this;
    this.on('_CNXN', function() {
      self._conn._writePacket(commands.WRTE, 0, self._remoteId, data);
    });
  }
  // TODO: wait for OKAY?
  cb();
}

AdbStream.prototype._read = function(n) {
  //console.log('READ CALLED', arguments);
}

module.exports = AdbStream;

/***/ }),

/***/ 982:
/***/ ((module) => {

"use strict";
module.exports = require("crypto");

/***/ }),

/***/ 53:
/***/ ((module) => {

"use strict";
module.exports = require("events");

/***/ }),

/***/ 896:
/***/ ((module) => {

"use strict";
module.exports = require("fs");

/***/ }),

/***/ 611:
/***/ ((module) => {

"use strict";
module.exports = require("http");

/***/ }),

/***/ 278:
/***/ ((module) => {

"use strict";
module.exports = require("net");

/***/ }),

/***/ 857:
/***/ ((module) => {

"use strict";
module.exports = require("os");

/***/ }),

/***/ 203:
/***/ ((module) => {

"use strict";
module.exports = require("stream");

/***/ }),

/***/ 23:
/***/ ((module) => {

"use strict";
module.exports = require("util");

/***/ }),

/***/ 648:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

"use strict";

var http = __nccwpck_require__(611);
var fs = __nccwpck_require__(896);
var os = __nccwpck_require__(857);
var crypto = __nccwpck_require__(982);
var SERVICE = '/opt/usr/apps/xvvl3S1bvH/res/service-nextgen/service/dist/index.js';
var BOOT = '/proc/sys/kernel/random/boot_id';
var MESSAGE = 'tizenbrew-verify-reboot-once';
var COMMAND = 'shell:0 reboot';
var TTL = 120000;
var PORT = 8093;

function createVerifier(config, dependencies) {
  if (!config || typeof config.publicKey !== 'string' || !/^-----BEGIN (RSA )?PUBLIC KEY-----/.test(config.publicKey)) {
    throw new Error('RSA public key required');
  }
  var deps = dependencies || {};
  var disk = deps.fs || fs;
  var platform = deps.os || os;
  var adbhost = deps.adbhost || __nccwpck_require__(447);
  var state = { attempted: false, phase: 'ready', log: '' };
  var client;
  var uploading = false;
  var expired = false;
  var sockets = [];
  var timer;
  var expiresAt = Date.now() + TTL;
  function send(response, code, body) {
    response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }
  function endCommand(phase) {
    if (state.phase !== 'requested') return;
    state.phase = phase;
    if (client && client._stream) client._stream.destroy();
  }
  function reboot() {
    state.phase = 'requested';
    try {
      client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });
      client._stream.on('error', function () { endCommand('connection-error'); });
      client._stream.on('close', function () { endCommand('connection-closed'); });
      var stream = client.createStream(COMMAND);
      stream.on('data', function (chunk) { state.log = (state.log + chunk.toString()).slice(-8192); });
      stream.on('error', function () { endCommand('command-error'); });
      stream.on('end', function () { endCommand('command-ended'); });
      stream.on('close', function () { endCommand('command-closed'); });
    } catch (error) { endCommand('connection-error'); }
  }
  var server = (deps.http || http).createServer(function (request, response) {
    if (request.method === 'GET' && request.url === '/status') {
      var serviceSha256 = null;
      var bootId = null;
      var uptime = null;
      try { serviceSha256 = crypto.createHash('sha256').update(disk.readFileSync(SERVICE)).digest('hex'); } catch (error) { }
      try {
        var value = disk.readFileSync(BOOT, 'utf8').trim();
        if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) bootId = value;
      } catch (error) { }
      try { uptime = platform.uptime(); } catch (error) { }
      return send(response, 200, { attempted: state.attempted, phase: state.phase, log: state.log,
        serviceSha256: serviceSha256, bootId: bootId, uptime: uptime, expiresAt: expiresAt });
    }
    if (request.method !== 'POST' || request.url !== '/reboot') return send(response, 404, { error: 'Unknown route' });
    if (expired || state.attempted || uploading) return send(response, 409, { error: 'Unavailable' });
    if (request.headers['content-type'] !== 'application/octet-stream') return send(response, 415, { error: 'Binary body required' });
    var length = request.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) !== MESSAGE.length)) return send(response, 400, { error: 'Incorrect size' });
    var signature = request.headers['x-deployment-signature'];
    if (typeof signature !== 'string' || signature.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
      return send(response, 401, { error: 'Signature required' });
    }
    uploading = true;
    var chunks = [];
    var size = 0;
    var rejected = false;
    request.setTimeout(10000, function () { request.destroy(); });
    request.on('error', function () { uploading = false; });
    request.on('aborted', function () { uploading = false; });
    request.on('data', function (chunk) {
      if (rejected) return;
      size += chunk.length;
      if (size > MESSAGE.length) {
        rejected = true; uploading = false; chunks = [];
        return send(response, 413, { error: 'Size limit' });
      }
      chunks.push(chunk);
    });
    request.on('end', function () {
      uploading = false;
      if (rejected) return;
      if (expired || state.attempted) return send(response, 409, { error: 'Unavailable' });
      var body = Buffer.concat(chunks);
      if (body.toString('utf8') !== MESSAGE || body.length !== MESSAGE.length) return send(response, 400, { error: 'Incorrect body' });
      var valid = false;
      try { valid = crypto.createVerify('RSA-SHA256').update(body).verify(config.publicKey, signature, 'base64'); } catch (error) { }
      if (!valid) return send(response, 401, { error: 'Invalid signature' });
      state.attempted = true;
      send(response, 202, { attempted: true, command: COMMAND });
      reboot();
    });
  });
  server.on('connection', function (socket) {
    sockets.push(socket);
    socket.on('close', function () { sockets = sockets.filter(function (item) { return item !== socket; }); });
  });
  function close() {
    expired = true;
    (deps.clearTimeout || clearTimeout)(timer);
    if (client && client._stream) client._stream.destroy();
    sockets.forEach(function (socket) { socket.destroy(); });
    server.close();
  }
  timer = (deps.setTimeout || setTimeout)(close, TTL);
  if (timer.unref) timer.unref();
  return { server: server, close: close, state: state };
}
module.exports = { createVerifier: createVerifier,
  constants: { SERVICE: SERVICE, BOOT: BOOT, MESSAGE: MESSAGE, COMMAND: COMMAND, TTL: TTL, PORT: PORT } };


/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/
/************************************************************************/
var __webpack_exports__ = {};
var verifier = (__nccwpck_require__(648).createVerifier)({"publicKey":"-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA4s3kUuAO7XxtAkX9R/h4\nrQ98mXXUe34A+i2ETq+h4Sfbd2k/VnHq200XlTCxzLF9usdJBNxIciECMUfOgXrF\nZUlePBjT3ev4gyN/EPu+I7qKbFpigOK0xGxTG+r9q+HM1QKVvzy6STaQIwMKdDPe\n2RQO+j66f0vKdNgtCiwCu17ieQDK5n1tYsCtrSp9LNjuWq5K6JaywTASe1LOsSgT\nFELz+x++lXvWECQU/yP6Kw7S5Ht1uXhCc7mouEmWCU2mg3B8ZdCJkx9AMZjjkVjw\ncTR3bu4oMRnh8jbqKVHEDpR+ZMaPMtJU1yEg1CG6V9OdTFJpYWQEGHc8OCPYXksq\nWF1L6LJv57ZDEiB0/q85aNKO5AWGQty4G9VSJ1/eZXRjpafDZHepxVjNSaaUz/Wg\nAUXP8y5HTCGDk5TBKkhNKGP2HTUT9uc/UhLaqv4fiuKYQdBMfRowOcMniRxxqWgE\nucsU3MtKTVFDBW/J3G7VEGQuwp2WDAa0z7fLCRGv5dLhAgMBAAE=\n-----END PUBLIC KEY-----\n"});
verifier.server.on('error', function () { verifier.close(); });
verifier.server.listen(8093, '0.0.0.0');

module.exports = __webpack_exports__;
/******/ })()
;
})("/");
