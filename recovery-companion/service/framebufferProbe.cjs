'use strict';

// Fixed read-only diagnostics, compatible with Node 4. Never read framebuffer pixels.
var nativeFs = require('fs');
var constants = require('constants');
var KNOWN_ERRORS = ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EIO', 'EINVAL',
  'ENXIO', 'ENODEV', 'EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'ELOOP', 'ENOSYS'];

function errorCode(error) {
  return error && KNOWN_ERRORS.indexOf(error.code) !== -1 ? error.code : 'ERROR';
}

function probe(filesystem) {
  var disk = filesystem || nativeFs;
  function metadata(name, valid) {
    var descriptor;
    var result = { value: null, error: null };
    try {
      descriptor = disk.openSync('/sys/class/graphics/fb0/' + name, 'r');
      var buffer = new Buffer(128);
      var count = disk.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (typeof count !== 'number' || count < 0 || count > buffer.length || count % 1) throw new Error('Invalid metadata read');
      var value = buffer.toString('utf8', 0, count).trim();
      if (!valid(value)) result.error = 'INVALID_METADATA';
      else result.value = value;
    } catch (error) { result.error = errorCode(error); }
    finally {
      if (descriptor !== undefined) {
        try { disk.closeSync(descriptor); }
        catch (closeError) { result.value = null; result.error = errorCode(closeError); }
      }
    }
    return result;
  }
  var result = {
    scope: 'filesystem-access-only', pixelReadAttempted: false,
    virtualSize: metadata('virtual_size', function (value) {
      if (!/^[1-9][0-9]{0,4},[1-9][0-9]{0,4}$/.test(value)) return false;
      var dimensions = value.split(',');
      return Number(dimensions[0]) <= 32768 && Number(dimensions[1]) <= 32768;
    }),
    bitsPerPixel: metadata('bits_per_pixel', function (value) { return /^[1-9][0-9]{0,2}$/.test(value) && Number(value) <= 128; }),
    stride: metadata('stride', function (value) { return /^[1-9][0-9]{0,6}$/.test(value) && Number(value) <= 1048576; }),
    device: { kind: 'unavailable', statError: null, openedReadOnly: false, openError: null }
  };
  try {
    result.device.kind = disk.statSync('/dev/fb0').isCharacterDevice() ? 'character-device' : 'other';
  } catch (statError) { result.device.statError = errorCode(statError); }
  // O_NONBLOCK avoids waiting in a device open. O_RDONLY is zero: no write access.
  var descriptor;
  try {
    descriptor = disk.openSync('/dev/fb0', constants.O_RDONLY | constants.O_NONBLOCK);
    result.device.openedReadOnly = true;
  } catch (openError) { result.device.openError = errorCode(openError); }
  finally {
    if (descriptor !== undefined) {
      try { disk.closeSync(descriptor); }
      catch (closeError) { result.device.openedReadOnly = false; result.device.openError = errorCode(closeError); }
    }
  }
  return result;
}

module.exports = { probe: probe };
