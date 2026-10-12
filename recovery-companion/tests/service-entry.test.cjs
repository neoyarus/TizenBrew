'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../service/index.js'), 'utf8');

function harness(raw) {
    const logs = [];
    const reads = [];
    const starts = [];
    let closed = 0;
    const handles = [];
    const context = {
        __dirname: '/companion/service', module: { exports: {} },
        console: { log(message) { logs.push(message); } },
        require(name) {
            if (name === 'fs') return { readFileSync(file) { reads.push(file); return raw; } };
            if (name === 'path') return path.posix;
            if (name === './core.cjs') return { start(options) {
                starts.push(options);
                const handle = { closed: false, isClosed() { return handle.closed; }, close() { handle.closed = true; closed++; } };
                handles.push(handle);
                return handle;
            } };
            throw new Error('Unexpected dependency');
        }
    };
    vm.runInNewContext(source, context);
    return { callbacks: context.module.exports, logs, reads, starts, handles, get closed() { return closed; } };
}

test('service entry reads packaged private configuration and remains idempotent across requests', () => {
    const h = harness(JSON.stringify({ publicKey: 'public', tlsKey: 'server-key', tlsCert: 'server-cert', port: 8098, unrelated: 'ignored' }));
    h.callbacks.onStart();
    h.callbacks.onRequest();
    assert.deepEqual(h.reads, ['/companion/service/recovery-config.json']);
    assert.equal(h.starts.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.starts[0])), { publicKey: 'public', tlsKey: 'server-key', tlsCert: 'server-cert', port: 8098 });
    h.callbacks.onExit();
    h.callbacks.onStop();
    assert.equal(h.closed, 1);
});

test('a new service request retries a core that closed after a listener failure', () => {
    const h = harness(JSON.stringify({ publicKey: 'public', tlsKey: 'server-key', tlsCert: 'server-cert', port: 8098 }));
    h.callbacks.onStart();
    h.handles[0].closed = true;
    h.callbacks.onRequest();
    assert.equal(h.starts.length, 2);
    h.callbacks.onStop();
    assert.equal(h.handles[1].closed, true);
});

test('invalid private configuration never starts the endpoint or leaks its contents into logs', () => {
    const h = harness('PRIVATE_SERVER_KEY invalid-json');
    h.callbacks.onStart();
    assert.equal(h.starts.length, 0);
    assert.equal(h.logs.length, 1);
    assert.doesNotMatch(h.logs[0], /PRIVATE_SERVER_KEY/);
});
