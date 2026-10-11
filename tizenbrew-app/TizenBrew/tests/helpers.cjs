'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');

function source(file) {
    if (process.env.TIZENBREW_TEST_REF) {
        const relative = path.relative(repoRoot, file).split(path.sep).join('/');
        return execFileSync('git', ['show', `${process.env.TIZENBREW_TEST_REF}:${relative}`], {
            cwd: repoRoot, encoding: 'utf8'
        });
    }
    return fs.readFileSync(file, 'utf8');
}

function clock() {
    let now = 0;
    let nextId = 0;
    const timers = new Map();
    return {
        setTimeout(callback, delay = 0) {
            const id = ++nextId;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        advance(ms) {
            const until = now + ms;
            let iterations = 0;
            while (true) {
                const pending = [...timers].filter(([, timer]) => timer.at <= until)
                    .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!pending) break;
                if (++iterations > 10000) throw new Error('Timer loop did not settle');
                timers.delete(pending[0]);
                now = pending[1].at;
                pending[1].callback();
            }
            now = until;
        }
    };
}

function socket(readyState = 1) {
    const ws = new EventEmitter();
    ws.readyState = readyState;
    ws.sent = [];
    ws.send = data => ws.sent.push(JSON.parse(data));
    ws.close = () => { ws.readyState = 3; ws.emit('close'); };
    ws.message = (type, payload) => ws.emit('message', JSON.stringify({ type, payload }));
    return ws;
}

function serviceHarness(options = {}) {
    const timer = clock();
    const config = { modules: [], autoLaunchServiceList: [], autoLaunchModule: 'npm/example' };
    const example = {
        name: 'example', fullName: 'npm/example', keys: ['MediaPlay'], appPath: '/example.html',
        packageType: 'module', mainFile: 'main.js', evaluateScriptOnDocumentStart: false
    };
    const cdpClients = [];
    const scriptRequests = [];
    const adbClients = [];
    let server;
    const cache = new Map();
    const mockWebSocket = { OPEN: 1, Server: class extends EventEmitter {
        constructor() { super(); server = this; }
    } };
    const context = vm.createContext({
        console: { log() {} }, process: { version: process.version },
        setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
        tizen: {
            systeminfo: { getCapability: () => '5.0' },
            application: { getAppInfo: () => ({ packageId: 'test' }) }
        }
    });
    const mocks = {
        'ws': mockWebSocket, 'ws-old': mockWebSocket, 'ws-new': mockWebSocket,
        'chrome-remote-interface': (cdpOptions, callback) => {
            const client = new EventEmitter();
            client.Runtime = { enable() {}, evaluate() {} };
            client.Debugger = { enable() {} };
            client.Page = { addScriptToEvaluateOnNewDocument(request) {
                const pending = { request };
                scriptRequests.push(pending);
                if (options.deferScripts) return new Promise(resolve => { pending.resolve = resolve; });
                return Promise.resolve();
            } };
            cdpClients.push(client);
            callback(client);
            return client;
        },
        'node-fetch': () => Promise.resolve({
            json: () => Promise.resolve({ device: { developerIP: '127.0.0.1', developerMode: '1' } }),
            text: () => Promise.resolve('module source')
        }),
        express: () => ({ all() {}, listen() { return {}; } }),
        adbhost: { createConnection() {
            const stream = new EventEmitter();
            stream.end = () => {};
            const shell = new EventEmitter();
            const client = { _stream: stream, shell, createStream: () => shell };
            adbClients.push(client);
            return client;
        } }
    };
    function load(file) {
        if (cache.has(file)) return cache.get(file).exports;
        const module = { exports: {} };
        cache.set(file, module);
        const requireMock = request => {
            if (Object.hasOwn(mocks, request)) return mocks[request];
            if (request.endsWith('configuration.js')) return { readConfig: () => config, writeConfig() {} };
            if (request.endsWith('moduleLoader.js')) return () => Promise.resolve([example]);
            if (request.endsWith('serviceLauncher.js')) return () => {};
            if (request.startsWith('.')) return load(path.resolve(path.dirname(file), request));
            return require(request);
        };
        const wrapper = vm.runInContext(`(function(require, module, exports) {\n${source(file)}\n})`, context, { filename: file });
        wrapper(requireMock, module, module.exports);
        return module.exports;
    }
    const serviceRoot = path.join(appRoot, 'service-nextgen/service');
    const { Connection, Events } = load(path.join(serviceRoot, 'utils/wsCommunication.js'));
    const startDebugging = load(path.join(serviceRoot, 'utils/debugger.js'));
    return {
        timer, config, example, Events, Connection, cdpClients, scriptRequests,
        start() { load(path.join(serviceRoot, 'index.js')).onStart(); },
        connect() { const ws = socket(); server.emit('connection', ws); return ws; },
        debug(ws) {
            ws.message(Events.ReLaunchInDebug, { tvIP: '127.0.0.1' });
            timer.advance(1000);
            const adb = adbClients.at(-1);
            adb._stream.emit('connect');
            adb.shell.emit('data', Buffer.from('debug: 9222'));
        },
        attach(services, appControl = { module: null, args: null }, mdl = { name: '' }) {
            const state = { tizenDebug: false, webDebug: false, rwiDebug: false };
            startDebugging(9222, [], services, '127.0.0.1', mdl, state, appControl, false);
            return state;
        }
    };
}

