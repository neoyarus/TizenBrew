'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { copyRemoteConfig } = require('../service/config.cjs');

test('legacy private configuration omits both remote settings and remains valid', () => {
    assert.deepEqual(copyRemoteConfig({}, { port: 8098 }), { port: 8098 });
});

test('token and name are optional independently and valid boundary values survive', () => {
    assert.deepEqual(copyRemoteConfig({ tvRemoteToken: 'x'.repeat(1024) }, {}), { tvRemoteToken: 'x'.repeat(1024) });
    assert.deepEqual(copyRemoteConfig({ tvRemoteName: '界'.repeat(21) }, {}), { tvRemoteName: '界'.repeat(21) });
    assert.deepEqual(copyRemoteConfig({ tvRemoteToken: 'authorized', tvRemoteName: 'HomeAssistant', unrelated: 'ignored' }, {}),
        { tvRemoteToken: 'authorized', tvRemoteName: 'HomeAssistant' });
});

test('remote config rejects malformed values using a generic error without echoing credentials', () => {
    for (const remote of [
        { tvRemoteToken: null }, { tvRemoteToken: 12345 }, { tvRemoteToken: '' }, { tvRemoteToken: ' ' },
        { tvRemoteToken: 'sensitive'.repeat(128) }, { tvRemoteName: '' }, { tvRemoteName: {} },
        { tvRemoteName: '界'.repeat(22) }, { tvRemoteName: 'x'.repeat(65) }
    ]) {
        assert.throws(() => copyRemoteConfig(remote, {}), { message: 'Invalid optional remote configuration' });
    }
});

test('private remote host accepts IPv4 literals but rejects DNS, URL, IPv6 and ambiguous addresses', () => {
    for (const host of ['127.0.0.1', '192.168.11.200', '0.0.0.0', '255.255.255.255']) {
        assert.deepEqual(copyRemoteConfig({ tvRemoteHost: host }, {}), { tvRemoteHost: host });
    }
    for (const host of ['', null, 123, 'localhost', 'http://192.168.11.200', '192.168.11.200:8002', '::1',
        '256.0.0.1', '-1.0.0.1', '1.2.3', '01.2.3.4', '1.2.3.4\n', '1.2.3.4 ']) {
        assert.throws(() => copyRemoteConfig({ tvRemoteHost: host }, {}), { message: 'Invalid optional remote configuration' });
    }
});
