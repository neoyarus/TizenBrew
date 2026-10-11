"use strict";

const CDP = require('chrome-remote-interface');
const fetch = require('node-fetch');
const { Events } = require('./wsCommunication.js');
const { sendClientInformation, sendLaunchInformation } = require('./clientInformation.js');

const modulesCache = new Map();

function startDebugging(port, queuedEvents, clientConn, ip, mdl, inDebug, appControlData, isAnotherApp, attempts, lifecycle) {
    if (!attempts) attempts = 1;
    const isCurrent = lifecycle ? lifecycle.isCurrent : () => true;
    if (!isCurrent()) return;
    if (!isAnotherApp) inDebug.tizenDebug = true;
    let retryScheduled = false;
    function retry() {
        if (!isCurrent() || retryScheduled) return;
        retryScheduled = true;
        if (attempts >= 15) {
            if (!isAnotherApp) {
                sendClientInformation(clientConn, { type: Events.Error, payload: 'Failed to connect to the debugger' }, isCurrent);
                inDebug.tizenDebug = false;
                if (lifecycle) lifecycle.onFailure();
            }
            return;
        }
        setTimeout(() => startDebugging(port, queuedEvents, clientConn, ip, mdl, inDebug, appControlData,
            isAnotherApp, attempts + 1, lifecycle), 750);
    }
    try {
        CDP({ port, host: ip, local: true }, client => {
            if (!isCurrent()) {
                if (client.close) Promise.resolve(client.close()).catch(() => {});
                return;
            }
            client.Runtime.enable();
            client.Debugger.enable();

            client.on('Runtime.executionContextCreated', msg => {
                if (!isCurrent() || mdl.name === '') return;
                const module = Object.assign({}, mdl);
                const cached = modulesCache.get(module.fullName);
                function install(script) {
                    if (!isCurrent()) return;
                    if (!module.evaluateScriptOnDocumentStart) {
                        client.Runtime.evaluate({ expression: script, contextId: msg.context.id });
                        return;
                    }
                    return client.Page.addScriptToEvaluateOnNewDocument({ expression: script }).then(() => {
                        if (!isCurrent()) return;
                        sendClientInformation(clientConn, { type: Events.LaunchModule, payload: module.fullName }, isCurrent);
                    });
                }
                if (cached) {
                    Promise.resolve(install(cached)).catch(() => {});
                } else {
                    fetch('https://cdn.jsdelivr.net/' + module.fullName + '/' + module.mainFile).then(res => res.text()).then(script => {
                        if (!isCurrent()) return;
                        modulesCache.set(module.fullName, script);
                        return install(script);
                    }).catch(() => {
                        if (!isCurrent()) return;
                        const message = "Failed to load module: '" + module.fullName + "'. Please relaunch TizenBrew to try again.";
                        return install('alert(' + JSON.stringify(message) + ')');
                    }).catch(() => {});
                }
            });

            client.on('disconnect', () => {
                if (isAnotherApp || !isCurrent()) return;
                inDebug.tizenDebug = false;
                inDebug.webDebug = false;
                inDebug.rwiDebug = false;
                const clientConnection = clientConn.get('wsConn');
                if (clientConnection) clientConnection.launchInformationSent = false;
                mdl.fullName = '';
                mdl.name = '';
                mdl.appPath = '';
                mdl.moduleType = '';
                mdl.packageType = '';
                mdl.serviceFile = '';
                mdl.mainFile = '';
                if (lifecycle) lifecycle.onDisconnect();
            });

            if (!isAnotherApp) {
                inDebug.webDebug = true;
                if (lifecycle) lifecycle.onAttach(client);
                sendLaunchInformation(clientConn, inDebug, appControlData);
            }
        }).on('error', retry);
    } catch (error) { retry(); }
}

module.exports = startDebugging;
