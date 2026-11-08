'use strict';

// The files a build of the app takes from the app folder: `homey app build`,
// `run`, `install` and `publish` all copy them the same way. Read with the
// Homey CLI's own walker and rules (lib/App.js, _getAppSourceFiles), from the
// CLI that `homey` on the PATH runs: not the homey in the app's own
// node_modules (a devDependency, first on the PATH under `npm test`), which
// is not the CLI that builds the app.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

const OWN_MODULES = path.join(ROOT, 'node_modules') + path.sep;

// The folder of the homey package a `homey` command belongs to, or null.
function cliFolder(command) {
  let dir = path.dirname(fs.realpathSync(command));
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'homey') return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// Every `homey` on the PATH, in its order.
function onThePath() {
  try {
    return execFileSync('which', ['-a', 'homey'], { encoding: 'utf8' }).split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (err) {
    return []; // not on the PATH
  }
}

// The folder of the Homey CLI that `homey` on the PATH runs, past the one in
// the app's own node_modules (own), or null.
function homeyCli({ commands = onThePath(), own = OWN_MODULES } = {}) {
  const ownFolder = own.endsWith(path.sep) ? own : own + path.sep;
  for (const command of commands) {
    try {
      const dir = cliFolder(command);
      if (dir && !(dir + path.sep).startsWith(ownFolder)) return dir;
    } catch (err) {
      // a link that leads nowhere: the next one
    }
  }
  return null;
}

function buildFiles() {
  const cli = homeyCli();
  assert.ok(cli && fs.existsSync(path.join(cli, 'lib', 'App.js')), 'the Homey CLI (homey on the PATH) is needed for this test');
  const source = fs.readFileSync(path.join(cli, 'lib', 'App.js'), 'utf8');
  const body = source.slice(source.indexOf('async _getAppSourceFiles()'));
  const list = /const ignoreRules = \[([^\]]*)\]/.exec(body);
  assert.ok(list, 'the CLI still lists its own rules in _getAppSourceFiles');
  assert.match(body.slice(0, 600), /ignoreFiles: \['\.homeyignore', DEFAULT_IGNORE_RULES_FILE\]/);
  const rules = [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  // Where the CLI itself finds it: in its own node_modules, or hoisted above.
  const ignoreWalk = require(require.resolve('ignore-walk', { paths: [cli] }));
  const walker = new ignoreWalk.Walker({
    path: ROOT, ignoreFiles: ['.homeyignore', '$default-ignore-rules'], includeEmpty: true, follow: true,
  });
  walker.onReadIgnoreFile('$default-ignore-rules', rules.join('\r\n'), () => {});
  return new Promise((resolve, reject) => walker.on('done', resolve).on('error', reject).start());
}

module.exports = { ROOT, buildFiles, homeyCli };
