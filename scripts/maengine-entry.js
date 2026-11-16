/**
 * MAEngine entry point wrapper for unbundled ESM development builds.
 *
 * The packaged application distribution ships with an unbundled development build.
 * In this mode, CSS modules and dynamic import maps require VSCODE_DEV=1 to be recognized
 * by Electron's main process and renderer.
 *
 * Static ESM imports are hoisted and evaluated before any top-level statements run.
 * Therefore, this wrapper assigns the necessary environment variables FIRST and then
 * dynamically imports './main.js'.
 */

// Always '1': this build cannot run without it, even if a parent process set another value.
process.env.VSCODE_DEV = '1';

// Dev mode changes the default profile location. Pin it to the same folder that
// scripts/run-maengine.ps1 uses, so a direct MAEngine.exe launch (Start Menu, Explorer,
// file association) opens the same settings, extensions and recent projects.
if (!process.argv.some(arg => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))) {
	const appData = process.env.APPDATA || `${process.env.USERPROFILE}\\AppData\\Roaming`;
	process.argv.push(`--user-data-dir=${appData}\\MAEngine`);
}

if (!process.env.NODE_ENV) {
	process.env.NODE_ENV = 'development';
}

if (!process.env.VSCODE_SKIP_PRELAUNCH) {
	process.env.VSCODE_SKIP_PRELAUNCH = '1';
}

await import('./main.js');
