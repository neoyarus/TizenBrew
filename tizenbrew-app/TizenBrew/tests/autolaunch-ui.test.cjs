'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { uiHarness } = require('./helpers.cjs');

const example = {
    name: 'example', fullName: 'npm/example', keys: ['MediaPlay'], appPath: '/example.html',
    evaluateScriptOnDocumentStart: false
};
function launchRequests(h, ws) { return ws.sent.filter(event => event.type === h.Events.LaunchModule); }

test('an already-open startup socket performs the Client handshake immediately', () => {
    const h = uiHarness();
    const reused = new h.Client(h.context).socket;
    reused.readyState = 1;
    reused.sent.length = 0;
    const client = h.create(reused);
    assert.equal(client.socket, reused, 'Client must retain the available startup socket');
    assert.deepEqual(reused.sent, [{ type: h.Events.GetDebugStatus }]);
});

test('service startup uses one websocket for probing and the Client protocol', () => {
    const h = uiHarness();
    h.startService();
    assert.equal(h.sockets.length, 1);
    h.sockets[0].open();
    assert.equal(h.sockets.length, 1, 'opening the probe must not create a competing websocket');
    assert.equal(h.sockets[0].sent[0].type, h.Events.GetDebugStatus);
});

for (const early of [false, true]) {
    test(`duplicate autolaunch events ${early ? 'before' : 'after'} modules arrive launch once`, () => {
        const h = uiHarness();
        const ws = h.create().socket;
        ws.open();
        const payload = { type: 'autolaunch', module: example.fullName };
        if (!early) ws.message(h.Events.GetModules, [example]);
        ws.message(h.Events.CanLaunchModules, payload);
        ws.message(h.Events.CanLaunchModules, payload);
        if (early) ws.message(h.Events.GetModules, [example]);
        assert.equal(launchRequests(h, ws).length, 1, 'one startup instruction must produce one launch request');
        assert.equal(h.keys.length, 1, 'remote control keys should be registered only once');
        assert.equal(h.location.href, example.appPath);
    });
}

test('manual UP autolaunch suppression preserves the connected module menu', () => {
    const h = uiHarness();
    h.window.shouldDisableAutoLaunch = true;
    const ws = h.create().socket;
    ws.open();
    ws.message(h.Events.GetModules, [example]);
    ws.message(h.Events.CanLaunchModules, { type: 'autolaunch', module: example.fullName });
    assert.equal(launchRequests(h, ws).length, 0);
    assert.equal(h.location.href, '/menu.html');
    assert.equal(h.context.state.sharedData.debugStatus.webDebug, true);
    assert.ok(h.dispatches.some(action => action.type === 'SET_STATE' && action.payload === 'service.connected'));
});

test('a null startup instruction enables the menu without launching', () => {
    const h = uiHarness();
    const ws = h.create().socket;
    ws.open();
    ws.message(h.Events.GetModules, [example]);
    ws.message(h.Events.CanLaunchModules, null);
    assert.equal(launchRequests(h, ws).length, 0);
    assert.equal(h.context.state.sharedData.debugStatus.webDebug, true);
});

test('explicit appControl launches once with arguments even when autolaunch is suppressed', () => {
    const h = uiHarness();
    h.window.shouldDisableAutoLaunch = true;
    const ws = h.create().socket;
    ws.open();
    ws.message(h.Events.GetModules, [example]);
    const payload = { type: 'appControl', module: example, args: 'video=42' };
    ws.message(h.Events.CanLaunchModules, payload);
    ws.message(h.Events.CanLaunchModules, payload);
    assert.equal(launchRequests(h, ws).length, 1);
    assert.equal(h.location.href, '/example.html?video=42');
});

test('document-start modules wait for the debugger LaunchModule acknowledgment', () => {
    const h = uiHarness();
    const ws = h.create().socket;
    ws.open();
    const module = { ...example, evaluateScriptOnDocumentStart: true };
    ws.message(h.Events.GetModules, [module]);
    ws.message(h.Events.CanLaunchModules, { type: 'autolaunch', module: module.fullName });
    assert.equal(launchRequests(h, ws).length, 1);
    assert.equal(h.location.href, '/menu.html', 'navigation must wait for document-start script installation');
    ws.message(h.Events.LaunchModule, module.fullName);
    assert.equal(h.location.href, module.appPath, 'debugger acknowledgment must finish navigation');
});

test('the menu stays covered when modules arrive before the startup launch decision', () => {
    const h = uiHarness();
    const ws = h.create().socket;
    ws.open();
    ws.message(h.Events.GetModules, [example]);
    assert.equal(h.context.state.sharedData.startupPending, true);
    ws.message(h.Events.CanLaunchModules, { type: 'autolaunch', module: example.fullName });
    assert.equal(h.context.state.sharedData.startupPending, true, 'do not flash menu before navigation');
    assert.equal(h.location.href, example.appPath);
});

test('late debug status cannot restore captured startup state after UP reveals the menu', () => {
    const h = uiHarness();
    const capturedContext = { state: h.context.state, dispatch: h.context.dispatch };
    const client = new h.Client(capturedContext);
    client.socket.open();
    h.window.shouldDisableAutoLaunch = true;
    client.cancelAutoLaunch();
    client.socket.message(h.Events.GetDebugStatus, { tizenDebug: true });
    assert.equal(h.context.state.sharedData.startupPending, false);
    client.socket.message(h.Events.GetModules, [example]);
    client.socket.message(h.Events.CanLaunchModules, { type: 'autolaunch', module: example.fullName });
    assert.equal(h.context.state.sharedData.startupPending, false);
    assert.equal(h.context.state.sharedData.debugStatus.tizenDebug, true);
    assert.equal(launchRequests(h, client.socket).length, 0);
});

