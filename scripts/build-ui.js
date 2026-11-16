// Rebuilds the MAEngine workbench UI and installs it into the packaged app.
//   node scripts/build-ui.js            transpile + deploy (about 40 s)
//   node scripts/build-ui.js --check    also type-check (slower; catches errors transpile ignores)
//
// 1. `npm run transpile-client` turns workbench/src into workbench/out (TS -> JS, CSS copied).
// 2. workbench/out is copied over VSCode-win32-x64/resources/app/out (no deletions).
// 3. scripts/patch-packaged-app.js re-installs the dev-mode entry wrapper.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const workbench = path.join(repo, 'workbench');
const src = path.join(workbench, 'out');
const dest = path.join(repo, 'VSCode-win32-x64', 'resources', 'app', 'out');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

if (process.argv.includes('--check')) {
	console.log('> type-check (npm run typecheck-client)');
	run('npm run typecheck-client', workbench);
}

console.log('> transpile (npm run transpile-client)');
run('npm run transpile-client', workbench);

console.log(`> deploy ${src} -> ${dest}`);
fs.cpSync(src, dest, { recursive: true, force: true });

console.log('> patch packaged entry');
run('node scripts/patch-packaged-app.js', repo);
console.log('UI build deployed. Restart MAEngine to see changes.');
