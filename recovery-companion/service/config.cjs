'use strict';

function copyRemoteConfig(config, options) {
    if (config.tvRemoteToken !== undefined) {
        if (typeof config.tvRemoteToken !== 'string' || !config.tvRemoteToken.trim() || config.tvRemoteToken.length > 1024) {
            throw new Error('Invalid optional remote configuration');
        }
        options.tvRemoteToken = config.tvRemoteToken;
    }
    if (config.tvRemoteName !== undefined) {
        if (typeof config.tvRemoteName !== 'string' || !config.tvRemoteName.trim() || Buffer.byteLength(config.tvRemoteName, 'utf8') > 64) {
            throw new Error('Invalid optional remote configuration');
        }
        options.tvRemoteName = config.tvRemoteName;
    }
    if (config.tvRemoteHost !== undefined) {
        if (typeof config.tvRemoteHost !== 'string' || config.tvRemoteHost.length > 15 ||
            !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(config.tvRemoteHost) ||
            !config.tvRemoteHost.split('.').every(function (octet) { return Number(octet) <= 255; })) {
            throw new Error('Invalid optional remote configuration');
        }
        options.tvRemoteHost = config.tvRemoteHost;
    }
    return options;
}

module.exports = { copyRemoteConfig: copyRemoteConfig };
