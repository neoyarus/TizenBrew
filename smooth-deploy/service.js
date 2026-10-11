(function (__dirname) {
/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 661:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var AdbHostClient = __nccwpck_require__(702);

function createConnection(opts) {
  return new AdbHostClient(opts);
}

module.exports.createConnection = createConnection;

/***/ }),

/***/ 702:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var util         = __nccwpck_require__(23);
var EventEmitter = (__nccwpck_require__(434).EventEmitter);
var net          = __nccwpck_require__(278);
var stream       = __nccwpck_require__(203);
var AdbStream    = __nccwpck_require__(961);
var AdbPacket    = __nccwpck_require__(873);
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

/***/ 873:
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

/***/ 961:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

var util         = __nccwpck_require__(23);
var stream       = __nccwpck_require__(203);
var packet       = __nccwpck_require__(873)
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

/***/ 434:
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

/***/ 136:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {

"use strict";


var http = __nccwpck_require__(611);
var crypto = __nccwpck_require__(982);
var fs = __nccwpck_require__(896);
var LIMIT = 4 * 1024 * 1024;
var TTL = 10 * 60 * 1000;
var DIRECTORY = '/home/owner/share/tmp/sdk_tools';
var STAGE_PREFIX = DIRECTORY + '/TizenBrew-';
var CONFIG = '/home/owner/share/tizenbrewConfig.json';
var BACKUP = DIRECTORY + '/TizenBrew-autolaunch-config-backup.json';

function validateConfig(config) {
  if (!config || !/^[a-f0-9]{64}$/.test(config.sha256) ||
      !Number.isInteger(config.bytes) || config.bytes < 1 || config.bytes > LIMIT ||
      typeof config.publicKey !== 'string' || !/^-----BEGIN (RSA )?PUBLIC KEY-----/.test(config.publicKey) ||
      !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('Invalid fixed deployment configuration');
  }
}

function createHelper(config, dependencies) {
  validateConfig(config);
  var deps = dependencies || {};
  var disk = deps.fs || fs;
  var adbhost = deps.adbhost || __nccwpck_require__(661);
  var stagePath = STAGE_PREFIX + config.sha256 + '.wgt';
  var command = 'shell:0 vd_appinstall xvvl3S1bvH ' + stagePath;
  var state = { phase: 'ready', accepted: false, backup: false, result: null, log: '' };
  var client = null;
  var uploading = false;
  var expired = false;
  var sockets = [];
  var expiresAt = Date.now() + TTL;
  var timer;

  function send(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }

  function finish(result) {
    if (state.result !== null) return;
    state.result = result;
    state.phase = result;
    if (client && client._stream) client._stream.destroy();
  }

  function ensureDirectory(path) {
    if (disk.existsSync(path)) return;
    var slash = path.lastIndexOf('/');
    ensureDirectory(path.slice(0, slash) || '/');
    disk.mkdirSync(path);
  }

  function stage(body) {
    ensureDirectory(DIRECTORY);
    if (disk.existsSync(CONFIG)) {
      // Preserve the first backup across a later recovery attempt.
      if (!disk.existsSync(BACKUP)) disk.writeFileSync(BACKUP, disk.readFileSync(CONFIG), { flag: 'wx', mode: 384 });
      state.backup = true;
    }
    if (disk.existsSync(stagePath)) {
      var existing = disk.readFileSync(stagePath);
      if (existing.length !== config.bytes || crypto.createHash('sha256').update(existing).digest('hex') !== config.sha256) {
        throw new Error('Existing staging file mismatch');
      }
    } else disk.writeFileSync(stagePath, body, { flag: 'wx', mode: 384 });
  }

  function install() {
    state.phase = 'installing';
    try {
      client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });
      client._stream.on('error', function () { finish('inconclusive'); });
      client._stream.on('close', function () { finish('inconclusive'); });
      var stream = client.createStream(command);
      stream.on('data', function (chunk) {
        state.log = (state.log + chunk.toString()).slice(-65536);
        if (/install failed|installation failed/i.test(state.log)) finish('failed');
        else if (/install completed|successfully installed/i.test(state.log)) finish('completed');
      });
      stream.on('error', function () { finish('inconclusive'); });
      stream.on('end', function () { finish('inconclusive'); });
      stream.on('close', function () { finish('inconclusive'); });
    } catch (error) { finish('inconclusive'); }
  }

  var server = http.createServer(function (request, response) {
    if (request.method === 'GET' && request.url === '/status') {
      return send(response, 200, { phase: state.phase, accepted: state.accepted,
        backup: state.backup, result: state.result, log: state.log, expiresAt: expiresAt });
    }
    if (request.method !== 'POST' || request.url !== '/install') return send(response, 404, { error: 'Unknown route' });
    if (expired || state.accepted || uploading) return send(response, 409, { error: 'Unavailable' });
    if (request.headers['content-type'] !== 'application/octet-stream') return send(response, 415, { error: 'Binary widget required' });
    var length = request.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > LIMIT)) return send(response, 413, { error: 'Size limit' });
    if (length && Number(length) !== config.bytes) return send(response, 400, { error: 'Incorrect size' });
    var signature = request.headers['x-deployment-signature'];
    if (typeof signature !== 'string' || signature.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
      return send(response, 401, { error: 'Signature required' });
    }
    uploading = true;
    var chunks = [];
    var size = 0;
    var ended = false;
    request.setTimeout(30000, function () { request.destroy(); });
    request.on('aborted', function () { uploading = false; });
    request.on('error', function () { uploading = false; });
    request.on('data', function (chunk) {
      if (ended) return;
      size += chunk.length;
      if (size > LIMIT || size > config.bytes) {
        ended = true;
        uploading = false;
        chunks = [];
        send(response, 413, { error: 'Size limit' });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', function () {
      uploading = false;
      if (ended) return;
      if (expired || state.accepted) return send(response, 409, { error: 'Unavailable' });
      if (size !== config.bytes) return send(response, 400, { error: 'Incorrect size' });
      var body = Buffer.concat(chunks);
      if (crypto.createHash('sha256').update(body).digest('hex') !== config.sha256) {
        return send(response, 400, { error: 'Incorrect checksum' });
      }
      var verified = false;
      try {
        verified = crypto.createVerify('RSA-SHA256').update(body).verify(config.publicKey, signature, 'base64');
      } catch (error) { }
      if (!verified) return send(response, 401, { error: 'Invalid signature' });
      state.accepted = true;
      state.phase = 'staging';
      try { stage(body); }
      catch (error) { finish('failed'); return send(response, 500, { error: 'Staging or backup failed' }); }
      send(response, 202, { accepted: true, backup: state.backup });
      install();
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
  return { server: server, state: state, close: close, stagePath: stagePath, command: command };
}

module.exports = { createHelper: createHelper, validateConfig: validateConfig,
  constants: { LIMIT: LIMIT, TTL: TTL, STAGE_PREFIX: STAGE_PREFIX, CONFIG: CONFIG, BACKUP: BACKUP } };


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
// This entry need to be wrapped in an IIFE because it need to be in strict mode.
(() => {
"use strict";

var helper = (__nccwpck_require__(136).createHelper)({"sha256":"4f55a76be3b5e40aa123f033e9d2d36832e771b9a7474300891bb021ce2e8121","bytes":781000,"publicKey":"-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA4s3kUuAO7XxtAkX9R/h4\nrQ98mXXUe34A+i2ETq+h4Sfbd2k/VnHq200XlTCxzLF9usdJBNxIciECMUfOgXrF\nZUlePBjT3ev4gyN/EPu+I7qKbFpigOK0xGxTG+r9q+HM1QKVvzy6STaQIwMKdDPe\n2RQO+j66f0vKdNgtCiwCu17ieQDK5n1tYsCtrSp9LNjuWq5K6JaywTASe1LOsSgT\nFELz+x++lXvWECQU/yP6Kw7S5Ht1uXhCc7mouEmWCU2mg3B8ZdCJkx9AMZjjkVjw\ncTR3bu4oMRnh8jbqKVHEDpR+ZMaPMtJU1yEg1CG6V9OdTFJpYWQEGHc8OCPYXksq\nWF1L6LJv57ZDEiB0/q85aNKO5AWGQty4G9VSJ1/eZXRjpafDZHepxVjNSaaUz/Wg\nAUXP8y5HTCGDk5TBKkhNKGP2HTUT9uc/UhLaqv4fiuKYQdBMfRowOcMniRxxqWgE\nucsU3MtKTVFDBW/J3G7VEGQuwp2WDAa0z7fLCRGv5dLhAgMBAAE=\n-----END PUBLIC KEY-----\n","port":8092});
helper.server.on('error', function () { helper.close(); });
helper.server.listen(8092, '0.0.0.0');

})();

module.exports = __webpack_exports__;
/******/ })()
;
})("/");
