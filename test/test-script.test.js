'use strict';

// npm test names each test folder on its own (node --test takes globs, not a
// whole tree). A new folder with tests that is not named there would be left
// out without anyone noticing, so this checks that every folder under test/
// with a *.test.js file has its glob in the script.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test;

function foldersWithTests(dir) {
  const found = [];
  const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name.endsWith('.test.js'))) found.push(dir);
  for (const entry of entries) {
    if (entry.isDirectory()) found.push(...foldersWithTests(`${dir}/${entry.name}`));
  }
  return found;
}

test('npm test runs every folder under test/ that has tests', () => {
  const globs = script.split(/\s+/).filter((word) => word.endsWith('*.test.js'));
  const missing = foldersWithTests('test').filter((dir) => !globs.includes(`${dir}/*.test.js`));
  assert.deepEqual(missing, []);
});

test('the folders with tests include the SIG Mesh and SG Smart 3.0 ones', () => {
  const folders = foldersWithTests('test');
  assert.ok(folders.includes('test/sigmesh'));
  assert.ok(folders.includes('test/sg3'));
});
