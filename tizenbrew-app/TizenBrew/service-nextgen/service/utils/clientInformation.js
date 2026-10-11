"use strict";

const { Events } = require('./wsCommunication.js');
const { readConfig } = require('./configuration.js');

function getReadyClient(services) {
    const client = services.get('wsConn');
    // OPEN has the same value in both supported WebSocket implementations.
    if (!client || !client.connection || client.connection.readyState !== 1 || !client.isReady) {
        return null;
    }
    return client;
}

function sendClientInformation(services, data) {
    const client = getReadyClient(services);
    if (!client) {
        return setTimeout(() => sendClientInformation(services, data), 50);
    }
    client.send(data);
}

function sendLaunchInformation(services, inDebug, appControlData) {
    const client = getReadyClient(services);
    if (!client || !inDebug.webDebug || client.launchInformationSent) return;

    let payload = null;
    if (appControlData.module) {
        payload = {
            type: 'appControl',
            module: appControlData.module,
            args: appControlData.args
        };
    } else {
        const config = readConfig();
        if (config.autoLaunchModule) {
            payload = {
                type: 'autolaunch',
                module: config.autoLaunchModule
            };
        }
    }

    client.send(client.Event(Events.CanLaunchModules, payload));
    client.launchInformationSent = true;
    appControlData.module = null;
    appControlData.args = null;
}

module.exports = {
    sendClientInformation,
    sendLaunchInformation
};
