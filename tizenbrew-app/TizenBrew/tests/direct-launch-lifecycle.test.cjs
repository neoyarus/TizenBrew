'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { serviceHarness, settle } = require('./helpers.cjs');
const { startRemoteLauncher } = require('../service-nextgen/service/utils/remoteLauncher.js');

function remoteFixture() {
    const token = 'a'.repeat(64);
    const timers = new Map();
    const launches = [];
    let handle;
    let timerId = 0;
    const server = new EventEmitter();
    server.listen = (port, host) => { assert.equal(port, 8097); assert.equal(host, '0.0.0.0'); };
    server.close = () => {};
    server.setTimeout = (delay, callback) => { assert.equal(delay, 20000); server.timeoutCallback = callback; };
    const launcher = startRemoteLauncher({ enabled: true, token }, {
        isReady: () => true,
        isAttached: () => false,
        launch() {
            return new Promise((resolve, reject) => { launches.push({ resolve, reject }); });
        }
    }, {
        http: { createServer(handler) { handle = handler; return server; } },
        setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }
    });
    return {
        launches, launcher, server, timers,
        request({ method = 'POST', url = '/launch', authorization = 'Bearer ' + token } = {}) {
            const request = new EventEmitter();
            request.method = method;
            request.url = url;
            request.headers = { authorization, 'content-length': '0' };
            request.setTimeout = () => {};
            const response = {
                writeHead(status) { this.status = status; },
                end(body) { this.body = JSON.parse(body); this.writableEnded = true; }
            };
            handle(request, response);
            request.emit('end');
            return response;
        },
        fireTimeout() {
            const entry = [...timers].find(([, timer]) => timer.delay === 15000);
            assert.ok(entry, 'a launch confirmation deadline must exist');
            timers.delete(entry[0]);
            entry[1].callback();
        }
    };
}

test('unauthorized remote requests cannot start or probe a launch', async () => {
    const h = remoteFixture();
    const result = h.request({ authorization: 'Bearer ' + 'b'.repeat(64) });
    await settle();
    assert.equal(result.status, 401);
    assert.equal(h.launches.length, 0);
});

test('concurrent authenticated remote requests share one launch attempt', async () => {
    const h = remoteFixture();
    const first = h.request();
    const concurrent = h.request();
    await settle();
    assert.equal(h.launches.length, 1);
    assert.equal(concurrent.status, 202);
    h.launches[0].resolve({ mode: 'debug-started' });
    await settle();
    assert.equal(first.status, 200);
    assert.equal(first.body.mode, 'debug-started');
    h.request();
    await settle();
    assert.equal(h.launches.length, 2, 'a completed attempt releases the slot');
});

test('an HTTP confirmation timeout cannot start a second launch while the original action remains pending', async () => {
    const h = remoteFixture();
    const first = h.request();
    await settle();
    h.fireTimeout();
    await settle();
    assert.equal(first.status, 503);
    const retried = h.request();
    await settle();
    assert.equal(h.launches.length, 1, 'the outstanding action must remain protected by the single-flight guard');
    assert.equal(retried.status, 202);
    h.launches[0].resolve({ mode: 'debug-started' });
    await settle();
    assert.equal(first.status, 503, 'late completion does not rewrite the timeout response');
    h.request();
    await settle();
    assert.equal(h.launches.length, 2, 'settling the underlying action finally releases its slot');
});

test('remote status reports settled failures and deadlines without exposing the token', async () => {
    const h = remoteFixture();
    h.request();
    await settle();
    h.launches[0].reject(Object.assign(new Error('A private detail'), { code: 'ACTIVE_PAGE' }));
    await settle();
    const result = h.request({ method: 'GET', url: '/status' });
    assert.equal(result.status, 200);
    assert.equal(result.body.requestsStarted, 1);
    assert.equal(result.body.requestsCompleted, 1);
    assert.equal(result.body.requestsFailed, 1);
    assert.equal(result.body.requestsTimedOut, 0);
    assert.equal(JSON.stringify(result.body).includes('a'.repeat(64)), false);
    assert.equal(JSON.stringify(result.body).includes('A private detail'), false);
});