for (const payload of [null, { type: 'autolaunch', module: example.fullName }]) {
    test(`manual startup reveals the menu (${payload ? 'UP override' : 'no autolaunch'})`, () => {
        const h = uiHarness();
        h.window.shouldDisableAutoLaunch = !!payload;
        const ws = h.create().socket;
        ws.open();
        ws.message(h.Events.GetModules, [example]);
        ws.message(h.Events.CanLaunchModules, payload);
        assert.equal(h.context.state.sharedData.startupPending, false);
        h.timer.advance(20000);
        assert.equal(h.context.state.sharedData.error.message, null, 'manual menu has no startup timeout');
    });
}

test('document-start injection keeps the menu covered while waiting for acknowledgment', () => {
    const h = uiHarness();
    const ws = h.create().socket;
    ws.open();
    const module = { ...example, evaluateScriptOnDocumentStart: true };
    ws.message(h.Events.GetModules, [module]);
    ws.message(h.Events.CanLaunchModules, { type: 'autolaunch', module: module.fullName });
    assert.equal(h.context.state.sharedData.startupPending, true);
    assert.equal(h.location.href, '/menu.html');
    ws.message(h.Events.LaunchModule, module.fullName);
    assert.equal(h.location.href, module.appPath);
});

for (const cancel of ['timeout', 'UP']) {
    test(`a late document-start startup acknowledgment cannot override the menu after ${cancel}`, () => {
        const h = uiHarness();
        const client = h.create();
        const ws = client.socket;
        ws.open();
        const module = { ...example, evaluateScriptOnDocumentStart: true };
        ws.message(h.Events.GetModules, [module]);
        ws.message(h.Events.CanLaunchModules, { type: 'autolaunch', module: module.fullName });
        if (cancel === 'timeout') h.timer.advance(20000);
        else {
            h.window.shouldDisableAutoLaunch = true;
            client.cancelAutoLaunch();
        }
        ws.message(h.Events.LaunchModule, module.fullName);
        assert.equal(h.location.href, '/menu.html');
        assert.equal(h.context.state.sharedData.startupPending, false);
        client.launchModule(module);
        ws.message(h.Events.LaunchModule, module.fullName);
        assert.equal(h.location.href, module.appPath, 'manual module selection still navigates after its acknowledgment');
    });
}

test('startup errors reveal the menu and a visible error instead of reloading', () => {
    for (const trigger of [
        (h, ws) => ws.message(h.Events.Error, 'Failed to connect to the debugger'),
        (h, ws) => ws.message(h.Events.CanLaunchInDebug, false),
        (h, ws) => ws.onerror(),
        (h, ws) => ws.onclose(),
        h => h.timer.advance(20000)
    ]) {
        const h = uiHarness();
        const ws = h.create().socket;
        ws.open();
        trigger(h, ws);
        assert.equal(h.context.state.sharedData.startupPending, false);
        assert.ok(h.context.state.sharedData.error.message);
        assert.equal(h.reloads, 0);
    }
});

test('missing autolaunch modules reveal a usable module menu', () => {
    const h = uiHarness();
    const ws = h.create().socket;
    ws.open();
    ws.message(h.Events.GetModules, [example]);
    ws.message(h.Events.CanLaunchModules, { type: 'autolaunch', module: 'npm/missing' });
    assert.equal(h.context.state.sharedData.startupPending, false);
    assert.equal(h.context.state.sharedData.error.message, 'errors.moduleNotFound');
    assert.equal(launchRequests(h, ws).length, 0);
});

test('cold service startup reconnects in place and retains the connected socket', () => {
    const h = uiHarness();
    h.startService();
    h.sockets[0].onerror();
    assert.equal(h.serviceLaunches.length, 1);
    h.serviceLaunches[0].success();
    h.timer.advance(100);
    h.sockets[1].onerror();
    h.timer.advance(100);
    const ws = h.sockets[2];
    ws.open();
    assert.equal(h.serviceLaunches.length, 1, 'launch service only once during connection retries');
    assert.equal(h.context.state.client.socket, ws);
    assert.equal(ws.sent[0].type, h.Events.GetDebugStatus);
    assert.equal(h.reloads, 0, 'cold startup must not reload the document');
    h.timer.advance(10000);
    assert.equal(h.context.state.sharedData.error.message, null, 'connection deadline was cleared');
});

test('failed service startup stops retrying and reveals its error', () => {
    for (const reject of [false, true]) {
        const h = uiHarness();
        h.startService();
        h.sockets[0].onerror();
        if (reject) h.serviceLaunches[0].failure({ message: 'Unavailable' });
        else {
            h.serviceLaunches[0].success();
            h.timer.advance(10000);
        }
        assert.equal(h.context.state.sharedData.startupPending, false);
        assert.ok(h.context.state.sharedData.error.message);
        const attempts = h.sockets.length;
        h.timer.advance(20000);
        assert.equal(h.sockets.length, attempts);
        assert.equal(h.reloads, 0);
    }
});
