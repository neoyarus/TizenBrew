'use strict';

// Fixed native TV remote transport. Keep runtime code compatible with Node 4.
var KEYS = ['KEY_HOME', 'KEY_RETURN', 'KEY_EXIT', 'KEY_MENU', 'KEY_UP', 'KEY_DOWN',
  'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER', 'KEY_POWER', 'KEY_MUTE', 'KEY_VOLUP', 'KEY_VOLDOWN',
  'KEY_PLAY', 'KEY_PAUSE', 'KEY_STOP'];
for (var digit = 0; digit < 10; digit++) KEYS.push('KEY_' + digit);

function parseCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(function (key) { return key !== 'key' && key !== 'holdMs'; }) ||
      KEYS.indexOf(value.key) === -1 || value.holdMs !== undefined &&
      (typeof value.holdMs !== 'number' || value.holdMs % 1 || value.holdMs < 500 || value.holdMs > 10000)) throw new Error('Invalid remote command');
  return { key: value.key, holdMs: value.holdMs };
}

var TRANSPORT_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'EADDRNOTAVAIL', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_DH_KEY_TOO_SMALL',
  'ERR_SSL_EE_KEY_TOO_SMALL', 'ERR_SSL_UNSUPPORTED_PROTOCOL', 'ERR_TLS_INVALID_PROTOCOL_VERSION',
  'ERR_SSL_LEGACY_SIGALG_DISALLOWED_OR_UNSUPPORTED', 'HTTP_400', 'HTTP_401', 'HTTP_403',
  'HTTP_404', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'TLS_PIN_MISMATCH'];
