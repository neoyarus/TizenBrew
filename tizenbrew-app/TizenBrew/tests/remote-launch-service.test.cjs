'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const { serviceHarness, settle } = require('./helpers.cjs');

async function enabledHarness() {
    const h = serviceHarness({ remoteLauncher: true });
    h.start();
    await settle();
    return h;
}

test('remote listener is absent unless explicitly enabled with a valid token', () => {
    for (const remoteLauncher of [undefined, { enabled: false, token: 'a'.repeat(64) }, { enabled: true, token: 'weak' }]) {
        const h = serviceHarness();
        h.config.remoteLauncher = remoteLauncher;
        h.start();
        assert.equal(h.remoteServer, undefined);
    }
});

test('fixed debug command buffers a split port and attaches once despite repeated output', async () => {
    const h = await enabledHarness();
    const response = h.requestRemote({ method: 'POST', path: '/launch' });
    await settle();
    assert.equal(h.adbClients.length, 1);
    const adb = h.adbClients[0];
    adb._stream.emit('connect');
    assert.deepEqual(adb.commands, ['shell:0 debug test.TizenBrewStandalone']);
    adb.shell.emit('data', Buffer.from('debug po'));
    adb.shell.emit('data', Buffer.from('rt: 39'));
    assert.equal(h.cdpClients.length, 0, 'partial digits cannot select a truncated port');
    adb.shell.emit('data', Buffer.from('415\n'));
    adb.shell.emit('data', Buffer.from('debug port: 39415\n'));
    adb.shell.emit('end');
    await response.done;
    assert.equal(h.cdpClients.length, 1);
    assert.equal(h.cdpClients[0].options.port, 39415);
    assert.equal(response.status, 200);
    assert.equal(response.body.mode, 'debug');
    assert.equal(h.requestRemote().body.debugLaunches, 1);
});

test('SDB shell end accepts the full port without a trailing newline', async () => {
    const h = await enabledHarness();
    const response = h.requestRemote({ method: 'POST', path: '/launch' });
    await settle();
    const adb = h.adbClients[0];
    adb._stream.emit('connect');
    adb.shell.emit('data', Buffer.from('port: 39415'));
    assert.equal(h.cdpClients.length, 0);
    adb.shell.emit('end');
    await response.done;
    assert.equal(response.status, 200);
    assert.equal(h.cdpClients.length, 1);
});

test('SDB NUL-terminated port attaches once without waiting for readable end', async () => {
    const h = await enabledHarness();
    const response = h.requestRemote({ method: 'POST', path: '/launch' });
    await settle();
    const adb = h.adbClients[0];
    adb._stream.emit('connect');
    adb.shell.emit('data', Buffer.from('debug port: 39415\x00'));
    adb.shell.emit('finish');
    adb.shell.emit('data', Buffer.from('debug port: 39415\x00'));
    await response.done;
    assert.equal(response.status, 200);
    assert.equal(h.cdpClients.length, 1);
    assert.equal(h.cdpClients[0].options.port, 39415);
    assert.equal(h.requestRemote().body.lastDebugPort, 39415);
});

test('adbhost-style writable CLSE finish consumes a delimiterless buffered port', async () => {
    const h = await enabledHarness();
    const response = h.requestRemote({ method: 'POST', path: '/launch' });
    await settle();
    const adb = h.adbClients[0];
    adb.shell = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    let readableEnded = false;
    adb.shell.on('end', () => { readableEnded = true; });
    adb._stream.emit('connect');
    adb.shell.push(Buffer.from('debug port: 39'));
    adb.shell.push(Buffer.from('415'));
    assert.equal(h.cdpClients.length, 0, 'the split numeric response is not complete before CLSE');
    // This is exactly what adbhost 0.0.2 calls on receipt of an SDB CLSE packet.
    adb.shell.end();
    await response.done;
    assert.equal(readableEnded, false);
    assert.equal(response.status, 200);
    assert.equal(h.cdpClients.length, 1);
    assert.equal(h.cdpClients[0].options.port, 39415);
});

test('timed-out SDB attempt cannot execute a late connect and a fresh attempt can succeed', async () => {
    const h = await enabledHarness();
    const first = h.requestRemote({ method: 'POST', path: '/launch' });
    await settle();
    const abandoned = h.adbClients[0];
    h.timer.advance(12000);
    await first.done;
    assert.equal(first.status, 503);
    abandoned._stream.emit('connect');
    assert.equal(abandoned.commands.length, 0);
    const second = h.requestRemote({ method: 'POST', path: '/launch' });
    await settle();
    const current = h.adbClients[1];
    current._stream.emit('connect');
    current.shell.emit('data', Buffer.from('port: 39415\n'));
    await second.done;
    assert.equal(second.status, 200);
    assert.equal(h.cdpClients.length, 1);
});

test('synchronous ADB failure releases the launch latch for a later request', async () => {
    const h = await enabledHarness();
    h.adbControl.fail = true;
    const first = h.requestRemote({ method: 'POST', path: '/launch' });
    await first.done;
    assert.equal(first.status, 503);
    h.adbControl.fail = false;
    const second = h.requestRemote({ method: 'POST', path: '/launch' });
    await settle();
    assert.equal(h.adbClients.length, 1);
    const adb = h.adbClients[0];
    adb._stream.emit('connect');
    adb.shell.emit('data', Buffer.from('port: 39415\n'));
    await second.done;
    assert.equal(second.status, 200);
});

test('slow live-session history probe does not terminate or relaunch a potentially paused app', async () => {
    const h = await enabledHarness();
    const ws = h.connect();
    h.debug(ws);
    await settle();
    const client = h.cdpClients[0];
    let resolveHistory;
    client.history = () => new Promise(resolve => { resolveHistory = resolve; });
    const response = h.requestRemote({ method: 'POST', path: '/launch' });
    await settle();
    h.timer.advance(1000);
    await response.done;
    assert.equal(response.status, 503);
    assert.equal(client.closed, undefined);
    assert.equal(h.adbClients.length, 1);
    resolveHistory({ currentIndex: 0, entries: [{ url: h.example.appPath }] });
    await settle();
    assert.equal(h.resumeRequests.length, 0, 'late probe completion cannot resume after a failure was returned');
});
