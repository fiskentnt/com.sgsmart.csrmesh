'use strict';

// What the texts say about the network password (2.4.1). The warnings on a
// tile are short (Homey shows them only briefly). The explanation, "Network
// Isolation" first or the password in each device, is in the settings hint,
// the READMEs and the timeline notification; where a text says to turn it off,
// it says that all devices must then be set up again. README says one thing
// about 1234. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const en = JSON.parse(read('locales/en.json'));
const no = JSON.parse(read('locales/no.json'));
const network = JSON.parse(read('.homeycompose/drivers/settings/network.json'));
const hint = network.children.find((setting) => setting.id === 'passphrase').hint;
const readme = read('README.md');
const setup = readme.slice(readme.indexOf('## Setup'), readme.indexOf('## How it works'));

const EACH_DEVICE = /each\s+device|hver\s+enhet/;
const PER_DIMMER = /every\s+dimmer|each\s+dimmer|hver\s+dimmer/;
// README.md is not changed with the other texts and may still say "every
// dimmer".
const eachIn = (name) => (name === 'README.md' ? /each\s+device|every\s+dimmer/ : EACH_DEVICE);
const WARNING_MAX = 80;

// Every text that explains the fix, and the words for "each device".
const advice = [
  ['README.md', setup],
  ['README.txt', read('README.txt')],
  ['README.no.txt', read('README.no.txt')],
  ['network.json hint en', hint.en],
  ['network.json hint no', hint.no],
  ['timeline en', en.notification.passwordWrong],
  ['timeline no', no.notification.passwordWrong],
];

// The warnings a dimmer's tile can show.
const warnings = [];
for (const [language, locale] of [['en', en], ['no', no]]) {
  for (const key of ['passwordWrong', 'passwordWrongLogin', 'waitingForStatus', 'notHeard', 'sg3NotSent']) {
    warnings.push([`${language} device.${key}`, locale.device[key]]);
  }
}

test('the settings hint, the READMEs and the timeline say: the same password in each device', () => {
  for (const [name, text] of advice) {
    assert.match(text, eachIn(name), name);
    if (name !== 'README.md') assert.doesNotMatch(text, PER_DIMMER, name);
  }
});

test('there, turning Network Isolation off comes first, entering the password second', () => {
  for (const [name, text] of advice) {
    const isolation = text.indexOf('Network Isolation');
    assert.ok(isolation >= 0 && eachIn(name).test(text.slice(isolation)), name);
  }
});

test(`warnings are at most ${WARNING_MAX} characters, without the long explanation`, () => {
  for (const [name, text] of warnings) {
    assert.ok(text.length > 0 && text.length <= WARNING_MAX, `${name}: ${text.length}`);
    assert.doesNotMatch(text, /Network Isolation/, name);
    assert.doesNotMatch(text, EACH_DEVICE, name);
    assert.doesNotMatch(text, PER_DIMMER, name);
  }
});

test('README quotes the warning as it is; the store texts say what to check', () => {
  assert.ok(setup.replace(/\s+/g, ' ').includes(`"${en.device.passwordWrong}"`));
  assert.match(read('README.txt'), /If Homey warns about the password, check Network Isolation in the SG app\./);
  assert.match(read('README.no.txt'), /Ved feil passord, sjekk Nettverksisolasjon \(Network Isolation\) i SG-appen\./);
});

test('the Norwegian texts say Nettverksisolasjon (Network Isolation), the English ones Network Isolation as before', () => {
  const app = JSON.parse(read('app.json'));
  const hints = app.drivers.flatMap((driver) => (driver.settings || []).flatMap((group) => group.children || []))
    .filter((setting) => setting.id === 'passphrase').map((setting) => setting.hint);
  assert.equal(hints.length, 4, 'sg_mesh, sg_pill, sg_plug and sg_thermostat');
  for (const appHint of hints) assert.deepEqual(appHint, hint, 'app.json as network.json');
  for (const [name, text] of advice) {
    const named = text.split('Network Isolation').length - 1;
    assert.ok(named > 0, name);
    if (/ no$|README\.no/.test(name)) {
      assert.equal(text.split('Nettverksisolasjon (Network Isolation)').length - 1, named, name);
      assert.doesNotMatch(text, /[Ss]lå det av/, `${name}: "den" for Nettverksisolasjon`);
    } else {
      assert.doesNotMatch(text, /Nettverksisolasjon/, name);
    }
  }
});

