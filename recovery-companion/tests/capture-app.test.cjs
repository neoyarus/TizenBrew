'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { captureApp, parseArgs, decodePng, targetSocketUrl, getTargets, openCdp, APP_ID } = require('../client/capture-app.cjs');
const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const options = { config: path.resolve('private-capture-config.json'), sdb: path.resolve('sdb.exe'), port: 39415, out: path.resolve('capture.png') };

function fixture(ids = [APP_ID]) {
  const calls = [], writes = [], closed = [];
  let target = 0;
  const dependencies = {
    fs: { existsSync: () => false, statSync: () => ({ size: 2 }), readFileSync: () => '{}', writeFileSync: (...args) => writes.push(args) },
    createClient: () => ({ tunnel: async port => { calls.push(['tunnel', port]); return { port: 26122, close: () => closed.push('tunnel') }; }, close: () => closed.push('client') }),
    runSdb: async (exe, args) => calls.push(['sdb', exe, args]), freePort: async () => 36211,
    getTargets: async () => ids.map((_, i) => ({ type: 'page', webSocketDebuggerUrl: 'ws://192.168.11.200:39415/devtools/page/' + i })),
    openCdp: async url => {
      const id = ids[target++];
      calls.push(['websocket', url]);
      return { call: async (method, params) => {
        calls.push(['cdp', method, params]);
        if (method === 'Runtime.evaluate') return { result: { type: typeof id === 'string' ? 'string' : 'object', value: id } };
        if (method === 'Page.captureScreenshot') return { data: PNG.toString('base64') };
        throw new Error('Unexpected debugger mutation');
      }, close: () => closed.push('cdp') };
    }
  };
  return { dependencies, calls, writes, closed };
}

test('existing own app capture uses only attestation and screenshot and removes only its own SDB resources', async () => {
  const f = fixture();
  const result = await captureApp(options, f.dependencies);
  assert.equal(result.scope, 'app-document');
  assert.equal(result.appId, APP_ID);
  assert.deepEqual(f.calls.filter(x => x[0] === 'cdp').map(x => x[1]), ['Runtime.evaluate', 'Page.captureScreenshot']);
  assert.deepEqual(f.calls.filter(x => x[0] === 'sdb').map(x => x[2]), [
    ['connect', '127.0.0.1:26122'], ['-s', '127.0.0.1:26122', 'forward', 'tcp:36211', 'tcp:39415'],
    ['-s', '127.0.0.1:26122', 'forward', '--remove', 'tcp:36211'], ['disconnect', '127.0.0.1:26122']
  ]);
  assert.equal(f.calls.find(x => x[0] === 'websocket')[1], 'ws://127.0.0.1:36211/devtools/page/0');
  assert.deepEqual(f.writes[0], [options.out, PNG, { flag: 'wx', mode: 0o600 }]);
  assert.deepEqual(f.closed, ['cdp', 'tunnel', 'client']);
});

test('an uncertain forwarding timeout still removes the attempted exact port and closes its own transport', async () => {
  const f = fixture();
  f.dependencies.runSdb = async (executable, args) => {
    f.calls.push(['sdb', executable, args]);
    if (args[2] === 'forward' && args[3] !== '--remove') throw new Error('Forward command timed out after possible success');
  };
  await assert.rejects(captureApp(options, f.dependencies), /Forward command timed out/);
  assert.deepEqual(f.calls.filter(call => call[0] === 'sdb').map(call => call[2]), [
    ['connect', '127.0.0.1:26122'], ['-s', '127.0.0.1:26122', 'forward', 'tcp:36211', 'tcp:39415'],
    ['-s', '127.0.0.1:26122', 'forward', '--remove', 'tcp:36211'], ['disconnect', '127.0.0.1:26122']
  ]);
  assert.equal(f.calls.some(call => call[0] === 'websocket'), false);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.closed, ['tunnel', 'client']);
});

test('other app, missing API, and debugger errors cannot authorize any screenshot', async () => {
  for (const id of ['other.App', null, undefined]) {
    const f = fixture([id]);
    await assert.rejects(captureApp(options, f.dependencies), /Cannot attest/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.calls.some(x => x[1] === 'Page.captureScreenshot'), false);
    assert.deepEqual(f.closed, ['cdp', 'tunnel', 'client']);
  }
  const f = fixture();
  f.dependencies.openCdp = async () => ({ call: async () => { throw new Error('Unsupported Runtime'); }, close: () => f.closed.push('cdp') });
  await assert.rejects(captureApp(options, f.dependencies), /Cannot attest/);
  assert.equal(f.writes.length, 0);
});

test('mixed debugger targets capture only the successfully attested own app', async () => {
  const f = fixture(['some.OtherApp', APP_ID]);
  await captureApp(options, f.dependencies);
  assert.deepEqual(f.calls.filter(x => x[0] === 'cdp').map(x => x[1]), ['Runtime.evaluate', 'Runtime.evaluate', 'Page.captureScreenshot']);
  assert.equal(f.closed.filter(x => x === 'cdp').length, 2);
});

