'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const constants = require('constants');
const { probe } = require('../service/framebufferProbe.cjs');

function fixture(values, denied) {
  const calls = [], handles = new Map();
  let next = 0;
  const disk = {
    openSync(path, flags) {
      calls.push(['open', path, flags]);
      if (denied && denied[path]) throw Object.assign(new Error('Sensitive device exception'), { code: denied[path] });
      handles.set(next, path);
      return next++;
    },
    readSync(fd, buffer, offset, length, position) {
      const path = handles.get(fd);
      assert.notEqual(path, '/dev/fb0', 'framebuffer pixels must never be read');
      assert.equal(length, 128); assert.equal(position, 0);
      calls.push(['read', path, length]);
      return Buffer.from(values[path.split('/').pop()] || '').copy(buffer, offset, 0, length);
    },
    closeSync(fd) { calls.push(['close', handles.get(fd)]); handles.delete(fd); },
    statSync(path) { calls.push(['stat', path]); return { isCharacterDevice: () => true }; }
  };
  return { disk, calls, handles };
}

test('fixed metadata probe bounds reads and opens/closes device without pixel access', () => {
  const h = fixture({ virtual_size: '1920,1080\n', bits_per_pixel: '32\n', stride: '7680\n' });
  const result = probe(h.disk);
  assert.equal(result.virtualSize.value, '1920,1080');
  assert.equal(result.bitsPerPixel.value, '32');
  assert.equal(result.stride.value, '7680');
  assert.equal(result.device.kind, 'character-device');
  assert.equal(result.device.openedReadOnly, true);
  assert.equal(result.pixelReadAttempted, false);
  assert.equal(h.handles.size, 0);
  assert.deepEqual(h.calls.filter(c => c[0] === 'open').map(c => c[1]), [
    '/sys/class/graphics/fb0/virtual_size', '/sys/class/graphics/fb0/bits_per_pixel', '/sys/class/graphics/fb0/stride', '/dev/fb0'
  ]);
  assert.equal(h.calls.find(c => c[0] === 'open' && c[1] === '/dev/fb0')[2], constants.O_RDONLY | constants.O_NONBLOCK);
});

test('permissions and absence report only sanitized errno without private exception text', () => {
  const h = fixture({}, {
    '/sys/class/graphics/fb0/virtual_size': 'EACCES', '/sys/class/graphics/fb0/bits_per_pixel': 'ENOENT',
    '/sys/class/graphics/fb0/stride': 'SENSITIVE', '/dev/fb0': 'EPERM'
  });
  h.disk.statSync = () => { throw Object.assign(new Error('private stat data'), { code: 'EACCES' }); };
  const result = probe(h.disk);
  assert.equal(result.virtualSize.error, 'EACCES'); assert.equal(result.bitsPerPixel.error, 'ENOENT');
  assert.equal(result.stride.error, 'ERROR'); assert.equal(result.device.openError, 'EPERM');
  assert.equal(result.device.statError, 'EACCES'); assert.equal(result.device.openedReadOnly, false);
  assert.doesNotMatch(JSON.stringify(result), /Sensitive|SENSITIVE|private/);
  assert.equal(h.handles.size, 0);
});

test('malformed metadata cannot be returned and descriptors close on read failures', () => {
  const h = fixture({ virtual_size: '9999999999999999999999,42', bits_per_pixel: '32 secret', stride: '0' });
  const result = probe(h.disk);
  for (const field of ['virtualSize', 'bitsPerPixel', 'stride']) {
    assert.equal(result[field].value, null); assert.equal(result[field].error, 'INVALID_METADATA');
  }
  assert.equal(h.handles.size, 0);
  const fail = fixture({});
  fail.disk.readSync = () => { throw Object.assign(new Error('hidden'), { code: 'EIO' }); };
  const failed = probe(fail.disk);
  assert.equal(failed.virtualSize.error, 'EIO'); assert.equal(fail.handles.size, 0);
});
