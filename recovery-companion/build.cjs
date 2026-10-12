'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { copyRemoteConfig } = require('./service/config.cjs');

function readPrivateConfig(input) {
    if (!path.isAbsolute(input)) throw new Error('--config must name an absolute path');
    const resolved = fs.realpathSync(input);
    const relative = path.relative(path.resolve(__dirname, '..'), resolved);
    if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) {
        throw new Error('Keep private build configuration outside the repository');
    }
    const bytes = fs.readFileSync(resolved);
    if (bytes.length > 100000) throw new Error('Private configuration is too large');
    const config = JSON.parse(bytes.toString('utf8'));
    if (typeof config.publicKey !== 'string' || /PRIVATE KEY/.test(config.publicKey)) throw new Error('A public deployment verification key is required');
    const publicKey = crypto.createPublicKey(config.publicKey);
    if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 2048) throw new Error('Deployment verification requires RSA >= 2048 bits');
    const privateKey = crypto.createPrivateKey(config.tlsKey);
    const certificate = new crypto.X509Certificate(config.tlsCert);
    if (!certificate.checkPrivateKey(privateKey)) throw new Error('TLS certificate and server key do not match');
    if (config.port !== undefined && config.port !== 8098) throw new Error('The companion endpoint uses port 8098');
    return copyRemoteConfig(config, { publicKey: config.publicKey, tlsKey: config.tlsKey, tlsCert: config.tlsCert, port: 8098 });
}

// A deterministic PNG icon generated from a small original R glyph; no external artwork.
function makeIcon() {
    const width = 256;
    const scanlines = Buffer.alloc((width * 4 + 1) * width);
    const glyph = ['11110', '10001', '10001', '11110', '10100', '10010', '10001'];
    for (let y = 0; y < width; y++) {
        for (let x = 0; x < width; x++) {
            const gx = Math.floor((x - 58) / 28);
            const gy = Math.floor((y - 30) / 28);
            const lit = gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && glyph[gy][gx] === '1';
            const offset = y * (width * 4 + 1) + 1 + x * 4;
            scanlines[offset] = lit ? 237 : 23;
            scanlines[offset + 1] = lit ? 244 : 33;
            scanlines[offset + 2] = lit ? 247 : 43;
            scanlines[offset + 3] = 255;
        }
    }
    function chunk(type, data) {
        const name = Buffer.from(type);
        const content = Buffer.concat([name, data]);
        let crc = 0xffffffff;
        for (const byte of content) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
        const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([length, content, checksum]);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(width, 4); header[8] = 8; header[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

async function build(input) {
    const config = readPrivateConfig(input);
    const stage = path.join(__dirname, 'dist/package');
    if (fs.existsSync(stage)) {
        if (fs.realpathSync(stage) !== path.resolve(stage)) throw new Error('Unexpected staging path');
        for (const name of fs.readdirSync(stage)) {
            if (!['config.xml', 'index.html', 'bootstrap.js', 'icon.png', 'service'].includes(name)) throw new Error('Unexpected staging file');
            if (fs.lstatSync(path.join(stage, name)).isSymbolicLink()) throw new Error('Unexpected staging link');
        }
        const serviceDirectory = path.join(stage, 'service');
        if (fs.existsSync(serviceDirectory)) {
            for (const name of fs.readdirSync(serviceDirectory)) {
                if (!['index.js', 'recovery-config.json'].includes(name) || fs.lstatSync(path.join(serviceDirectory, name)).isSymbolicLink()) throw new Error('Unexpected service staging file');
            }
        }
    }
    const ncc = require('@vercel/ncc');
    const babel = require('@babel/core');
    const bundle = await ncc(path.join(__dirname, 'service/index.js'), { target: 'es2015', minify: false });
    if (Object.keys(bundle.assets).length) throw new Error('Unexpected bundle assets require explicit packaging review');
    const compatible = babel.transformSync(bundle.code, {
        babelrc: false, configFile: false, compact: true,
        plugins: [require('../build-support/adbhost-strict-fix.cjs')],
        presets: [['@babel/preset-env', { targets: { node: '4.4.3' }, forceAllTransforms: true }]]
    }).code;
    fs.mkdirSync(path.join(stage, 'service'), { recursive: true });
    if (fs.realpathSync(stage) !== path.resolve(stage)) throw new Error('Unexpected staging path');
    for (const file of ['config.xml', 'index.html', 'bootstrap.js']) fs.copyFileSync(path.join(__dirname, file), path.join(stage, file));
    fs.writeFileSync(path.join(stage, 'icon.png'), makeIcon());
    fs.writeFileSync(path.join(stage, 'service/index.js'), compatible);
    fs.writeFileSync(path.join(stage, 'service/recovery-config.json'), JSON.stringify(config), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ packageDirectory: stage, packageId: 'TbRecov001', appId: 'TbRecov001.RecoveryCompanion', serviceId: 'TbRecov001.RecoveryService' }) + '\n');
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--config') {
        process.stderr.write('Usage: node build.cjs --config ABSOLUTE_PRIVATE_JSON\n'); process.exitCode = 1;
    } else build(args[1]).catch(() => { process.stderr.write('Companion build failed; verify dependencies, service source, and private configuration.\n'); process.exitCode = 1; });
}

module.exports = { readPrivateConfig, makeIcon };
