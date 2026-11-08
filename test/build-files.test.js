'use strict';

// The Homey CLI the build tests read their rules from (test/helpers/
// build-files.js, homeyCli): the `homey` on the PATH, past the one in the
// app's own node_modules (a devDependency that `npm test` puts first on the
// PATH), and ignore-walk where that CLI finds it, in its own node_modules or
// hoisted above. Made-up folders in a temporary directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { homeyCli } = require('./helpers/build-files');

// A homey package at dir, with its command in bin/.
function homeyAt(dir) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'homey', version: '0.0.0-made-up' }));
  const command = path.join(dir, 'bin', 'homey.js');
  fs.writeFileSync(command, '');
  return command;
}

test('the homey in the app\'s own node_modules is passed over for the CLI after it on the PATH', (context) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'build-files-')));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = path.join(root, 'app', 'node_modules');
  const ownCommand = homeyAt(path.join(own, 'homey'));
  const cliCommand = homeyAt(path.join(root, 'global', 'lib', 'node_modules', 'homey'));
  assert.equal(homeyCli({ commands: [ownCommand, cliCommand], own }), path.join(root, 'global', 'lib', 'node_modules', 'homey'));
  assert.equal(homeyCli({ commands: [ownCommand], own }), null, 'only the app\'s own: none');
  assert.equal(homeyCli({ commands: [cliCommand], own }), path.join(root, 'global', 'lib', 'node_modules', 'homey'));
  assert.equal(homeyCli({ commands: [path.join(root, 'nowhere', 'homey'), cliCommand], own }),
    path.join(root, 'global', 'lib', 'node_modules', 'homey'), 'a command that leads nowhere is passed over');
});

test('ignore-walk is found where the CLI finds it, also hoisted above its own node_modules', (context) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'build-files-')));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'node_modules', 'homey');
  homeyAt(cli);
  const hoisted = path.join(root, 'node_modules', 'ignore-walk');
  fs.mkdirSync(hoisted, { recursive: true });
  fs.writeFileSync(path.join(hoisted, 'package.json'), JSON.stringify({ name: 'ignore-walk', main: 'index.js' }));
  fs.writeFileSync(path.join(hoisted, 'index.js'), 'module.exports = { madeUp: true };');
  assert.equal(require.resolve('ignore-walk', { paths: [cli] }), path.join(hoisted, 'index.js'));
  const source = fs.readFileSync(path.join(__dirname, 'helpers', 'build-files.js'), 'utf8');
  assert.ok(source.includes("require(require.resolve('ignore-walk', { paths: [cli] }))"));
  assert.doesNotMatch(source, /path\.join\(cli, 'node_modules', 'ignore-walk'\)/);
});
