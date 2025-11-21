#!/usr/bin/env node
/**
 * Simple build step that performs a syntax check over all project JavaScript
 * files to catch issues early. This intentionally keeps the server-only
 * project free from bundlers while still providing a meaningful "build" phase.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const targetDirs = [
  path.join(projectRoot, 'src'),
  path.join(projectRoot, 'public', 'js'),
  path.join(projectRoot, 'scripts')
];

const jsFiles = [];

function collectJsFiles(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      jsFiles.push(fullPath);
    }
  });
}

targetDirs.forEach(collectJsFiles);

if (jsFiles.length === 0) {
  console.log('No JavaScript files found to check. Build skipped.');
  process.exit(0);
}

let failed = false;

console.log(`Running syntax checks on ${jsFiles.length} JavaScript files...\n`);

jsFiles.forEach(file => {
  const relative = path.relative(projectRoot, file);
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed = true;
    console.error(`Syntax check failed for ${relative}`);
  } else {
    console.log(`✓ ${relative}`);
  }
});

if (failed) {
  console.error('\nBuild failed due to syntax errors.');
  process.exit(1);
}

console.log('\nBuild completed successfully. All files passed syntax checks.');

