'use strict';

var fs = require('fs');
var path = require('path');
var copyRemoteConfig = require('./config.cjs').copyRemoteConfig;
var companion = null;

function startService() {
    if (companion && !companion.isClosed()) return;
    companion = null;
    try {
        var raw = fs.readFileSync(path.join(__dirname, 'recovery-config.json'), 'utf8');
        if (raw.length > 100000) throw new Error('Invalid configuration');
        var config = JSON.parse(raw);
        var options = copyRemoteConfig(config, {
            publicKey: config.publicKey,
            tlsKey: config.tlsKey,
            tlsCert: config.tlsCert,
            port: config.port
        });
        companion = require('./core.cjs').start(options);
    } catch (error) {
        // Configuration includes a server private key; never print it or the raw error.
        console.log('Recovery service could not start; verify its private configuration and runtime support.');
    }
}

function stopService() {
    if (!companion) return;
    var previous = companion;
    companion = null;
    previous.close();
}

module.exports.onStart = startService;
module.exports.onRequest = startService;
module.exports.onStop = stopService;
module.exports.onExit = stopService;
