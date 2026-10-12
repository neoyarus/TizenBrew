'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../bootstrap.js'), 'utf8');

function harness(options = {}) {
    const status = { textContent: 'Starting' };
    const button = { focus() {} };
    const launches = [];
    const timers = new Map();
    let next = 0;
    let keydown;
    let visibilitychange;
    let hidden = 0;
    const context = {
        document: {
            hidden: false,
            getElementById(id) { return id === 'status' ? status : button; },
            addEventListener(name, callback) {
                if (name === 'keydown') keydown = callback;
                if (name === 'visibilitychange') visibilitychange = callback;
            }
        },
        setTimeout(callback) { timers.set(++next, callback); return next; },
        clearTimeout(id) { timers.delete(id); },
        tizen: {
            ApplicationControl: function (operation) { this.operation = operation; },
            application: {
                getCurrentApplication() { return { appInfo: { packageId: 'TbRecov001' }, hide() { hidden++; } }; },
                launchAppControl(control, id, success, failure) {
                    if (options.throwLaunch) throw new Error('Unavailable');
                    launches.push({ control, id, success, failure });
                }
            }
        }
    };
    vm.runInNewContext(source, context);
    return { status, button, launches, timers, get hidden() { return hidden; },
        deadline() { for (const callback of [...timers.values()]) callback(); },
        visibility(hidden) { context.document.hidden = hidden; visibilitychange(); },
        key(code) { let prevented = false; keydown({ keyCode: code, preventDefault() { prevented = true; } }); return prevented; }
    };
}

test('ordinary app startup requests only its own service without a debugger or network prerequisite', () => {
    const h = harness();
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].id, 'TbRecov001.RecoveryService');
    assert.equal(h.launches[0].control.operation, 'http://tizen.org/appcontrol/operation/service');
    h.launches[0].success();
    assert.match(h.status.textContent, /Service launch requested/);
    assert.match(h.status.textContent, /Verify recovery readiness/);
    assert.equal(h.timers.size, 0);
    assert.equal(h.hidden, 0, 'acknowledgment does not pretend the service is listening or hide an error');
});

test('foregrounding an existing hidden companion requests its service again and ignores stale acknowledgments', () => {
    const h = harness();
    h.visibility(false);
    assert.equal(h.launches.length, 1, 'an initial visible event must not duplicate startup');
    h.visibility(true);
    h.visibility(false);
    assert.equal(h.launches.length, 2, 'ordinary foreground resume must recover a stopped service');
    h.launches[0].success();
    assert.equal(h.status.textContent, 'Starting the recovery service…');
    assert.equal(h.timers.size, 1, 'stale acknowledgment cannot cancel the current deadline');
    h.launches[1].failure();
    assert.match(h.status.textContent, /Unable to start/);
});

test('a late launch acknowledgment cannot overwrite a bounded startup failure', () => {
    const h = harness();
    h.deadline();
    const failure = h.status.textContent;
    assert.match(failure, /could not be confirmed/);
    h.launches[0].success();
    assert.equal(h.status.textContent, failure);
});

test('launch errors remain visible and clear the deadline', () => {
    const h = harness();
    h.launches[0].failure(new Error('Device-specific failure'));
    assert.match(h.status.textContent, /Unable to start/);
    assert.equal(h.timers.size, 0);
    const thrown = harness({ throwLaunch: true });
    assert.match(thrown.status.textContent, /Unable to start/);
    assert.equal(thrown.timers.size, 0);
});

test('Return and Back hide the companion UI without terminating its service', () => {
    const h = harness();
    h.button.onclick();
    assert.equal(h.hidden, 1);
    assert.equal(h.key(10009), true);
    assert.equal(h.hidden, 2);
    assert.equal(h.key(13), false);
    assert.equal(h.hidden, 2);
});

test('manifest uses independent ten-character package identity and same-package service', () => {
    const manifest = fs.readFileSync(path.join(__dirname, '../config.xml'), 'utf8');
    const packageId = /<tizen:application[^>]*package="([^"]+)"/.exec(manifest)[1];
    assert.match(packageId, /^[A-Za-z0-9]{10}$/);
    assert.equal(packageId, 'TbRecov001');
    assert.doesNotMatch(manifest, /xvvl3S1bvH/);
    assert.match(manifest, /<tizen:service id="TbRecov001\.RecoveryService"/);
    assert.doesNotMatch(manifest, /boot|auto-restart|prelaunch/);
});
