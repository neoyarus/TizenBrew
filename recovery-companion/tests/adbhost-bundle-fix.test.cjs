'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const babel = require('@babel/core');
const fix = require('../../build-support/adbhost-strict-fix.cjs');

test('bundled adbhost packet remains local to each strict-mode callback and global strict is preserved', () => {
  const source = 'var Client=function(){};Client.prototype._onPacket=function(){packet=this._packet;return packet.command;};module.exports=Client;';
  const result = babel.transformSync(source, { configFile: false, babelrc: false, plugins: [fix], presets: [['@babel/preset-env', { targets: { node: '4.4.3' }, forceAllTransforms: true }]] }).code;
  assert.ok(result.startsWith('"use strict"'));
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(result, sandbox);
  const first = new sandbox.module.exports(), second = new sandbox.module.exports();
  first._packet = { command: 'CNXN' }; second._packet = { command: 'WRTE' };
  assert.equal(first._onPacket(), 'CNXN'); assert.equal(second._onPacket(), 'WRTE');
  assert.equal(Object.hasOwn(sandbox, 'packet'), false);
});

test('dependency shape mismatch and duplicated bundles fail rather than applying an unchecked patch', () => {
  const transform = source => babel.transformSync(source, { babelrc: false, configFile: false, plugins: [fix] });
  assert.throws(() => transform('Client.prototype._onPacket=function(){var packet=this._packet;}'), /exactly one/);
  assert.throws(() => transform('packet=this._packet;'), /exactly one/);
  const candidate = 'Client.prototype._onPacket=function(){packet=this._packet;};';
  assert.throws(() => transform(candidate + candidate), /exactly one/);
});
