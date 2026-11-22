/* Build a Debian .amd64.deb for Nook without needing dpkg-deb installed. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const binary = path.join(root, 'nook-linux-x64');
const icon = path.join(root, 'public', 'assets', 'nook-icon.png');
const out = path.join(root, 'nook_2.0.0_amd64.deb');

if (!fs.existsSync(binary)) {
  console.error('Run `npm run build:linux` first.');
  process.exit(1);
}

function tarHeader(name, size, mode) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write((mode.toString(8).padStart(7, '0') + '\0'), 100, 8);
  h.write(('0'.padStart(7, '0') + '\0'), 108, 8);
  h.write(('0'.padStart(7, '0') + '\0'), 116, 8);
  h.write((size.toString(8).padStart(11, '0') + '\0'), 124, 12);
  h.write((Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0'), 136, 12);
  h.fill(0x20, 148, 156);
  h.write('0', 156, 1);
  h.write('ustar\0', 257, 6);
  h.write('00', 263, 2);
  h.write('root'.padEnd(32, '\0'), 265, 32);
  h.write('root'.padEnd(32, '\0'), 297, 32);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function createTar(files) {
  const parts = [];
  for (const f of files) {
    parts.push(tarHeader(f.name, f.data.length, f.mode || 0o644));
    parts.push(f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function arMember(name, data) {
  const h = Buffer.alloc(60);
  h.write((name + '/').padEnd(16, ' '), 0, 16);
  h.write(String(Math.floor(Date.now() / 1000)).padEnd(12, ' '), 16, 12);
  h.write('0'.padEnd(6, ' '), 28, 6);
  h.write('0'.padEnd(6, ' '), 34, 6);
  h.write('100644'.padEnd(8, ' '), 40, 8);
  h.write(String(data.length).padEnd(10, ' '), 48, 10);
  h.write('`\n', 58, 2);
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([h, data, pad]);
}

const control = [
  'Package: nook',
  'Version: 2.0.0',
  'Section: net',
  'Priority: optional',
  'Architecture: amd64',
  'Maintainer: Abhi <noreply@localhost>',
  'Description: Self-hosted watch-together rooms with synchronized video and chat',
  ' Nook lets friends on the same network (or a VPN/tunnel) watch the same',
  ' video in sync and chat in real time, with host, admin and member roles.',
  '',
].join('\n');

const desktop = [
  '[Desktop Entry]',
  'Name=Nook',
  'Comment=Self-hosted watch-together and chat',
  'Exec=/usr/bin/nook',
  'Icon=nook',
  'Type=Application',
  'Terminal=true',
  'Categories=Network;Chat;Video;',
  '',
].join('\n');

const controlTar = zlib.gzipSync(createTar([{ name: './control', data: Buffer.from(control) }]));
const dataFiles = [
  { name: './usr/bin/nook', data: fs.readFileSync(binary), mode: 0o755 },
  { name: './usr/share/applications/nook.desktop', data: Buffer.from(desktop) },
];
if (fs.existsSync(icon)) dataFiles.push({ name: './usr/share/icons/hicolor/64x64/apps/nook.png', data: fs.readFileSync(icon) });
const dataTar = zlib.gzipSync(createTar(dataFiles));

const deb = Buffer.concat([
  Buffer.from('!<arch>\n'),
  arMember('debian-binary', Buffer.from('2.0\n')),
  arMember('control.tar.gz', controlTar),
  arMember('data.tar.gz', dataTar),
]);
fs.writeFileSync(out, deb);
console.log(`Built ${out} (${(deb.length / 1024 / 1024).toFixed(1)} MB)`);