async function settle() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

function uiHarness(appControlData = []) {
    const timer = clock();
    const sockets = [];
    const dispatches = [];
    const keys = [];
    const serviceLaunches = [];
    let reloads = 0;
    const stateSource = source(path.join(appRoot, 'tizenbrew-ui/src/components/ClientContext.jsx'));
    const stateCode = stateSource.slice(stateSource.indexOf('const initialState'), stateSource.indexOf('export const GlobalStateContext'));
    const stateModule = vm.runInNewContext(stateCode + '\n({ initialState, reducer })');
    const context = {
        state: stateModule.initialState,
        dispatch(action) { dispatches.push(action); context.state = stateModule.reducer(context.state, action); }
    };
    const location = { href: '/menu.html', reload() { reloads++; } };
    class WebSocket {
        static OPEN = 1;
        constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { this.readyState = 3; }
        open() { this.readyState = 1; this.onopen(); }
        message(type, payload) { this.onmessage({ data: JSON.stringify({ type, payload }) }); }
    }
    const sandbox = {
        module: { exports: {} }, WebSocket, location,
        window: { location, shouldDisableAutoLaunch: false },
        setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
        tizen: {
            ApplicationControl: function (operation) { this.operation = operation; },
            application: {
                launchAppControl(control, id, success, failure) { serviceLaunches.push({ control, id, success, failure }); },
                getCurrentApplication: () => ({
                    appInfo: { packageId: 'test' },
                    getRequestedAppControl: () => ({ appControl: { data: appControlData } }), exit() {}
                })
            },
            tvinputdevice: { registerKey: key => keys.push(key) }
        }, webapis: { network: { getIp: () => '127.0.0.1' } }
    };
    const code = source(path.join(appRoot, 'tizenbrew-ui/src/components/WebSocketClient.js'))
        .replace(/^export .*;\s*$/gm, '') + '\nmodule.exports = { Client, Events };';
    const vmContext = vm.createContext(sandbox);
    vm.runInContext(code, vmContext);
    const { Client, Events } = sandbox.module.exports;
    return {
        timer, sockets, dispatches, keys, context, location, window: sandbox.window, Client, Events,
        serviceLaunches, get reloads() { return reloads; },
        create(existingSocket) { return new Client(context, existingSocket); },
        startService() {
            // This standalone function has no JSX; execute its actual source with the real Client.
            const app = source(path.join(appRoot, 'tizenbrew-ui/src/app.jsx'));
            vmContext.Client = Client;
            vm.runInContext(app.slice(app.indexOf('function startService(context)')), vmContext);
            vmContext.startService(context);
        }
    };
}

module.exports = { serviceHarness, uiHarness, settle, socket };
