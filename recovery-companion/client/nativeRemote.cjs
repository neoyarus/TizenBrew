'use strict';

const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const controller = require('../service/tvRemote.cjs');

function createNativeRemote(config, dependencies = {}) {
  if (!config || typeof config.host !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(config.host) ||
      typeof config.tvRemoteToken !== 'string' || !config.tvRemoteToken.trim() || config.tvRemoteToken.length > 1024 ||
      config.tvRemoteName !== undefined && (typeof config.tvRemoteName !== 'string' || !config.tvRemoteName.trim() || Buffer.byteLength(config.tvRemoteName) > 64) ||
      !/^[a-f0-9]{64}$/.test(config.tvRemoteCertificateSha256)) throw new Error('Invalid private native remote configuration');
  const expectedPin = Buffer.from(config.tvRemoteCertificateSha256, 'hex');
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = function (options, callback) {
    let completed = false;
    const socket = (dependencies.tls || tls).connect({ host: config.host, port: 8002, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('Native TV TLS connection timed out'), { code: 'ETIMEDOUT' })), 5000);
    function finish(error) {
      if (completed) return;
      completed = true; clearTimeout(timer);
      callback(error, error ? undefined : socket);
    }
    socket.once('error', finish);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      const actual = certificate.raw && crypto.createHash('sha256').update(certificate.raw).digest();
      if (!actual || !crypto.timingSafeEqual(actual, expectedPin)) {
        finish(Object.assign(new Error('Native TV TLS certificate pin mismatch'), { code: 'TLS_PIN_MISMATCH' }));
        socket.destroy(); return;
      }
      finish();
    });
    // Returning no socket keeps the native token/query off the wire until pin verification.
  };
  const remote = controller.create({ tvRemoteToken: config.tvRemoteToken, tvRemoteName: config.tvRemoteName, tvRemoteHost: config.host }, {
    authorizeHost: host => host === config.host, WebSocket: dependencies.WebSocket, agent
  });
  return { execute(command) { return new Promise((resolve, reject) => remote.execute(command, (error, result) => error ? reject(error) : resolve({ ...result, source: 'pc-native' }))); },
    close() { remote.close(); agent.destroy(); } };
}

module.exports = { createNativeRemote };
