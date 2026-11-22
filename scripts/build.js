/* Build the portable Nook exe with its custom icon.
 *
 * pkg stamps the default Node icon on the final exe, so the icon must be set
 * on the base binary before packaging. pkg uses a "built" base binary from its
 * cache when the "fetched" copy is absent, so we temporarily move that aside.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const rcedit = require('rcedit');

const root = path.join(__dirname, '..');
const cache = path.join(process.env.PKG_CACHE_PATH || path.join(os.homedir(), '.pkg-cache'), 'v3.4');
const fetched = path.join(cache, 'fetched-v18.5.0-win-x64');
const fetchedBackup = fetched + '.nook-backup';
const built = path.join(cache, 'built-v18.5.0-win-x64');
const icon = path.join(root, 'public', 'assets', 'nook.ico');

function packageApp() {
  execFileSync('npx', ['--yes', 'pkg@5.8.1', '.', '--output', 'nook.exe', '--targets', 'node18-win-x64'], {
    cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
  });
}

async function main() {
  // First build on a new machine: let pkg fetch the base binary once.
  if (!fs.existsSync(fetched) && !fs.existsSync(fetchedBackup)) packageApp();
  if (fs.existsSync(fetched)) fs.renameSync(fetched, fetchedBackup);

  try {
    fs.copyFileSync(fs.existsSync(fetchedBackup) ? fetchedBackup : fetched, built);
    await rcedit(built, { icon });
    packageApp();
  } finally {
    if (fs.existsSync(fetchedBackup)) fs.renameSync(fetchedBackup, fetched);
  }
  console.log('Done: nook.exe');
}

main().catch((err) => { console.error(err); process.exit(1); });
