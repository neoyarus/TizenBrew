'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceHarness, socket, settle } = require('./helpers.cjs');

function launches(h, ws) { return ws.sent.filter(event => event.type === h.Events.CanLaunchModules); }
function redirects(h, ws) { return ws.sent.filter(event => event.type === h.Events.LaunchModule); }

async function installDocumentStartModule(h, services) {
    h.attach(services, { module: null, args: null }, {
        ...h.example, evaluateScriptOnDocumentStart: true
    });
    h.cdpClients.at(-1).emit('Runtime.executionContextCreated', { context: { id: 1 } });
    await settle();
}

for (const [name, readyState, isReady] of [
    ['closed but Ready', 3, true], ['OPEN but not Ready', 1, false]
]) {
    test(`debugger module redirect waits for a live Ready UI: ${name}`, async () => {
        const h = serviceHarness();
        const ws = socket(readyState);
        const connection = new h.Connection(ws);
        connection.isReady = isReady;
        const services = new Map([['wsConn', connection]]);
        await installDocumentStartModule(h, services);
        h.timer.advance(1000);
        assert.equal(redirects(h, ws).length, 0, 'an unavailable UI must receive no launch instruction');
        ws.readyState = 1;
        connection.isReady = true;
        h.timer.advance(1000);
        assert.equal(redirects(h, ws).length, 1, 'the instruction must survive until UI readiness');
        assert.equal(redirects(h, ws)[0].payload, h.example.fullName, 'the redirect must use the UI lookup identifier');
    });
}

test('a pending debugger module redirect follows the replacement UI socket', async () => {
    const h = serviceHarness();
    const oldWs = socket();
    const oldConnection = new h.Connection(oldWs);
    const services = new Map([['wsConn', oldConnection]]);
    await installDocumentStartModule(h, services);
    h.timer.advance(10);
    const currentWs = socket();
    const currentConnection = new h.Connection(currentWs);
    currentConnection.isReady = true;
    services.set('wsConn', currentConnection);
    oldWs.close();
    h.timer.advance(1000);
    assert.equal(redirects(h, oldWs).length, 0, 'the obsolete socket must not receive the launch');
    assert.equal(redirects(h, currentWs).length, 1, 'the current Ready UI must receive the launch');
});

test('debugger can attach before any UI websocket exists', () => {
    const h = serviceHarness();
    const services = new Map();
    const state = h.attach(services);
    assert.equal(state.webDebug, true, 'missing UI must not prevent debugger readiness');
});

test('document-start redirect waits for script registration to finish', async () => {
    const h = serviceHarness({ deferScripts: true });
    const ws = socket();
    const connection = new h.Connection(ws);
    connection.isReady = true;
    const services = new Map([['wsConn', connection]]);
    await installDocumentStartModule(h, services);
    assert.equal(h.scriptRequests.length, 1);
    h.timer.advance(1000);
    assert.equal(redirects(h, ws).length, 0, 'navigation before debugger script installation loses the module');
    h.scriptRequests[0].resolve();
    await settle();
    h.timer.advance(1000);
    assert.deepEqual(redirects(h, ws), [{ type: h.Events.LaunchModule, payload: h.example.fullName }]);
});

test('appControl delivery clears the shared metadata rather than only a local variable', () => {
    const h = serviceHarness();
    const ws = socket();
    const connection = new h.Connection(ws);
    connection.isReady = true;
    const appControl = { module: h.example, args: 'video=42' };
    h.attach(new Map([['wsConn', connection]]), appControl);
    h.timer.advance(1000);
    assert.equal(launches(h, ws)[0].payload.type, 'appControl');
    assert.deepEqual(appControl, { module: null, args: null });
});

