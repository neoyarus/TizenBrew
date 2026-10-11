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