test('existing output and invalid arguments fail before opening tunnel; output creation remains exclusive', async () => {
  const f = fixture();
  f.dependencies.fs.existsSync = () => true;
  await assert.rejects(captureApp(options, f.dependencies), /already exists/);
  assert.equal(f.calls.length, 0);
  assert.equal(parseArgs(['--config', options.config, '--sdb', options.sdb, '--port', '39415', '--out', options.out]).port, 39415);
  for (const port of ['1', '65536', '39415;echo', '0x99f7']) assert.throws(() => parseArgs(['--config', options.config, '--sdb', options.sdb, '--port', port, '--out', options.out]));
  assert.throws(() => parseArgs(['--config', options.config, '--sdb', options.sdb, '--port', '39415', '--out', options.out, '--shell', 'command']));
  const raced = fixture();
  raced.dependencies.fs.writeFileSync = () => { throw new Error('EEXIST'); };
  await assert.rejects(captureApp(options, raced.dependencies), /EEXIST/);
  assert.deepEqual(raced.closed, ['cdp', 'tunnel', 'client']);
});

test('invalid and excessive PNGs cannot be saved and target-supplied hosts never select another network destination', () => {
  assert.deepEqual(decodePng({ data: PNG.toString('base64') }), PNG);
  for (const data of ['', 'not base64!', Buffer.from('not png').toString('base64'), 'AAAA'.repeat(3 * 1024 * 1024)]) assert.throws(() => decodePng({ data }));
  assert.equal(targetSocketUrl({ webSocketDebuggerUrl: 'ws://external.invalid:1234/devtools/page/1' }, 36211), 'ws://127.0.0.1:36211/devtools/page/1');
  for (const url of ['wss://localhost/devtools/page/1', 'ws://localhost/elsewhere', 'ws://localhost/devtools/page/1?token=secret']) assert.equal(targetSocketUrl({ webSocketDebuggerUrl: url }, 36211), null);
});

test('HTTP target-list reader caps bytes and does not follow redirects', async t => {
  let mode = 'valid';
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/json/list');
    if (mode === 'redirect') { response.writeHead(302, { Location: 'http://external.invalid' }); response.end('[]'); }
    else if (mode === 'large') response.end(' '.repeat(256 * 1024 + 1));
    else response.end('[]');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  assert.deepEqual(await getTargets(port), []);
  mode = 'redirect'; await assert.rejects(getTargets(port), /unavailable/);
  mode = 'large'; await assert.rejects(getTargets(port), /too large/);
});

test('real CDP transport sends no enable, navigation, launch, or debugger-close commands', async t => {
  const methods = [];
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.clients.forEach(client => client.terminate()); server.close(); });
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); methods.push(message.method);
    socket.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: {} }));
    socket.send(JSON.stringify({ id: message.id, result: message.method === 'Runtime.evaluate' ? { result: { value: APP_ID, type: 'string' } } : { data: PNG.toString('base64') } }));
  }));
  const cdp = await openCdp('ws://127.0.0.1:' + server.address().port + '/devtools/page/1');
  assert.equal((await cdp.call('Runtime.evaluate', { expression: 'fixed' })).result.value, APP_ID);
  assert.deepEqual(decodePng(await cdp.call('Page.captureScreenshot', { format: 'png' })), PNG);
  cdp.close();
  assert.deepEqual(methods, ['Runtime.evaluate', 'Page.captureScreenshot']);
});

test('real CDP transport rejects JSON null, arrays, primitives and invalid response ids without uncaught exceptions', async t => {
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.clients.forEach(client => client.terminate()); server.close(); });
  let response;
  server.on('connection', socket => {
    socket.on('error', () => {});
    socket.on('message', () => socket.send(response));
  });
  for (const value of [null, [], 'primitive', {}, { id: null }, { id: '1' }, { id: -1 }, { id: 1.5 }]) {
    response = JSON.stringify(value);
    const cdp = await openCdp('ws://127.0.0.1:' + server.address().port + '/devtools/page/invalid');
    try { await assert.rejects(cdp.call('Runtime.evaluate', {}, 1500), /Debugger connection closed/); }
    finally { cdp.close(); }
  }
});

test('actual ws4 CDP receiver rejects an oversized advertised frame before any payload is sent', async t => {
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.clients.forEach(client => client.terminate()); server.close(); });
  let sentBytes = 0;
  server.on('connection', socket => {
    socket.on('error', () => {});
    assert.equal(socket.extensions, '', 'capture does not negotiate compression');
    socket.on('message', () => {
      const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127;
      header.writeUInt32BE(12 * 1024 * 1024 + 1, 6);
      sentBytes += header.length;
      socket._socket.write(header); // No payload: receiver must reject from length alone.
    });
  });
  const cdp = await openCdp('ws://127.0.0.1:' + server.address().port + '/devtools/page/oversize');
  try { await assert.rejects(cdp.call('Page.captureScreenshot', {}, 1500), /Debugger connection closed/); }
  finally { cdp.close(); }
  assert.equal(sentBytes, 10);
});