// Said where a text says Network Isolation can be turned off, in one of two
// forms: on its own ("If you turn it off") or right after the advice ("Then").
const SET_UP_AGAIN = {
  en: ['If you turn it off, all devices must be set up again in the SG app.',
    'Then all devices must be set up again in the SG app.',
    'Turning it off means all devices must be set up again in the SG app.'],
  no: ['Slår du den av, må alle enhetene settes opp på nytt i SG-appen.',
    'Da må alle enhetene settes opp på nytt i SG-appen.'],
};
const TURN_OFF = { en: /turn (?:it|Network Isolation) off/i, no: /slå den av/i };
const NOTIFICATION_MAX = 170;

test('where a text says to turn Network Isolation off, it says that all devices must then be set up again', () => {
  const says = [];
  for (const [name, raw] of advice) {
    const language = / no$|README\.no/.test(name) ? 'no' : 'en';
    const text = raw.replace(/\s+/g, ' ');
    const sentences = SET_UP_AGAIN[language].filter((sentence) => text.includes(sentence));
    const advises = TURN_OFF[language].exec(sentences.reduce((rest, sentence) => rest.replace(sentence, ''), text));
    if (!advises) {
      assert.deepEqual(sentences, [], name);
      continue;
    }
    says.push(name);
    assert.equal(sentences.length, 1, name);
    assert.equal(text.split(sentences[0]).length - 1, 1, name);
    assert.ok(text.indexOf(sentences[0]) > advises.index, name);
  }
  assert.deepEqual(says, ['README.md', 'README.txt', 'README.no.txt', 'network.json hint en', 'network.json hint no']);
});

test(`the timeline notification is at most ${NOTIFICATION_MAX} characters and does not say to turn it off`, () => {
  for (const [language, locale] of [['en', en], ['no', no]]) {
    const text = locale.notification.passwordWrong;
    assert.ok(text.length <= NOTIFICATION_MAX, `${language}: ${text.length}`);
    assert.doesNotMatch(text, TURN_OFF[language], language);
    for (const sentence of SET_UP_AGAIN[language]) assert.ok(!text.includes(sentence), language);
  }
});

test('a wrong password gives a warning, and no text says the dimmers become unavailable', () => {
  for (const [name, text] of [...advice, ...warnings]) assert.doesNotMatch(text, /unavailable|utilgjengelig/i, name);
});

test('README says one thing about 1234: the passphrase, unless Network Isolation is on', () => {
  assert.doesNotMatch(readme, /most installations|usually/i);
  const step = setup.slice(setup.indexOf('\n2. '), setup.indexOf('\n3. '));
  assert.equal(setup.split('1234').length, step.split('1234').length);
  assert.match(step, /`1234`, which the SG app\s+sets unless \*\*Network Isolation\*\* is on/);
});

test('the timeline notification names the app and the problem, in both languages', () => {
  assert.match(en.notification.passwordWrong, /^Possibly wrong network password in SG LEDDim\./);
  assert.match(no.notification.passwordWrong, /^Mulig feil nettverkspassord i SG LEDDim\./);
});

test('with the SG account module and no account fetched, the warning and the timeline point to the login, not to Network Isolation', () => {
  assert.equal(no.device.passwordWrongLogin, 'Mulig feil nettverkspassord. Logg inn med SG-kontoen i appens innstillinger.');
  assert.equal(en.device.passwordWrongLogin, 'Network password may be wrong. Log in with your SG account in the app settings.');
  assert.equal(no.notification.passwordWrongLogin, 'Mulig feil nettverkspassord i SG LEDDim. Logg inn med SG-kontoen i appens innstillinger.');
  assert.equal(en.notification.passwordWrongLogin,
    'Possibly wrong network password in SG LEDDim. Log in with your SG account in the app settings.');
  for (const [language, locale] of [['en', en], ['no', no]]) {
    const text = locale.notification.passwordWrongLogin;
    assert.ok(text.length <= NOTIFICATION_MAX, `${language}: ${text.length}`);
    assert.doesNotMatch(text, /Network Isolation|Nettverksisolasjon/, language);
    assert.doesNotMatch(text, TURN_OFF[language], language);
  }
});

test('straight quotes only, in every text', () => {
  for (const [name, text] of [...advice, ...warnings, ['README.md', readme]]) {
    assert.doesNotMatch(text, /[“”‘’«»]/, name);
  }
});