for (const readyFirst of [false, true]) {
    test(`launch readiness reaches UI once when ${readyFirst ? 'UI' : 'debugger'} becomes ready first`, async () => {
        const h = serviceHarness();
        h.start();
        await settle();
        const ws = h.connect();
        if (readyFirst) ws.message(h.Events.Ready);
        h.debug(ws);
        if (!readyFirst) {
            ws.message(h.Events.GetModules);
            h.timer.advance(1000);
            assert.equal(launches(h, ws).length, 0, 'GetModules is not the UI Ready acknowledgment');
            ws.message(h.Events.Ready);
        }
        h.timer.advance(1000);
        ws.message(h.Events.Ready);
        h.timer.advance(1000);
        assert.equal(launches(h, ws).length, 1, 'repeated Ready must not repeat startup launch');
    });
}

test('a fresh UI receives launch readiness when the debugger is already attached', async () => {
    const h = serviceHarness();
    h.start();
    await settle();
    const oldWs = h.connect();
    oldWs.message(h.Events.Ready);
    h.debug(oldWs);
    h.timer.advance(1000);
    oldWs.close();
    h.config.autoLaunchModule = 'npm/changed';
    const ws = h.connect();
    ws.message(h.Events.GetDebugStatus);
    assert.equal(ws.sent.at(-1).payload.webDebug, true);
    ws.message(h.Events.GetModules);
    ws.message(h.Events.Ready);
    h.timer.advance(1000);
    assert.equal(launches(h, ws).length, 1, 'warm UI reconnect must receive its own startup instruction');
    assert.equal(launches(h, ws)[0].payload.module, 'npm/changed', 'warm UI must receive the current setting');
});

test('an unready readiness probe cannot consume a pending startup event', async () => {
    const h = serviceHarness();
    h.start();
    await settle();
    const ws = h.connect();
    ws.message(h.Events.Ready);
    const probe = h.connect();
    h.debug(ws);
    h.timer.advance(1000);
    assert.equal(launches(h, probe).length, 0, 'a raw websocket is not a launcher UI');
    assert.equal(launches(h, ws).length, 1, 'the Ready UI keeps ownership during the probe');
});

test('a replaced UI close cannot clear the active replacement', async () => {
    const h = serviceHarness();
    h.start();
    await settle();
    const oldWs = h.connect();
    oldWs.message(h.Events.Ready);
    const ws = h.connect();
    ws.message(h.Events.Ready);
    oldWs.close();
    h.debug(ws);
    h.timer.advance(1000);
    assert.equal(launches(h, ws).length, 1);
    assert.equal(launches(h, oldWs).length, 0);
});

test('no configured autolaunch still reports that the module menu is ready', async () => {
    const h = serviceHarness();
    h.config.autoLaunchModule = '';
    h.start();
    await settle();
    const ws = h.connect();
    ws.message(h.Events.Ready);
    h.debug(ws);
    h.timer.advance(1000);
    assert.deepEqual(launches(h, ws), [{ type: h.Events.CanLaunchModules, payload: null }]);
});

test('startup reads the current autolaunch setting when the UI acknowledges Ready', async () => {
    const h = serviceHarness();
    h.start();
    await settle();
    const ws = h.connect();
    h.debug(ws);
    h.config.autoLaunchModule = 'npm/updated';
    ws.message(h.Events.GetModules);
    ws.message(h.Events.Ready);
    h.timer.advance(1000);
    assert.equal(launches(h, ws)[0].payload.module, 'npm/updated');
});

test('explicit appControl overrides autolaunch and is consumed after one UI delivery', async () => {
    const h = serviceHarness();
    h.start();
    await settle();
    const ws = h.connect();
    ws.message(h.Events.AppControlData, { package: 'npm/example', args: 'video=42' });
    ws.message(h.Events.Ready);
    h.debug(ws);
    h.timer.advance(1000);
    ws.message(h.Events.Ready);
    assert.equal(launches(h, ws).length, 1);
    assert.equal(launches(h, ws)[0].payload.type, 'appControl');
    assert.equal(launches(h, ws)[0].payload.args, 'video=42');
    ws.close();
    const fresh = h.connect();
    fresh.message(h.Events.GetModules);
    fresh.message(h.Events.Ready);
    h.timer.advance(1000);
    assert.equal(launches(h, fresh).length, 1);
    assert.equal(launches(h, fresh)[0].payload.type, 'autolaunch', 'appControl metadata must not replay on a later UI');
});
