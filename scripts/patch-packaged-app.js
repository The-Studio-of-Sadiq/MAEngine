const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const sourceEntry = path.join(repoRoot, 'scripts', 'maengine-entry.js');
const targetAppDir = path.join(repoRoot, 'VSCode-win32-x64', 'resources', 'app');
const targetOutDir = path.join(targetAppDir, 'out');
const targetEntry = path.join(targetOutDir, 'maengine-entry.js');
const packageJsonPath = path.join(targetAppDir, 'package.json');
const packageJsonOrigPath = path.join(targetAppDir, 'package.json.orig');

function main() {
  console.log('Patching packaged MAEngine application...');

  if (!fs.existsSync(sourceEntry)) {
    throw new Error(`Source entry file not found at: ${sourceEntry}`);
  }

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Packaged app package.json not found at: ${packageJsonPath}`);
  }

  // 1. Ensure target out directory exists and copy maengine-entry.js
  if (!fs.existsSync(targetOutDir)) {
    fs.mkdirSync(targetOutDir, { recursive: true });
  }

  fs.copyFileSync(sourceEntry, targetEntry);
  console.log(`[OK] Copied wrapper entry to: ${targetEntry}`);

  // 2. Back up original package.json once if no backup exists
  if (!fs.existsSync(packageJsonOrigPath)) {
    fs.copyFileSync(packageJsonPath, packageJsonOrigPath);
    console.log(`[OK] Backed up original package.json to: ${packageJsonOrigPath}`);
  } else {
    console.log(`[INFO] Original backup already exists: ${packageJsonOrigPath}`);
  }

  // 3. Read package.json and detect formatting
  const raw = fs.readFileSync(packageJsonPath, 'utf8');

  // Detect indentation style (tabs vs spaces, count)
  const indentMatch = raw.match(/^[ \t]+(?=")/m);
  const indent = indentMatch ? indentMatch[0] : 2;

  // Detect line ending style
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';

  // Detect trailing newline
  const hasTrailingNewline = raw.endsWith('\n');

  const pkg = JSON.parse(raw);

  const desiredMain = './out/maengine-entry.js';
  if (pkg.main === desiredMain) {
    console.log(`[INFO] package.json "main" is already set to "${desiredMain}"`);
  } else {
    const previousMain = pkg.main;
    pkg.main = desiredMain;

    let formatted = JSON.stringify(pkg, null, indent);
    if (eol !== '\n') {
      formatted = formatted.replace(/\n/g, eol);
    }
    if (hasTrailingNewline) {
      formatted += eol;
    }

    fs.writeFileSync(packageJsonPath, formatted, 'utf8');
    console.log(`[OK] Updated package.json "main": "${previousMain}" -> "${desiredMain}"`);
  }

  console.log('Packaged app patch complete.');
}

main();
