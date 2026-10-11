"use strict";

const CDP = require('chrome-remote-interface');
const fetch = require('node-fetch');
const { Events } = require('./wsCommunication.js');
const { sendClientInformation, sendLaunchInformation } = require('./clientInformation.js');

const modulesCache = new Map();

function startDebugging(port, queuedEvents, clientConn, ip, mdl, inDebug, appControlData, isAnotherApp, attempts) {
    if (!attempts) attempts = 1;
    if (!isAnotherApp) inDebug.tizenDebug = true;
    try {
        CDP({ port, host: ip, local: true }, (client) => {
            client.Runtime.enable();
            client.Debugger.enable();

            client.on('Runtime.executionContextCreated', (msg) => {
                if (!mdl.evaluateScriptOnDocumentStart && mdl.name !== '') {
                    const cache = modulesCache.get(mdl.fullName);
                    if (cache) {
                        client.Runtime.evaluate({ expression: cache, contextId: msg.context.id });
                    } else {
                        fetch(`https://cdn.jsdelivr.net/${mdl.fullName}/${mdl.mainFile}`).then(res => res.text()).then(modFile => {
                            modulesCache.set(mdl.fullName, modFile);
                            client.Runtime.evaluate({ expression: modFile, contextId: msg.context.id });
                        }).catch(e => {
                            client.Runtime.evaluate({ expression: `alert("Failed to load module: '${mdl.fullName}'. Please relaunch TizenBrew to try again.")`, contextId: msg.context.id });
                        });
                    }
                } else if (mdl.name !== '' && mdl.evaluateScriptOnDocumentStart) {
                    const cache = modulesCache.get(mdl.fullName);
                    if (cache) {
                        client.Page.addScriptToEvaluateOnNewDocument({ expression: cache }).then(() => {
                            sendClientInformation(clientConn, { type: Events.LaunchModule, payload: mdl.fullName });
                        });
                    } else {
                        fetch(`https://cdn.jsdelivr.net/${mdl.fullName}/${mdl.mainFile}`).then(res => res.text()).then(modFile => {
                            modulesCache.set(mdl.fullName, modFile);
                            return client.Page.addScriptToEvaluateOnNewDocument({ expression: modFile }).then(() => {
                                sendClientInformation(clientConn, { type: Events.LaunchModule, payload: mdl.fullName });
                            });
                        }).catch(e => {
                            return client.Page.addScriptToEvaluateOnNewDocument({ expression: `alert("Failed to load module: '${mdl.fullName}'. Please relaunch TizenBrew to try again.")` }).then(() => {
                                sendClientInformation(clientConn, { type: Events.LaunchModule, payload: mdl.fullName });
                            });
                        });
                    }
                }
            });

            client.on('disconnect', () => {
                if (isAnotherApp) return;

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
            });

            if (!isAnotherApp) {
                inDebug.webDebug = true;
                sendLaunchInformation(clientConn, inDebug, appControlData);
            }
        }).on('error', (err) => {
            if (attempts >= 15) {
                if (!isAnotherApp) {
                    sendClientInformation(clientConn, { type: Events.Error, payload: 'Failed to connect to the debugger' });
                    inDebug.tizenDebug = false;
                    return;
                } else return;
            }
            attempts++;
            setTimeout(() => startDebugging(port, queuedEvents, clientConn, ip, mdl, inDebug, appControlData, isAnotherApp, attempts), 750)
        });
    } catch (e) {
        if (attempts >= 15) {
            if (!isAnotherApp) {
                sendClientInformation(clientConn, { type: Events.Error, payload: 'Failed to connect to the debugger' });
                inDebug.tizenDebug = false;
                return;
            } else return;
        }
        attempts++;
        setTimeout(() => startDebugging(port, queuedEvents, clientConn, ip, mdl, inDebug, appControlData, isAnotherApp, attempts), 750)
        return;
    }
}

module.exports = startDebugging;
