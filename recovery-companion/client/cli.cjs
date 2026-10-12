#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { createClient } = require('./client.cjs');

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--config' || !args[1] || !['start', 'status', 'install', 'tunnel'].includes(args[2])) {
    throw new Error('Usage: node client/cli.cjs --config ABSFILE start | status | install ABSWGT | tunnel [LOCALPORT]');
  }
  const client = createClient(JSON.parse(fs.readFileSync(args[1], 'utf8')));
  if (args[2] === 'tunnel') {
    const tunnel = await client.tunnel(args[3] === undefined ? 26102 : Number(args[3]));
    console.log('SDB tunnel ready at 127.0.0.1:' + tunnel.port + '; run: sdb connect 127.0.0.1:' + tunnel.port);
    console.log('Each connection expires after five minutes; press Ctrl+C to close.');
    process.once('SIGINT', () => { tunnel.close(); client.close(); });
    process.once('SIGTERM', () => { tunnel.close(); client.close(); });
  } else {
    try { console.log(JSON.stringify(args[2] === 'start' ? await client.start() : args[2] === 'status' ? await client.status() : await client.install(args[3]), null, 2)); }
    finally { client.close(); }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
