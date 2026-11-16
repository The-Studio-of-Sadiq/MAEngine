const fs = require('fs');
const path = require('path');
const repoRoot = path.resolve(__dirname, '..');
const ts = require(path.join(repoRoot, 'workbench', 'node_modules', 'typescript'));
const srcDir = path.join(repoRoot, 'workbench', 'src');
const outDirs = [
  path.join(repoRoot, 'workbench', 'out'),
  path.join(repoRoot, 'VSCode-win32-x64', 'resources', 'app', 'out')
];

const compilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2024,
  experimentalDecorators: true,
  useDefineForClassFields: false,
};

function getAllFiles(dir, filter) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(fullPath, filter));
    } else if (filter(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function compileFile(srcFile) {
  const relPath = path.relative(srcDir, srcFile);
  const outRelPath = relPath.replace(/\.ts$/, '.js');
  
  const sourceCode = fs.readFileSync(srcFile, 'utf8');
  const transpileResult = ts.transpileModule(sourceCode, { compilerOptions });

  for (const outDir of outDirs) {
    if (!fs.existsSync(outDir)) continue;
    const destFile = path.join(outDir, outRelPath);
    const destDir = path.dirname(destFile);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.writeFileSync(destFile, transpileResult.outputText, 'utf8');
  }
  console.log(`Compiled: ${relPath}`);
}

// Find all maengine files
const filesToCompile = [
  ...getAllFiles(path.join(srcDir, 'vs', 'workbench', 'contrib'), f => f.includes('maengine') && f.endsWith('.ts')),
  ...getAllFiles(path.join(srcDir, 'vs', 'workbench', 'services'), f => f.includes('maengine') && f.endsWith('.ts')),
  path.join(srcDir, 'vs', 'workbench', 'browser', 'parts', 'editor', 'editorGroupWatermark.ts')
];

console.log(`Found ${filesToCompile.length} files to compile...`);
for (const file of filesToCompile) {
  compileFile(file);
}
console.log('Done compiling MAEngine modules!');