test('every text in both languages, the store texts and the 2.5.0, 2.6.0, 2.6.1 and 2.7.0 changelogs: straight quotes, no ellipsis or dashes, the same placeholders', () => {
  const leaves = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? leaves(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
  const tokens = (text) => (text.match(/__[a-z]+__/g) || []).sort();
  const noTexts = Object.fromEntries(leaves(no));
  assert.deepEqual(leaves(en).map(([key]) => key).sort(), Object.keys(noTexts).sort());
  for (const [key, text] of leaves(en)) assert.deepEqual(tokens(text), tokens(noTexts[key]), key);
  const changelogs = JSON.parse(read('.homeychangelog.json'));
  const texts = [...leaves(en), ...leaves(no), ['README.txt', read('README.txt')], ['README.no.txt', read('README.no.txt')],
    ...['2.5.0', '2.6.0', '2.6.1', '2.7.0'].flatMap((version) => [[`changelog ${version} en`, changelogs[version].en], [`changelog ${version} no`, changelogs[version].no]])];
  for (const [name, text] of texts) assert.doesNotMatch(text, /[“”‘’«»…–—]/, name);
  assert.deepEqual(tokens(en.pair.found.notYet), ['__products__']);
  assert.deepEqual(tokens(en.settings.log.summary), ['__count__', '__from__', '__to__']);
});

test('"Show log": the same texts in both languages, all used by the settings page, none in the store text', () => {
  assert.deepEqual(Object.keys(en.settings.log).sort(), Object.keys(no.settings.log).sort());
  const page = read('settings/index.html');
  for (const locale of [en, no]) {
    for (const [key, text] of Object.entries(locale.settings.log)) {
      assert.ok(text.trim().length > 0, key);
      assert.doesNotMatch(text, /[“”‘’«»]/, key);
      assert.ok(page.includes(`'settings.log.${key}'`) || page.includes(`"settings.log.${key}"`), `settings.log.${key} is not used`);
    }
    for (const token of ['__count__', '__from__', '__to__']) assert.ok(locale.settings.log.summary.includes(token), token);
  }
  assert.doesNotMatch(read('README.txt') + read('README.no.txt'), /Show log|Vis logg/);
});

test('no text asks for other SG devices named @ND: only the first generation LEDDim Smart has that name', () => {
  const texts = [read('README.md'), read('README.txt'), read('README.no.txt'), read('settings/index.html'),
    ...Object.values(en.settings.otherDevice), ...Object.values(no.settings.otherDevice)];
  for (const text of texts) {
    assert.doesNotMatch(text, /another SG device named @ND|annen SG-enhet med @ND|Other older SG dimmers named/i);
  }
  // A point for each product the drivers add, its name in bold, then 3.0 and
  // the others, and one line under them.
  assert.deepEqual(no.settings.otherDevice, {
    title: 'Hvilke SG-enheter støttes',
    rotary: 'Første generasjon (@NDxxxx) er stabil. Senere generasjoner, også TW, Master og 400 2-pole, er under utprøving.',
    pill: ', også Micro, TW og Smart Pill ON-OFF: under utprøving.',
    plug: ' og Smart Socket: under utprøving.',
    thermostat: ': under utprøving. Styring fra Homey er ny, på som standard, og kan slås av.',
    sg3: ': LEDDim Smart 3.0 og LEDDim Smart 2-pol 3.0 er under utprøving og krever innlogging med SG-kontoen. Andre 3.0-produkter støttes ikke ennå.',
    other: 'Andre SG-enheter, som DIN, Push, Floor og Pill DALI, støttes ikke ennå.',
    report: 'Fungerer ikke alt som det skal? Meld fra i forumtråden.',
  });
  assert.deepEqual(en.settings.otherDevice, {
    title: 'Which SG devices are supported',
    rotary: 'First generation (@NDxxxx) is stable. Later generations, including TW, Master and 400 2-pole, are being tested.',
    pill: ', including Micro, TW and Smart Pill ON-OFF: being tested.',
    plug: ' and Smart Socket: being tested.',
    thermostat: ': being tested. Control from Homey is new, on by default, and can be turned off.',
    sg3: ': LEDDim Smart 3.0 and LEDDim Smart 2-pole 3.0 are being tested and need you to log in with your SG account. Other 3.0 products are not supported yet.',
    other: 'Other SG devices, such as DIN, Push, Floor and Pill DALI, are not supported yet.',
    report: 'Something not working? Report it in the forum thread.',
  });
  const page = read('settings/index.html');
  for (const [key, text] of Object.entries(en.settings.otherDevice)) {
    assert.ok(page.includes(`data-i18n="settings.otherDevice.${key}">${text}<`), `the page falls back on settings.otherDevice.${key}`);
  }
  assert.ok(page.includes('<li><strong>LEDDim Smart</strong>: <span data-i18n="settings.otherDevice.rotary">'));
  assert.ok(page.includes('<li><strong>LEDDim Smart Pill</strong><span data-i18n="settings.otherDevice.pill">'));
  assert.ok(page.includes('<li><strong>Smart Plug</strong><span data-i18n="settings.otherDevice.plug">'));
  assert.ok(page.includes('<li><strong>HeatReg Smart</strong><span data-i18n="settings.otherDevice.thermostat">'));
  assert.ok(page.includes('<li><strong>SG Smart 3.0</strong><span data-i18n="settings.otherDevice.sg3">'));
  assert.ok(page.includes('<li data-i18n="settings.otherDevice.other">'));
  assert.equal((page.match(/<li>|<li /g) || []).length, 6, 'six points');
  assert.doesNotMatch(read('README.txt') + read('README.no.txt'), /Show log|Vis logg/);
  // 2.6.0: later generations, the Pill, the plugs and the thermostat can be tried, and the store texts say so, without URLs.
  assert.match(read('README.txt'), /The first generation \(@NDxxxx in Bluetooth\) works reliably\. Later generations, LEDDim Smart Pill, Smart Plug, Smart Socket and the HeatReg Smart floor thermostat are being tested\./);
  assert.match(read('README.no.txt'), /Første generasjon \(@NDxxxx i Bluetooth\) fungerer stabilt\. Nyere generasjoner, LEDDim Smart Pill, Smart Plug, Smart Socket og gulvtermostaten HeatReg Smart er under utprøving\./);
  // The first point of the guide before a search, word for word.
  assert.ok(read('README.txt').includes(` ${en.pair.guide.setupFirst} `));
  assert.ok(read('README.no.txt').includes(` ${no.pair.guide.setupFirst} `));
  assert.doesNotMatch(read('README.txt') + read('README.no.txt'), /https?:\/\//);
  assert.match(setup, /Add a \*\*LEDDim Smart\*\* device/);
  assert.match(setup, /added as \*\*LEDDim Smart Pill\*\*/);
});

test('"Which SG devices are supported" names the variants the drivers add, and examples of products they do not', () => {
  const { CSR_PRODUCTS, PILL_PREFIXES, ROTARY_PREFIXES, csrDriverFor, csrProductForName } = require('../lib/sgProducts');
  const names = (prefixes) => [...new Set(prefixes.map((prefix) => csrProductForName(`${prefix}0000`).name))].sort();
  assert.deepEqual(names(ROTARY_PREFIXES), ['LEDDim Smart', 'LEDDim Smart 400 2-pole', 'LEDDim Smart Master', 'TW LEDDim Smart']);
  assert.deepEqual(names(PILL_PREFIXES),
    ['LEDDim Smart Pill', 'LEDDim Smart Pill Micro', 'Smart Pill ON-OFF', 'Smart Pill ON-OFF Micro', 'TW LEDDim Smart Pill']);
  for (const locale of [en, no]) {
    for (const variant of ['TW', 'Master', '400 2-pole']) assert.ok(locale.settings.otherDevice.rotary.includes(variant), variant);
    for (const variant of ['Micro', 'TW', 'Smart Pill ON-OFF']) assert.ok(locale.settings.otherDevice.pill.includes(variant), variant);
  }
  const notAdded = Object.keys(CSR_PRODUCTS).map((prefix) => csrProductForName(`${prefix}0000`))
    .filter((product) => !csrDriverFor(product)).map((product) => product.name);
  for (const example of ['DIN', 'Push', 'Floor', 'Pill DALI']) {
    assert.ok(notAdded.some((name) => name.includes(example)), example);
    for (const locale of [en, no]) assert.ok(locale.settings.otherDevice.other.includes(example), example);
  }
});

test('driver names (2.5.0): the choices when adding a device, the same in app.json, the ids unchanged', () => {
  const names = {
    sg_mesh: { en: 'LEDDim Smart', no: 'LEDDim Smart' },
    sg_group: { en: 'Group Gen1', no: 'Gruppe Gen1' },
    sg_pill: { en: 'LEDDim Smart Pill', no: 'LEDDim Smart Pill' },
    sg_plug: { en: 'Smart Plug and Smart Socket', no: 'Smart Plug og Smart Socket' },
    sg_thermostat: { en: 'HeatReg Smart', no: 'HeatReg Smart' },
  };
  for (const [driver, name] of Object.entries(names)) {
    assert.deepEqual(JSON.parse(read(`drivers/${driver}/driver.compose.json`)).name, name, driver);
  }
  const app = JSON.parse(read('app.json'));
  assert.deepEqual(Object.fromEntries(app.drivers.map((driver) => [driver.id, driver.name])), names);
  const old = /CSRmesh Dimmer|CSRmesh Group|SG device \(trial\)|SG-enhet \(utprøving\)|added as Dimmer|til som Dimmer|Pill, DIN, plugg? \(test\)|SG devices after Gen1|SG-enheter etter Gen1|SG Gen2\+|SG Gen2-4|LEDDim Smart Gen1|LEDDim Smart Pill \(test\)/;
  for (const text of [read('README.md'), read('settings/index.html'), JSON.stringify(en), JSON.stringify(no)]) {
    assert.doesNotMatch(text, old);
  }
});

test('the Pill driver (sg_pill): the same texts in both languages, all used; no generation or "(test)" in a name', () => {
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
  assert.deepEqual(keys(en.pair.csr).sort(), keys(no.pair.csr).sort());
  const driver = read('drivers/sg_pill/driver.js') + read('lib/csrPairing.js');
  for (const key of keys(en.pair.csr)) assert.ok(driver.includes(`'pair.csr.${key}'`), `pair.csr.${key} is not used`);
  for (const id of ['sg_mesh', 'sg_pill', 'sg_plug', 'sg_thermostat']) {
    const compose = JSON.parse(read(`drivers/${id}/driver.compose.json`));
    assert.equal(compose.pair.find((step) => step.id === 'loading').options, undefined, id);
  }
  for (const text of [...Object.values(en.pair.csr), ...Object.values(no.pair.csr)]) {
    assert.doesNotMatch(text, /[“”‘’«»]/, text);
    assert.doesNotMatch(text, /1234/, text);
  }
  assert.equal(no.pair.csr.failed, 'Søket mislyktes. Prøv igjen om litt.');
  assert.equal(en.pair.csr.failed, 'Search failed. Try again in a moment.');
  // Nothing found is an empty list, with Homey's own text; seen but without
  // an answer, and no SG account fetched, the login text (lib/csrPairing.js).
  assert.deepEqual(Object.keys(en.pair.csr), ['failed', 'noAnswerLogin']);
  assert.equal(no.pair.csr.noAnswerLogin, 'Fant SG-enheter som ikke svarte. Det kan være feil nettverkspassord. '
    + 'Logg inn med SG-kontoen i appens innstillinger for å hente det riktige.');
  assert.equal(en.pair.csr.noAnswerLogin, 'Found SG devices that did not respond. The network password may be wrong. '
    + 'Log in with your SG account in the app settings to fetch the right one.');
  // The generation is only in the log, and the trial only in the store
  // text, "Other SG devices" and README; device names are "LEDDim Smart Pill 1A2B".
  for (const driver of ['sg_mesh', 'sg_pill', 'sg_plug', 'sg_thermostat']) {
    const { name } = JSON.parse(read(`drivers/${driver}/driver.compose.json`));
    for (const text of Object.values(name)) assert.doesNotMatch(text, /test|Gen\d/i, driver);
  }
  for (const file of ['lib/csrPairing.js', 'drivers/sg_mesh/driver.js', 'drivers/sg_pill/driver.js', 'drivers/sg_plug/driver.js',
    'drivers/sg_thermostat/driver.js']) {
    assert.doesNotMatch(read(file), /pair\.csr\.trial|generation\}, /, file);
  }
  assert.equal(en.pair.csr.trial, undefined);
});

test('where other products go (pair.found): what was not found, what was, and what to do, as agreed, in both languages', () => {
  assert.deepEqual(Object.keys(en.pair.found).sort(), Object.keys(no.pair.found).sort());
  const pairing = read('lib/csrPairing.js');
  for (const key of Object.keys(en.pair.found)) assert.ok(pairing.includes(`'pair.found.${key}'`), `pair.found.${key} is not used`);
  const f = { en: en.pair.found, no: no.pair.found };
  assert.equal(f.no.noDimmerButPill, 'Fant ingen dreiedimmere, men fant __products__. Gå tilbake og velg "LEDDim Smart Pill" for å legge til.');
  assert.equal(f.en.noDimmerButPill, 'No rotary dimmers found, but found __products__. Go back and select "LEDDim Smart Pill" to add them.');
  assert.equal(f.no.noPillButDimmer, 'Fant ingen Pill, men fant __products__. Gå tilbake og velg "LEDDim Smart" for å legge til.');
  assert.equal(f.en.noPillButDimmer, 'No Pill found, but found __products__. Go back and select "LEDDim Smart" to add them.');
  assert.equal(`${f.no.noDimmer} ${f.no.notYet}`, 'Fant ingen dreiedimmere. Fant __products__, som ikke kan legges til ennå.');
  assert.equal(`${f.en.noDimmer} ${f.en.notYet}`, 'No rotary dimmers found. Found __products__, which cannot be added yet.');
  assert.equal(`${f.no.noPill} ${f.no.notYet}`, 'Fant ingen Pill. Fant __products__, som ikke kan legges til ennå.');
  assert.equal(`${f.en.noPill} ${f.en.notYet}`, 'No Pill found. Found __products__, which cannot be added yet.');
  const name = (driver) => JSON.parse(read(`drivers/${driver}/driver.compose.json`)).name;
  for (const language of ['en', 'no']) {
    assert.ok(f[language].noDimmerButPill.includes(`"${name('sg_pill')[language]}"`), language);
    assert.ok(f[language].noPillButDimmer.includes(`"${name('sg_mesh')[language]}"`), language);
  }
});

// The duration texts the drivers' guide steps name in their options.
const guideDurations = () => ['sg_mesh', 'sg_pill', 'sg_plug', 'sg_thermostat']
  .map((driver) => JSON.parse(read(`drivers/${driver}/driver.compose.json`)).pair.find((step) => step.id === 'guide'))
  .map((step) => step.options && step.options.duration).filter(Boolean);

test('every pair text the drivers and their views use is there in both languages, and every pair text is used', () => {
  const sources = ['drivers/sg_mesh/driver.js', 'drivers/sg_pill/driver.js', 'drivers/sg_plug/driver.js',
    'drivers/sg_thermostat/driver.js', 'drivers/sg_mesh/pair/guide.html',
    'drivers/sg_group/driver.js', 'drivers/sg_group/pair/select_members.html',
    'drivers/sg_group/repair/select_members.html', 'lib/csrPairing.js'].map(read).join('\n');
  const steps = [...sources.matchAll(/data-step="([A-Za-z]+)"/g)].map((m) => `pair.guide.${m[1]}`);
  const durations = guideDurations().map((key) => `pair.guide.${key}`);
  const used = [...new Set([...sources.matchAll(/['"](pair(?:\.[A-Za-z]+)+)['"]/g)].map((m) => m[1]).concat(steps, durations))];
  assert.ok(used.length >= 15, `${used.length} keys`);
  const leaves = (o, p) => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? leaves(v, `${p}${k}.`) : [`${p}${k}`]));
  for (const key of leaves(en.pair, 'pair.')) assert.ok(used.includes(key), `${key} is not used`);
  assert.equal(en.pair.search, undefined);
  assert.equal(no.pair.search, undefined);
  for (const key of used) {
    for (const [language, locale] of [['en', en], ['no', no]]) {
      const text = key.split('.').reduce((o, k) => (o ? o[k] : undefined), locale);
      assert.equal(typeof text, 'string', `${language} ${key}`);
    }
  }
});

test('the guide before the search: the same view in every driver that searches, its texts in both languages', () => {
  const guide = read('drivers/sg_mesh/pair/guide.html');
  assert.equal(read('drivers/sg_pill/pair/guide.html'), guide);
  assert.equal(read('drivers/sg_plug/pair/guide.html'), guide);
  assert.equal(read('drivers/sg_thermostat/pair/guide.html'), guide);
  assert.deepEqual(Object.keys(en.pair.guide).sort(), Object.keys(no.pair.guide).sort());
  for (const key of Object.keys(en.pair.guide)) {
    assert.ok(guide.includes(`'pair.guide.${key}'`) || guide.includes(`data-step="${key}"`) || guideDurations().includes(key),
      `pair.guide.${key} is not used`);
  }
  assert.deepEqual(guideDurations(), ['durationPill', 'durationPill', 'durationPill'], 'sg_pill, sg_plug and sg_thermostat');
  assert.ok(guide.includes('Homey.getOptions()') && guide.includes('pair.guide.${options.duration}'));
  assert.equal(no.pair.guide.durationPill, 'Søket tar vanligvis under ett minutt.');
  assert.equal(en.pair.guide.durationPill, 'The search usually takes less than a minute.');
  for (const locale of [en, no]) {
    for (const text of Object.values(locale.pair.guide)) assert.doesNotMatch(text, /[“”‘’«»]/);
    assert.match(locale.pair.guide.password, /1234/);
    assert.match(locale.pair.guide.closeApp, /SG/);
  }
  // First: the device must be set up in the SG app; Homey adds none to the network.
  assert.deepEqual([...guide.matchAll(/<li data-step="([A-Za-z]+)">/g)].map((m) => m[1]), ['setupFirst', 'closeApp', 'near', 'password']);
  assert.equal(no.pair.guide.setupFirst, 'Sett opp enheten i SG-appen på telefonen først. Homey legger ikke til nye enheter i nettet.');
  assert.equal(en.pair.guide.setupFirst, 'Set up the device in the SG app on your phone first. Homey does not add new devices to the network.');
  assert.equal(no.pair.guide.title, 'Før du søker');
  assert.equal(en.pair.guide.title, 'Before you search');
  assert.equal(no.pair.guide.duration, 'Søket tar 10 til 20 sekunder.');
  assert.equal(en.pair.guide.duration, 'The search takes 10 to 20 seconds.');
  const firstTwo = (driver) => JSON.parse(read(`drivers/${driver}/driver.compose.json`)).pair
    .slice(0, 2).map((step) => [step.id, step.navigation]);
  for (const driver of ['sg_mesh', 'sg_pill', 'sg_plug', 'sg_thermostat']) {
    assert.deepEqual(firstTwo(driver), [['guide', { next: 'loading' }], ['loading', { next: 'list_devices' }]], driver);
  }
});

test('the settings page follows Homey\'s form pattern: every section a titled fieldset, each switch a checkbox with its name beside it', () => {
  const page = read('settings/index.html');
  const fieldsets = page.match(/<fieldset[^>]*>/g);
  assert.ok(fieldsets.length >= 4);
  for (const tag of fieldsets) assert.equal(tag, '<fieldset class="homey-form-fieldset">');
  for (const tag of page.match(/<legend[^>]*>/g)) assert.match(tag, /^<legend class="homey-form-legend" data-i18n="settings\.[a-zA-Z]+\.title">$/);
  assert.equal((page.match(/<legend /g) || []).length, fieldsets.length, 'a title in every fieldset');
  // The two keep-connected boxes sit one level in, each in its own box that
  // the page shows or hides (below).
  for (const [id, key, indent] of [['keepConnected', 'settings.keepConnected.label', '  '],
    ['sg3KeepConnected', 'settings.sg3KeepConnected.label', '  '], ['debugLogging', 'settings.troubleshooting.debug', '']]) {
    assert.ok(page.includes(`<label class="homey-form-checkbox">\n`
      + `${indent}      <input class="homey-form-checkbox-input" id="${id}" type="checkbox">\n`
      + `${indent}      <span class="homey-form-checkbox-checkmark"></span>\n`
      + `${indent}      <span class="homey-form-checkbox-text" data-i18n="${key}">`), id);
  }
  assert.doesNotMatch(page, /class="field row"/);
  assert.equal((page.match(/<\/label>\n {4}(?: {2})?<p data-i18n="settings\.[a-zA-Z0-9]+\.hint">/g) || []).length, 3, 'each hint right after its checkbox');
  assert.doesNotMatch(page, /settings\.log\.title/, 'no loose "Log" under Troubleshooting');
  assert.equal(no.settings.connection.title, 'Tilkobling');
  assert.equal(en.settings.connection.title, 'Connection');
  // The keep-connected texts, as Trond worded them (2026-11-05). A pairing
  // search lets a held link go by itself, so they say nothing of it.
  assert.deepEqual(no.settings.keepConnected, {
    label: 'Hold dimmerne tilkoblet',
    hint: 'Slå på for raskere respons. Har du bare én enhet av første generasjon, får ikke SG-appen på telefonen kontakt med den.',
  });
  assert.deepEqual(en.settings.keepConnected, {
    label: 'Keep dimmers connected',
    hint: 'Enable for faster response. If you have only one first-generation device, the SG app on your phone cannot connect to it.',
  });
  assert.deepEqual(no.settings.sg3KeepConnected, {
    label: 'Hold SG Smart 3.0 tilkoblet',
    hint: 'Slå på for raskere respons. Har du bare én 3.0-enhet, får ikke SG-appen på telefonen kontakt med den.',
  });
  assert.deepEqual(en.settings.sg3KeepConnected, {
    label: 'Keep SG Smart 3.0 connected',
    hint: 'Enable for faster response. If you have only one 3.0 device, the SG app on your phone cannot connect to it.',
  });
  assert.equal(no.settings.signal.hint, 'Vises under "Forbindelse" når du åpner en dimmer av første generasjon. "Direkte" betyr at dimmeren har kontakt med Homey. Andre dimmere nås via denne. Svakt signal? Flytt Homey nærmere en dimmer.');
  assert.equal(en.settings.signal.hint, 'Shown under "Link" when you open a first-generation dimmer. "Direct" means the dimmer is connected to Homey. Other dimmers are reached through it. Weak signal? Move Homey closer to a dimmer.');
  assert.ok(page.includes(en.settings.signal.hint));
  assert.doesNotMatch(page, /<style>/, 'no CSS of its own');
  assert.ok(page.includes(en.settings.keepConnected.hint));
  assert.ok(page.includes(en.settings.sg3KeepConnected.hint));
  assert.ok(page.includes(en.settings.sg3KeepConnected.label));
  // Each box, with its text, only with a device of its kind in Homey: hidden
  // until the app says so (keepConnectedShown, sg3KeepConnectedShown); the
  // text is the same whatever the number.
  for (const [box, id, hint, shown] of [['keepConnectedBox', 'keepConnected', 'settings.keepConnected.hint', 'keepConnectedShown'],
    ['sg3KeepConnectedBox', 'sg3KeepConnected', 'settings.sg3KeepConnected.hint', 'sg3KeepConnectedShown']]) {
    const start = page.indexOf(`<div id="${box}" hidden>`);
    assert.ok(start > 0, box);
    const inside = page.slice(start, page.indexOf('</div>', start));
    assert.ok(inside.includes(`id="${id}"`) && inside.includes(`data-i18n="${hint}"`), `${box} holds the box and its text`);
    assert.ok(page.includes(`get('${shown}')`), shown);
    assert.ok(page.includes(`${box}.hidden = ${shown === 'keepConnectedShown' ? 'shown' : 'sg3Shown'} !== true;`), box);
  }
  assert.equal((page.match(/data-i18n="settings\.(?:sg3K|k)eepConnected\.hint"/g) || []).length, 2, 'one text per box, not one per number');
});

test('the developer is "the developer", never named, anywhere in the app', () => {
  const fs = require('fs');
  const path = require('path');
  const views = ['sg_mesh', 'sg_pill', 'sg_group'].flatMap((driver) => ['pair', 'repair']
    .map((dir) => path.join('drivers', driver, dir))
    .filter((dir) => fs.existsSync(path.join(__dirname, '..', dir)))
    .flatMap((dir) => fs.readdirSync(path.join(__dirname, '..', dir)).map((file) => path.join(dir, file))));
  const files = ['locales/en.json', 'locales/no.json', 'settings/index.html', 'README.md', 'README.txt', 'README.no.txt',
    '.homeychangelog.json', '.homeycompose/app.json', ...views];
  for (const file of files) assert.doesNotMatch(read(file), /trobil/i, file);
});

test('the log goes to the developer as a private message, never in the thread; the button opens the app\'s thread', () => {
  assert.match(en.settings.log.hint, /when lights are used\. Send it as a private message to the developer in the forum, not in the thread\.$/);
  assert.equal(en.settings.otherDevice.report, 'Something not working? Report it in the forum thread.');
  assert.match(no.settings.log.hint, /når lysene brukes\. Send den som privat melding til utvikleren i forumet, ikke i tråden\.$/);
  assert.equal(no.settings.otherDevice.report, 'Fungerer ikke alt som det skal? Meld fra i forumtråden.');
  for (const hint of [en.settings.log.hint, en.settings.otherDevice.report]) assert.doesNotMatch(hint, /paste/i);
  for (const hint of [no.settings.log.hint, no.settings.otherDevice.report]) assert.doesNotMatch(hint, /lim/i);
  const page = read('settings/index.html');
  const topic = JSON.parse(read('.homeycompose/app.json')).homeyCommunityTopicId;
  assert.ok(page.includes(`'https://community.homey.app/t/${topic}'`));
  assert.ok(page.includes('Homey.openURL(FORUM_URL)'));
  assert.equal((page.match(/class="forum-open"/g) || []).length, 2);
  for (const locale of [en, no]) assert.ok(locale.settings.forum.open.length > 0);
});
