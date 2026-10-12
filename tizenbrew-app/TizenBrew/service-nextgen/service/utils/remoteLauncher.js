"use strict";

const http = require('http');
const crypto = require('crypto');

function validConfig(config) {
    return !!config && config.enabled === true && typeof config.token === 'string' && /^[a-f0-9]{64}$/.test(config.token);
}

function equalToken(actual, expected) {
    const left = crypto.createHash('sha256').update(actual).digest();
    const right = crypto.createHash('sha256').update(expected).digest();
    if (crypto.timingSafeEqual) return crypto.timingSafeEqual(left, right);
    // timingSafeEqual is unavailable on the oldest supported TV Node runtime.
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
    return difference === 0;
}

function startRemoteLauncher(config, actions, dependencies) {
    if (!validConfig(config)) return null;
    const deps = dependencies || {};
    const later = deps.setTimeout || setTimeout;
    const cancel = deps.clearTimeout || clearTimeout;
    let operation = null;
    let operationId = 0;
    let requestsCompleted = 0;
    let requestsFailed = 0;
    let requestsTimedOut = 0;
    let lastMode = null;
    const sockets = [];

    function send(response, status, value) {
        if (response.destroyed || response.writableEnded || response.finished) return;
        // One request per connection also bounds header reads on older TV Node versions.
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
        response.end(JSON.stringify(value));
    }
    const server = (deps.http || http).createServer((request, response) => {
        if (request.socket) cancel(request.socket.launcherHeaderTimer);
        const authorization = request.headers.authorization;
        const match = typeof authorization === 'string' && /^Bearer ([a-f0-9]{64})$/.exec(authorization);
        if (!match || !equalToken(match[1], config.token)) return send(response, 401, { error: 'Unauthorized' });
        if (request.method === 'GET' && request.url === '/status') {
            const ready = actions.isReady();
            return send(response, ready ? 200 : 503, Object.assign({ enabled: true, ready, phase: operation ? 'launching' : 'idle',
                debuggerAttached: actions.isAttached(), operationId, requestsStarted: operationId, requestsCompleted,
                requestsFailed, requestsTimedOut, lastMode },
            actions.getStatus ? actions.getStatus() : {}));
        }
        if (request.method !== 'POST' || request.url !== '/launch') return send(response, 404, { error: 'Unknown route' });
        if ((request.headers['content-length'] && request.headers['content-length'] !== '0') || request.headers['transfer-encoding']) {
            return send(response, 400, { error: 'Empty body required' });
        }
        let rejected = false;
        // The body deadline must not remain a socket timeout during debugger attachment.
        const bodyTimer = later(() => { rejected = true; request.destroy(); }, 5000);
        function rejectRequest() { rejected = true; cancel(bodyTimer); }
        request.on('error', rejectRequest);
        request.on('aborted', rejectRequest);
        request.on('data', () => { rejected = true; send(response, 400, { error: 'Empty body required' }); });
        request.on('end', () => {
            cancel(bodyTimer);
            if (rejected) return;
            if (!actions.isReady()) return send(response, 503, { error: 'Launcher not ready' });
            if (operation) return send(response, 202, { accepted: true, launching: true });
            let responded = false;
            operationId++;
            const timeout = later(() => {
                responded = true;
                requestsTimedOut++;
                // Retain single-flight ownership until the bounded underlying action settles.
                send(response, 503, { error: 'Launch could not be confirmed' });
            }, 15000);
            operation = Promise.resolve().then(() => actions.launch());
            operation.then(result => {
                operation = null;
                cancel(timeout);
                requestsCompleted++;
                lastMode = result && result.mode || null;
                if (!responded) send(response, 200, { accepted: true, mode: lastMode });
            }, error => {
                operation = null;
                cancel(timeout);
                requestsCompleted++;
                requestsFailed++;
                const activePage = error && error.code === 'ACTIVE_PAGE';
                if (!responded) send(response, activePage ? 409 : 503, { error: activePage ? 'Active page differs from autolaunch target' : 'Launch could not be confirmed' });
            });
        });
    });
    server.on('connection', socket => {
        sockets.push(socket);
        socket.launcherHeaderTimer = later(() => socket.destroy(), 10000);
        socket.on('close', () => {
            cancel(socket.launcherHeaderTimer);
            const index = sockets.indexOf(socket);
            if (index !== -1) sockets.splice(index, 1);
        });
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 20000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 20;
    server.setTimeout(20000, socket => socket.destroy());
    server.on('error', () => { server.close(); });
    server.listen(8097, '0.0.0.0');
    return { server, close() { sockets.slice().forEach(socket => socket.destroy()); server.close(); } };
}

module.exports = { startRemoteLauncher, validConfig };