test('completed request bodies leave no short deadline during debugger attachment', async () => {
    const h = remoteFixture();
    h.request();
    await settle();
    assert.equal([...h.timers.values()].some(timer => timer.delay === 5000), false,
        'a five-second upload limit must not interrupt a fifteen-second launch confirmation');
    assert.equal([...h.timers.values()].some(timer => timer.delay === 15000), true);
});

test('closing the remote listener destroys every active socket and clears header deadlines', () => {
    const h = remoteFixture();
    const sockets = Array.from({ length: 3 }, () => {
        const socket = new EventEmitter();
        socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
        h.server.emit('connection', socket);
        return socket;
    });
    h.launcher.close();
    assert.ok(sockets.every(socket => socket.destroyed));
    assert.equal(h.timers.size, 0);
});

test('a superseded debugger disconnect cannot erase the active replacement session', async () => {
    const h = serviceHarness();
    h.start();
    await settle();
    const ws = h.connect();
    ws.message(h.Events.Ready);
    h.debug(ws);
    const oldDebugger = h.cdpClients.at(-1);
    h.debug(ws);
    const activeDebugger = h.cdpClients.at(-1);
    assert.notEqual(activeDebugger, oldDebugger);

    oldDebugger.emit('disconnect');
    ws.message(h.Events.GetDebugStatus);
    assert.equal(ws.sent.at(-1).payload.webDebug, true, 'the live replacement remains attached');
    assert.equal(ws.sent.at(-1).payload.tizenDebug, true);

    activeDebugger.emit('disconnect');
    ws.message(h.Events.GetDebugStatus);
    assert.equal(ws.sent.at(-1).payload.webDebug, false, 'the active disconnect still clears readiness');
    assert.equal(ws.sent.at(-1).payload.tizenDebug, false);
});

test('an obsolete document-start completion cannot acknowledge the replacement debugger installation', async () => {
    const h = serviceHarness({ deferScripts: true });
    h.start();
    await settle();
    const ws = h.connect();
    ws.message(h.Events.Ready);
    h.debug(ws);
    const module = { ...h.example, evaluateScriptOnDocumentStart: true };
    ws.message(h.Events.LaunchModule, module);
    h.cdpClients.at(-1).emit('Runtime.executionContextCreated', { context: { id: 1 } });
    await settle();
    assert.equal(h.scriptRequests.length, 1);

    h.debug(ws);
    h.cdpClients.at(-1).emit('Runtime.executionContextCreated', { context: { id: 2 } });
    await settle();
    assert.equal(h.scriptRequests.length, 2);
    h.scriptRequests[0].resolve();
    await settle();
    h.timer.advance(100);
    assert.equal(ws.sent.filter(event => event.type === h.Events.LaunchModule).length, 0,
        'old installation completion must not release the new UI navigation');

    h.scriptRequests[1].resolve();
    await settle();
    h.timer.advance(100);
    const redirects = ws.sent.filter(event => event.type === h.Events.LaunchModule);
    assert.equal(redirects.length, 1);
    assert.equal(redirects[0].payload, module.fullName);
});

test('a queued document-start acknowledgment is canceled when its debugger is replaced before UI Ready', async () => {
    const h = serviceHarness({ deferScripts: true });
    h.start();
    await settle();
    const ws = h.connect();
    h.debug(ws);
    const module = { ...h.example, evaluateScriptOnDocumentStart: true };
    ws.message(h.Events.LaunchModule, module);
    h.cdpClients.at(-1).emit('Runtime.executionContextCreated', { context: { id: 1 } });
    await settle();
    h.scriptRequests[0].resolve();
    await settle();

    h.debug(ws);
    ws.message(h.Events.Ready);
    h.timer.advance(100);
    assert.equal(ws.sent.filter(event => event.type === h.Events.LaunchModule).length, 0,
        'retrying an old acknowledgment must not target the Ready replacement UI');
});

function finishDebugLaunch(h) {
    const adb = h.adbClients.at(-1);
    assert.ok(adb, 'a direct debug connection must exist');
    adb._stream.emit('connect');
    adb.shell.emit('data', Buffer.from('debug: 9222\n'));
}

async function attachedRemoteHarness(options = {}) {
    const h = serviceHarness({ remoteLauncher: true, ...options });
    h.start();
    await settle();
    const ws = h.connect();
    h.debug(ws);
    await settle();
    ws.close();
    return h;
}