function transportCode(error) { return error && TRANSPORT_CODES.indexOf(error.code) !== -1 ? error.code : 'UNKNOWN'; }
function diagnosticDetail(cause, token) {
  var name = cause && typeof cause.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(cause.name) ? cause.name : 'Error';
  var message = cause && typeof cause.message === 'string' ? cause.message : 'Transport failure';
  var detail = name + ': ' + message;
  if (typeof token === 'string' && token.length) {
    detail = detail.split(token).join('[redacted]');
    detail = detail.split(encodeURIComponent(token)).join('[redacted]');
  }
  return detail.replace(/(?:https?|wss?):\/\/[^\s"'<>)]*/gi, '[url]')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 256);
}
function failure(code, message, cause, token) {
  var error = new Error(message); error.code = code;
  if (cause) { error.transportCode = transportCode(cause); error.diagnosticDetail = diagnosticDetail(cause, token); }
  return error;
}
function ipv4(value) {
  return typeof value === 'string' && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(value) &&
    value.split('.').every(function (part) { return String(Number(part)) === part && Number(part) <= 255; });
}
function localAddresses(source) {
  var addresses = [];
  try {
    var interfaces = (source || require('os')).networkInterfaces();
    Object.keys(interfaces).slice(0, 64).forEach(function (name) {
      if (!Array.isArray(interfaces[name])) return;
      interfaces[name].slice(0, 64).forEach(function (entry) {
        if (addresses.length < 16 && entry && entry.internal === false && (entry.family === 'IPv4' || entry.family === 4) &&
            ipv4(entry.address) && addresses.indexOf(entry.address) === -1) addresses.push(entry.address);
      });
    });
  } catch (ignoredInterfaces) {}
  return addresses;
}

function create(options, dependencies) {
  var deps = dependencies || {};
  var token = options.tvRemoteToken;
  var name = options.tvRemoteName === undefined ? 'HomeAssistant' : options.tvRemoteName;
  var host = options.tvRemoteHost === undefined ? '127.0.0.1' : options.tvRemoteHost;
  function authorizedHost() {
    // Only an internal PC adapter supplies this function; the HTTP service never does.
    if (typeof deps.authorizeHost === 'function') return deps.authorizeHost(host) === true;
    return host === '127.0.0.1' || ipv4(host) && localAddresses(deps.os).indexOf(host) !== -1;
  }
  var hostIsLocal = authorizedHost();
  var enabled = typeof token === 'string' && token.trim().length > 0 && token.length <= 1024 &&
    typeof name === 'string' && name.trim().length > 0 && Buffer.byteLength(name, 'utf8') <= 64 && hostIsLocal;
  var later = deps.setTimeout || setTimeout;
  var cancel = deps.clearTimeout || clearTimeout;
  var active = null;
  var closed = false;

  function execute(value, callback) {
    var command;
    try { command = parseCommand(value); } catch (error) { return callback(error); }
    if (!enabled || closed) return callback(failure('REMOTE_UNAVAILABLE', 'TV remote is not configured or available'));
    if (!authorizedHost()) return callback(failure('REMOTE_UNAVAILABLE', 'TV remote target is not authorized'));
    if (active) return callback(failure('REMOTE_BUSY', 'TV remote is busy'));
    var WebSocket;
    var socket;
    var holdTimer;
    var softTimer;
    var hardTimer;
    var drainTimer;
    var drain;
    var ready = false;
    var pressed = false;
    var finishing = false;
    var finished = false;
    var finalError;
    active = { stop: function () { finish(failure('REMOTE_UNAVAILABLE', 'TV remote stopped')); } };

    function packet(action) {
      return JSON.stringify({ method: 'ms.remote.control', params: {
        Cmd: action, DataOfCmd: command.key, Option: 'false', TypeOfRemote: 'SendRemoteKey'
      } });
    }
    function complete(error, force) {
      if (finished) { if (force && drain) drain(); return; }
      finished = true;
      cancel(holdTimer); cancel(softTimer);
      var drained = false;
      drain = function () {
        if (drained) return;
        drained = true;
        cancel(drainTimer); cancel(hardTimer);
        active = null;
        if (socket) { try { socket.terminate(); } catch (ignoredTerminate) {} }
        callback(error || null, error ? undefined : { sent: true, key: command.key,
          mode: command.holdMs === undefined ? 'click' : 'hold', holdMs: command.holdMs || null });
      };
      if (!socket) return drain();
      socket.removeAllListeners();
      socket.on('error', function () {});
      if (force || socket.readyState !== 1) return drain();
      socket.once('close', drain);
      drainTimer = later(drain, 250);
      try { socket.close(); } catch (ignoredClose) { drain(); }
    }
    function finish(error) {
      if (finishing || finished) return;
      finishing = true;
      finalError = error;
      cancel(holdTimer);
      // Once Press may have been sent, attempt Release on every terminal path.
      // A broken transport cannot guarantee delivery; never reconnect or pair silently.
      if (pressed && socket && socket.readyState === 1) {
        try {
          socket.send(packet('Release'), function (releaseError) {
            complete(finalError || (releaseError && failure('REMOTE_SEND_FAILED', 'TV remote release was not confirmed', releaseError, token)));
          });
          return;
        } catch (sendCause) { return complete(finalError || failure('REMOTE_SEND_FAILED', 'TV remote release was not confirmed', sendCause, token)); }
      }
      complete(finalError);
    }
    // Reserve the final half-second for a best-effort Release; all resources end by 15s.
    softTimer = later(function () { finish(failure('REMOTE_TIMEOUT', 'TV remote timed out')); }, 14500);
    hardTimer = later(function () { complete(finalError || failure('REMOTE_TIMEOUT', 'TV remote timed out'), true); }, 15000);
    try {
      WebSocket = deps.WebSocket || require('ws');
      socket = new WebSocket('wss://' + (host.indexOf(':') !== -1 ? '[' + host + ']' : host) + ':8002/api/v2/channels/samsung.remote.control?name=' +
        encodeURIComponent(new Buffer(name, 'utf8').toString('base64')) + '&token=' + encodeURIComponent(token), {
        rejectUnauthorized: false, handshakeTimeout: 5000, perMessageDeflate: false, maxPayload: 8192,
        followRedirects: false, agent: deps.agent
      });
      // ws4 clients pass zero to setSocket regardless of maxPayload options.
      // Bind the pinned receiver limit before its asynchronous upgrade/setup.
      var originalSetSocket = socket.setSocket;
      if (typeof originalSetSocket === 'function') socket.setSocket = function (nativeSocket, head) {
        return originalSetSocket.call(socket, nativeSocket, head, 8192);
      };
      socket.on('error', function (cause) { finish(failure('REMOTE_SEND_FAILED', 'TV remote connection failed', cause, token)); });
      socket.on('unexpected-response', function (request, response) {
        finish(failure('REMOTE_SEND_FAILED', 'TV remote handshake refused', { code: 'HTTP_' + response.statusCode }, token));
      });
      socket.on('close', function () { finish(failure('REMOTE_SEND_FAILED', 'TV remote connection closed')); });
      socket.on('message', function (data) {
        if (finished || finishing) return;
        if ((Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, 'utf8')) > 8192) return finish(failure('REMOTE_SEND_FAILED', 'Invalid TV remote response'));
        var event;
        try { event = JSON.parse(data.toString()); } catch (ignoredParse) { return finish(failure('REMOTE_SEND_FAILED', 'Invalid TV remote response')); }
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.event !== 'string') return finish(failure('REMOTE_SEND_FAILED', 'Invalid TV remote response'));
        if (event.event === 'ms.channel.unauthorized') return finish(failure('REMOTE_SEND_FAILED', 'TV remote authorization refused'));
        if (event.event === 'ms.channel.error') return finish(failure('REMOTE_SEND_FAILED', 'TV remote refused the command'));
        if (event.event !== 'ms.channel.connect' || ready) return;
        ready = true;
        pressed = command.holdMs !== undefined;
        try {
          socket.send(packet(pressed ? 'Press' : 'Click'), function (sendError) {
            if (finished || finishing) return;
            if (sendError) return finish(failure('REMOTE_SEND_FAILED', 'TV remote send was not confirmed', sendError, token));
            if (!pressed) return finish();
            holdTimer = later(function () { finish(); }, command.holdMs);
          });
        } catch (commandCause) { finish(failure('REMOTE_SEND_FAILED', 'TV remote send was not confirmed', commandCause, token)); }
      });
    } catch (connectCause) { finish(failure('REMOTE_SEND_FAILED', 'TV remote connection failed', connectCause, token)); }
  }
  return { enabled: enabled, execute: execute, close: function () { closed = true; if (active) active.stop(); } };
}

module.exports = { create: create, parseCommand: parseCommand, transportCode: transportCode, localAddresses: localAddresses, keys: KEYS };
