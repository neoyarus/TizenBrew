"use strict";

module.exports.onStart = function () {
    console.log('Service started');
    const adbhost = require('adbhost');
    const express = require('express');
    const fetch = require('node-fetch');
    const path = require('path');
    const url = require('url');
    const { readConfig, writeConfig } = require('./utils/configuration.js');
    const loadModules = require('./utils/moduleLoader.js');
    const startDebugging = require('./utils/debugger.js');
    const startService = require('./utils/serviceLauncher.js');
    const { Connection, Events } = require('./utils/wsCommunication.js');
    const { sendLaunchInformation } = require('./utils/clientInformation.js');
    const { startRemoteLauncher } = require('./utils/remoteLauncher.js');
    let WebSocket;
    if (process.version === 'v4.4.3') {
        WebSocket = require('ws-old');
    } else {
        WebSocket = require('ws-new');
    }


    const app = express();
    let deviceIP;
    const isTizen3 = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version').startsWith('3.0');

    // HTTP Proxy for modules 
    app.all('*', (req, res) => {
        if (req.url.startsWith('/module/')) {
            const splittedUrl = req.url.split('/');
            const encodedModuleName = splittedUrl[2];
            const moduleName = decodeURIComponent(encodedModuleName);
            fetch(`https://cdn.jsdelivr.net/${moduleName}/${req.url.replace(`/module/${encodedModuleName}/`, '')}`)
                .then(fetchRes => {
                    return fetchRes.body.pipe(res);
                })
                .then(() => {
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.type(path.basename(req.url.replace(`/module/${encodedModuleName}/`, '')).split('.').slice(-1)[0].split('?')[0]);
                });
        } else {
            res.send(deviceIP);
        }
    });

    const wsServer = new WebSocket.Server({ server: app.listen(8081, "127.0.0.1") });

    let adbClient;
    let debuggerClient = null;
    let debuggerGeneration = 0;
    let debugLaunchPromise = null;
    let debugLaunches = 0;
    let resumeRequests = 0;
    let lastSdbResponse = '';
    let lastDebugError = null;
    let lastDebugPort = null;
    let canLaunchInDebug = null;
    fetch('http://127.0.0.1:8001/api/v2/').then(res => res.json())
        .then(json => {
            canLaunchInDebug = (json.device.developerIP === '127.0.0.1' || json.device.developerIP === '1.0.0.127') && json.device.developerMode === '1';
        });
    const inDebug = {
        tizenDebug: false,
        webDebug: false,
        rwiDebug: false
    };

    const services = new Map();
    const queuedEvents = [];
    let modulesCache = null;

    const currentModule = {
        name: '',
        appPath: '',
        moduleType: '',
        packageType: '',
        serviceFile: ''
    };

    const appControlData = {
        module: null,
        args: null
    };

    loadModules().then(modules => {
        modulesCache = modules;
        const serviceModuleList = readConfig().autoLaunchServiceList;
        if (serviceModuleList.length > 0) {
            serviceModuleList.forEach(module => {
                const service = modules.find(m => m.name === module);
                if (service) startService(service, services);
            });
        }
    });


    function createAdbConnection(ip, mdl) {
        if (debugLaunchPromise) return debugLaunchPromise;
        lastSdbResponse = '';
        lastDebugError = null;
        lastDebugPort = null;
        deviceIP = ip;
        if (adbClient && adbClient._stream) {
            adbClient._stream.removeAllListeners('connect');
            adbClient._stream.removeAllListeners('error');
            adbClient._stream.removeAllListeners('close');
            adbClient._stream.end();
        }
        const previousClient = debuggerClient;
        const generation = ++debuggerGeneration;
        debuggerClient = null;
        if (previousClient && previousClient.close) Promise.resolve(previousClient.close()).catch(() => {});
        inDebug.tizenDebug = true;
        inDebug.webDebug = false;
        const pending = new Promise((resolve, reject) => {
            let startedDebugger = false;
            let settled = false;
            let response = '';
            let connection;
            const isCurrent = () => generation === debuggerGeneration;
            const timeout = setTimeout(() => fail('Debugger launch timed out'), 12000);
            function fail(message) {
                if (settled) return;
                settled = true;
                lastDebugError = message;
                clearTimeout(timeout);
                if (isCurrent()) {
                    debuggerGeneration++;
                    debuggerClient = null;
                    inDebug.tizenDebug = false;
                    inDebug.webDebug = false;
                }
                if (connection && connection._stream) connection._stream.end();
                reject(new Error(message));
            }
            const lifecycle = {
                isCurrent,
                onAttach(client) {
                    if (!isCurrent() || settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    debuggerClient = client;
                    debugLaunchPromise = null;
                    resolve({ mode: 'debug' });
                },
                onDisconnect() {
                    if (!isCurrent()) return;
                    debuggerClient = null;
                    debuggerGeneration++;
                },
                onFailure() { fail('Debugger attachment failed'); }
            };
            try {
                connection = adbClient = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });
                connection._stream.on('connect', () => {
                    if (!isCurrent() || settled) return;
                    const tbPackageId = tizen.application.getAppInfo().packageId;
                    debugLaunches++;
                    const shellCmd = connection.createStream(`shell:0 debug ${tbPackageId}.TizenBrewStandalone${isTizen3 ? ' 0' : ''}`);
                    function consumeResponse(final) {
                        if (!isCurrent() || startedDebugger) return;
                        const match = /\b(?:port|debug)\s*:\s*(\d+)(?=[\s,;\x00])/i.exec(response) ||
                            (final && /\b(?:port|debug)\s*:\s*(\d+)$/i.exec(response));
                        if (!match) return;
                        const port = Number(match[1]);
                        if (port < 1 || port > 65535) return fail('Invalid debugger port');
                        lastDebugPort = port;
                        startedDebugger = true;
                        startDebugging(port, queuedEvents, services, ip, mdl, inDebug, appControlData, false, 1, lifecycle);
                        setTimeout(() => connection._stream.end(), 1000);
                    }
                    shellCmd.on('data', data => {
                        response = (response + data.toString()).slice(-8192);
                        if (isCurrent()) lastSdbResponse = response.slice(-512);
                        consumeResponse(false);
                    });
                    shellCmd.on('error', () => fail('Debugger command failed'));
                    function finishResponse() { consumeResponse(true); if (!startedDebugger) fail('Debugger port missing'); }
                    // adbhost handles SDB CLSE with Duplex.end(), which emits writable finish.
                    shellCmd.on('finish', finishResponse);
                    shellCmd.on('end', finishResponse);
                });
                connection._stream.on('error', () => fail('ADB connection failed'));
                connection._stream.on('close', () => { if (!startedDebugger) fail('ADB connection closed'); });
            } catch (error) { fail('ADB connection failed'); }
        });
        debugLaunchPromise = pending;
        const clearPending = () => { if (debugLaunchPromise === pending) debugLaunchPromise = null; };
        pending.then(clearPending, clearPending);
        return pending;
    }

    function withTimeout(promise, milliseconds) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const error = new Error('Operation timed out');
                error.code = 'PROBE_TIMEOUT';
                reject(error);
            }, milliseconds);
            Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
        });
    }

    function matchesAutolaunchTarget(currentUrl) {
        const target = modulesCache && modulesCache.find(m => m.fullName === readConfig().autoLaunchModule);
        if (!target || !target.appPath) return false;
        const current = url.parse(currentUrl);
        const expected = url.parse(target.appPath);
        const host = value => value === 'www.youtube.com' ? 'youtube.com' : value;
        return host(current.hostname) === host(expected.hostname) && current.pathname === expected.pathname;
    }

    function launchFromRemote() {
        if (debugLaunchPromise) return debugLaunchPromise;
        const client = debuggerClient;
        const generation = debuggerGeneration;
        if (!client) return createAdbConnection('127.0.0.1', currentModule);
        let history;
        try { history = client.Page.getNavigationHistory(); } catch (error) { return createAdbConnection('127.0.0.1', currentModule); }
        return withTimeout(history, 1000).then(result => {
            if (client !== debuggerClient || generation !== debuggerGeneration) throw new Error('Debugger session changed');
            const entry = result.entries && result.entries[result.currentIndex];
            if (!entry || !matchesAutolaunchTarget(entry.url)) {
                const error = new Error('Active page differs from autolaunch target');
                error.code = 'ACTIVE_PAGE';
                throw error;
            }
            return new Promise((resolve, reject) => {
                let settled = false;
                const timeout = setTimeout(() => finish(new Error('Native resume request timed out')), 3000);
                function finish(error) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    if (client !== debuggerClient || generation !== debuggerGeneration) return reject(new Error('Debugger session changed'));
                    if (error) return reject(error);
                    resolve({ mode: 'resume' });
                }
                try {
                    const appId = tizen.application.getAppInfo().packageId + '.TizenBrewStandalone';
                    // Match the manifest's reload-disabled resume operation.
                    const control = new tizen.ApplicationControl('http://samsung.com/appcontrol/operation/eden_resume');
                    resumeRequests++;
                    tizen.application.launchAppControl(control, appId, () => finish(),
                        () => finish(new Error('Native resume request failed')));
                } catch (error) { finish(new Error('Native resume request failed')); }
            });
        }, error => {
            if (client !== debuggerClient || generation !== debuggerGeneration) throw new Error('Debugger session changed');
            if (error.code === 'PROBE_TIMEOUT') throw error;
            return createAdbConnection('127.0.0.1', currentModule);
        });
    }

    startRemoteLauncher(readConfig().remoteLauncher, {
        isReady: () => canLaunchInDebug === true && modulesCache !== null,
        isAttached: () => !!debuggerClient,
        getStatus: () => ({ debugLaunches, resumeRequests, lastSdbResponse, lastDebugError, lastDebugPort }),
        launch: launchFromRemote
    });


    wsServer.on('connection', (ws) => {
        const wsConn = new Connection(ws);
        ws.on('close', () => {
            wsConn.isReady = false;
            if (services.get('wsConn') === wsConn) services.delete('wsConn');
        });
        ws.on('message', (message) => {
            let msg;
            try {
                msg = JSON.parse(message)
            } catch (e) {
                return wsConn.send(wsConn.Event(Events.Error, `Invalid JSON: ${message}`));
            }

            const { type, payload } = msg;

            switch (type) {
                case Events.AppControlData: {
                    const moduleMetadata = [
                        payload.package.substring(0, payload.package.indexOf('/')),
                        payload.package.substring(payload.package.indexOf('/') + 1)
                    ];
                    const module = modulesCache.find(m => m.name === moduleMetadata[1]);

                    if (!module) {
                        return wsConn.send(wsConn.Event(Events.Error, 'App Control module not found.'));
                    }

                    appControlData.module = module;
                    appControlData.args = payload.args;

                    wsConn.send(wsConn.Event(Events.AppControlData, null));
                    break;
                }
                case Events.GetDebugStatus: {
                    wsConn.send(wsConn.Event(Events.GetDebugStatus, inDebug));
                    break;
                }
                case Events.CanLaunchInDebug: {
                    fetch('http://127.0.0.1:8001/api/v2/').then(res => res.json())
                        .then(json => {
                            canLaunchInDebug = (json.device.developerIP === '127.0.0.1' || json.device.developerIP === '1.0.0.127') && json.device.developerMode === '1';
                        });
                    wsConn.send(wsConn.Event(Events.CanLaunchInDebug, canLaunchInDebug));
                    break;
                }
                case Events.ReLaunchInDebug: {
                    setTimeout(() => {
                        createAdbConnection(payload.tvIP, currentModule).catch(() => {});
                    }, 1000);
                    break;
                }
                case Events.GetModules: {
                    if (payload) {
                        loadModules().then(modules => {
                            modulesCache = modules;
                            wsConn.send(wsConn.Event(Events.GetModules, modules));
                        });
                    } else wsConn.send(wsConn.Event(Events.GetModules, modulesCache));
                    break;
                }
                case Events.LaunchModule: {
                    const mdl = payload;
                    currentModule.fullName = mdl.fullName;
                    currentModule.name = mdl.name;
                    currentModule.appPath = mdl.appPath;
                    currentModule.moduleType = mdl.moduleType;
                    currentModule.packageType = mdl.packageType;
                    currentModule.serviceFile = mdl.serviceFile;

                    if (mdl.packageType === 'app') {
                        inDebug.webDebug = false;
                        inDebug.tizenDebug = false;
                    } else {
                        currentModule.mainFile = mdl.mainFile;
                        currentModule.tizenAppId = mdl.tizenAppId;
                        currentModule.evaluateScriptOnDocumentStart = mdl.evaluateScriptOnDocumentStart;
                    }

                    if (mdl.serviceFile) {
                        if (services.has(mdl.fullName)) {
                            if (services.get(mdl.fullName).hasCrashed) {
                                services.delete(mdl.fullName);
                                startService(mdl, services);
                            }
                        } else startService(mdl, services);
                    }
                    break;
                }
                case Events.StartService: {
                    const mdl = payload;
                    if (payload.serviceFile && services.has(mdl.fullName)) {
                        if (services.get(mdl.fullName).hasCrashed) {
                            services.delete(mdl.fullName);
                            startService(mdl, services);
                        }
                    } else startService(mdl, services);
                    break;
                }
                case Events.GetServiceStatuses: {
                    const serviceList = [];
                    for (const map of services) {
                        serviceList.push({
                            name: map[0],
                            hasCrashed: map[1].hasCrashed,
                            error: map[1].error
                        });
                    }
                    wsConn.send(wsConn.Event(Events.GetServiceStatuses, serviceList));
                    break;
                }
                case Events.ModuleAction: {
                    const { action, module } = payload;

                    const config = readConfig();
                    switch (action) {
                        case 'add': {
                            const index = config.modules.findIndex(m => m === module);
                            if (index === -1) {
                                config.modules.push(module);
                                writeConfig(config);
                            }
                            break;
                        }
                        case 'remove': {
                            const index = config.modules.findIndex(m => m === module);
                            if (index !== -1) {
                                config.modules.splice(index, 1);
                                writeConfig(config);
                            }
                            break;
                        }
                        case 'autolaunch': {
                            config.autoLaunchModule = module;
                            writeConfig(config);
                            break;
                        }
                        case 'autolaunchService': {
                            config.autoLaunchServiceList = module;
                            writeConfig(config);
                            break;
                        }
                    }
                    break;
                }
                case Events.Ready: {
                    wsConn.isReady = true;
                    services.set('wsConn', wsConn);
                    while (queuedEvents.length > 0) {
                        wsConn.send(queuedEvents.shift());
                    }
                    sendLaunchInformation(services, inDebug, appControlData);
                    break;
                }
                default: {
                    wsConn.send(wsConn.Event(Events.Error, 'Invalid event type.'));
                    break;
                }
            }
        });
    });
}