test('remote cold launch attaches directly before any frontend websocket exists', async () => {
    const h = serviceHarness({ remoteLauncher: true });
    h.start();
    await settle();
    const first = h.requestRemote({ method: 'POST', path: '/launch' });
    const duplicate = h.requestRemote({ method: 'POST', path: '/launch' });
    await settle();
    assert.equal(duplicate.status, 202);
    assert.equal(h.adbClients.length, 1);
    finishDebugLaunch(h);
    await first.done;
    assert.equal(first.status, 200);
    assert.equal(first.body.mode, 'debug');
    assert.equal(h.cdpClients.length, 1);
    assert.deepEqual(h.adbClients[0].commands, ['shell:0 debug test.TizenBrewStandalone']);
    assert.equal(h.resumeRequests.length, 0);
});

test('an attached paused page resumes after frontend websocket closure without evaluation or new SDB', async () => {
    const h = await attachedRemoteHarness();
    const debuggerClient = h.cdpClients[0];
    debuggerClient.Runtime.evaluate = () => { throw new Error('A hidden page cannot evaluate JavaScript'); };
    const result = h.requestRemote({ method: 'POST', path: '/launch' });
    await result.done;
    assert.equal(result.status, 200);
    assert.equal(result.body.mode, 'resume');
    assert.equal(h.adbClients.length, 1);
    assert.equal(h.cdpClients[0], debuggerClient);
    assert.equal(h.resumeRequests.length, 1);
    assert.equal(h.resumeRequests[0].url, 'http://127.0.0.1:8001/api/v2/applications/test.TizenBrewStandalone');
    const status = h.requestRemote();
    assert.equal(status.body.debugLaunches, 1);
    assert.equal(status.body.resumeRequests, 1);
});

test('remote resume refuses a different live page without navigating or restarting it', async () => {
    const h = await attachedRemoteHarness({ historyUrl: '/manual-browser.html' });
    const result = h.requestRemote({ method: 'POST', path: '/launch' });
    await result.done;
    assert.equal(result.status, 409);
    assert.equal(h.adbClients.length, 1);
    assert.equal(h.resumeRequests.length, 0);
});

test('an ambiguous foreground request failure does not trigger a second debug launch', async () => {
    const h = await attachedRemoteHarness({ failResume: true });
    const result = h.requestRemote({ method: 'POST', path: '/launch' });
    await result.done;
    assert.equal(result.status, 503);
    assert.equal(h.resumeRequests.length, 1);
    assert.equal(h.adbClients.length, 1);
    assert.equal(h.cdpClients.length, 1);
});

test('an explicitly failed live-session probe starts one fresh debugger', async () => {
    const h = await attachedRemoteHarness();
    h.cdpClients[0].history = () => Promise.reject(new Error('Debugger transport closed'));
    const result = h.requestRemote({ method: 'POST', path: '/launch' });
    await settle();
    assert.equal(h.adbClients.length, 2);
    finishDebugLaunch(h);
    await result.done;
    assert.equal(result.body.mode, 'debug');
    assert.equal(h.resumeRequests.length, 0);
});

for (const outcome of ['resolve', 'reject']) {
    test(`a superseded history probe cannot resume or replace the current debugger on late ${outcome}`, async () => {
        const h = await attachedRemoteHarness();
        let complete;
        h.cdpClients[0].history = () => new Promise((resolve, reject) => {
            complete = outcome === 'resolve' ? () => resolve({ currentIndex: 0, entries: [{ url: h.example.appPath }] })
                : () => reject(new Error('Old session closed'));
        });
        const result = h.requestRemote({ method: 'POST', path: '/launch' });
        await settle();
        const ws = h.connect();
        h.debug(ws);
        await settle();
        const activeDebugger = h.cdpClients.at(-1);
        complete();
        await result.done;
        assert.equal(result.status, 503);
        assert.equal(h.adbClients.length, 2, 'the old probe cannot start a third debugger');
        assert.equal(h.resumeRequests.length, 0, 'the old probe cannot foreground its former session');
        ws.message(h.Events.GetDebugStatus);
        assert.equal(ws.sent.at(-1).payload.webDebug, true);
        assert.equal(h.cdpClients.at(-1), activeDebugger);
    });
}
