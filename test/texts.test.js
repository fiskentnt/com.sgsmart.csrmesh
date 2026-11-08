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

// Every text that explains the fix, and the words for "each device". The
// settings hint is short since 2.8.0 (below): 1234 unless Network Isolation,
// and the login; it is not one of them. Nor are the store texts since 2.8.0
// (README.txt, README.no.txt): they point to the login (Trond 2026-11-08).
const advice = [
  ['README.md', setup],
  ['timeline en', en.notification.passwordWrong],
  ['timeline no', no.notification.passwordWrong],
];

test('the network password and the raw key, as Trond worded them (2026-11-08), the same in every driver', () => {
  assert.deepEqual(hint, {
    en: 'Usually 1234, unless Network Isolation is enabled in the SG app. Log in with your SG account in the SG LEDDim settings to fetch the network password.',
    no: 'Vanligvis 1234, med mindre Nettverksisolasjon er på i SG-appen. Logg inn med SG-kontoen i innstillingene til SG LEDDim for å hente nettverkspassordet.',
  });
  const byId = Object.fromEntries(JSON.parse(read('.homeycompose/drivers/settings/network.json')).children.map((s) => [s.id, s]));
  assert.deepEqual(byId.passphrase.label, { en: 'Network password', no: 'Nettverkspassord' });
  assert.deepEqual(byId.netkey_hex.hint, {
    en: 'Optional. 32 hexadecimal characters (16 bytes). Overrides the network password when entered.',
    no: 'Valgfritt. 32 heksadesimale tegn (16 byte). Overstyrer nettverkspassordet når feltet er fylt ut.',
  });
  for (const driver of ['sg_mesh', 'sg_pill', 'sg_plug', 'sg_thermostat']) {
    assert.deepEqual(JSON.parse(read(`drivers/${driver}/driver.settings.compose.json`))[0], { $extends: 'network' }, driver);
  }
});

// The warnings a dimmer's tile can show, and a thermostat's (its faults and
// the wait for its first status, lib/SGThermostatDevice.js).
const warnings = [];
for (const [language, locale] of [['en', en], ['no', no]]) {
  for (const key of ['passwordWrong', 'passwordWrongLogin', 'waitingForStatus', 'notHeard', 'sg3NotSent']) {
    warnings.push([`${language} device.${key}`, locale.device[key]]);
  }
  warnings.push([`${language} thermostat.waitingForStatus`, locale.thermostat.waitingForStatus]);
  for (const [code, text] of Object.entries(locale.thermostat.fault)) warnings.push([`${language} thermostat.fault.${code}`, text]);
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

test('README quotes the warning as it is; the store texts point to the login (2.8.0)', () => {
  assert.ok(setup.replace(/\s+/g, ' ').includes(`"${en.device.passwordWrong}"`));
  assert.match(read('README.txt'), /Log in with your SG account in the SG LEDDim settings to fetch the network password and device names\./);
  assert.match(read('README.no.txt'), /Logg inn med SG-kontoen i innstillingene til SG LEDDim for å hente nettverkspassord og enhetsnavn\./);
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
  assert.deepEqual(says, ['README.md']);
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
  // The warning as a question, to stay within WARNING_MAX (Trond 2026-11-07).
  assert.equal(no.device.passwordWrongLogin, 'Feil nettverkspassord? Logg inn med SG-kontoen i innstillingene til SG LEDDim.');
  assert.equal(en.device.passwordWrongLogin, 'Wrong network password? Log in with your SG account in the SG LEDDim settings.');
  assert.equal(no.notification.passwordWrongLogin, 'Mulig feil nettverkspassord i SG LEDDim. Logg inn med SG-kontoen i innstillingene til SG LEDDim.');
  assert.equal(en.notification.passwordWrongLogin,
    'Possibly wrong network password in SG LEDDim. Log in with your SG account in the SG LEDDim settings.');
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
    rotary: 'Første generasjon (Gen1, @NDxxxx) er testet og fungerer. Senere generasjoner, også TW, Master og 400 2-pol, er under utprøving.',
    pill: ', også Micro, TW og Smart Pill ON-OFF: under utprøving.',
    plug: ' og Smart Socket: under utprøving.',
    thermostat: ': under utprøving. Styring fra Homey er ny, på som standard, og kan slås av.',
    sg3: ': LEDDim Smart 3.0 er testet og fungerer. LEDDim Smart 2-pol 3.0 er under utprøving. Begge krever innlogging med SG-kontoen. Andre 3.0-produkter støttes ikke ennå.',
    other: 'Andre SG-enheter, som DIN, Push, Floor og Pill DALI, støttes ikke ennå.',
    report: 'Fungerer ikke alt som det skal? Meld fra i forumtråden.',
  });
  assert.deepEqual(en.settings.otherDevice, {
    title: 'Which SG devices are supported',
    rotary: 'First generation (Gen1, @NDxxxx) has been tested and works. Later generations, including TW, Master and 400 2-pole, are being tested.',
    pill: ', including Micro, TW and Smart Pill ON-OFF: being tested.',
    plug: ' and Smart Socket: being tested.',
    thermostat: ': being tested. Control from Homey is new, on by default, and can be turned off.',
    sg3: ': LEDDim Smart 3.0 has been tested and works. LEDDim Smart 2-pole 3.0 is being tested. Both need you to log in with your SG account. Other 3.0 products are not supported yet.',
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
  // 2.8.0: what is tested and works, and what is not tested yet, as Trond
  // worded the store texts (2026-11-08), without URLs.
  assert.match(read('README.txt'), /The first generation \(@NDxxxx\) and LEDDim Smart 3\.0 have been tested and work\. LEDDim Smart generations 2 to 4, LEDDim Smart Pill, Smart Plug, Smart Socket, HeatReg Smart and LEDDim Smart 2-pole 3\.0 have not been tested yet\./);
  assert.match(read('README.no.txt'), /Første generasjon \(@NDxxxx\) og LEDDim Smart 3\.0 er testet og virker\. LEDDim Smart generasjon 2 til 4, LEDDim Smart Pill, Smart Plug, Smart Socket, HeatReg Smart og LEDDim Smart 2-pol 3\.0 er ikke testet ennå\./);
  assert.doesNotMatch(read('README.txt') + read('README.no.txt'), /https?:|www\./, 'no URLs');
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
  // "400 2-pole" in English, "400 2-pol" in Norwegian.
  for (const [locale, twoPole] of [[en, '400 2-pole'], [no, '400 2-pol,']]) {
    for (const variant of ['TW', 'Master', twoPole]) assert.ok(locale.settings.otherDevice.rotary.includes(variant), variant);
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
    sg3_dimmer: { en: 'LEDDim Smart 3.0', no: 'LEDDim Smart 3.0' },
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
  assert.equal(no.pair.csr.noAnswerLogin, 'Fant SG-enheter som ikke svarte. Nettverkspassordet kan være feil. '
    + 'Logg inn med SG-kontoen i innstillingene til SG LEDDim for å hente det.');
  assert.equal(en.pair.csr.noAnswerLogin, 'Found SG devices that did not respond. The network password may be wrong. '
    + 'Log in with your SG account in the SG LEDDim settings to fetch it.');
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
  assert.equal(f.no.noPillButDimmer, 'Fant ingen LEDDim Smart Pill, men fant __products__. Gå tilbake og velg "LEDDim Smart" for å legge til.');
  assert.equal(f.en.noPillButDimmer, 'No LEDDim Smart Pill found, but found __products__. Go back and select "LEDDim Smart" to add them.');
  assert.equal(`${f.no.noDimmer} ${f.no.notYet}`, 'Fant ingen dreiedimmere. Fant __products__, som ikke kan legges til ennå.');
  assert.equal(`${f.en.noDimmer} ${f.en.notYet}`, 'No rotary dimmers found. Found __products__, which cannot be added yet.');
  assert.equal(`${f.no.noPill} ${f.no.notYet}`, 'Fant ingen LEDDim Smart Pill. Fant __products__, som ikke kan legges til ennå.');
  assert.equal(`${f.en.noPill} ${f.en.notYet}`, 'No LEDDim Smart Pill found. Found __products__, which cannot be added yet.');
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
  // LEDDim Smart 3.0 names its texts in full (pair.sg3Guide, pair.sg3).
  const sg3 = ['drivers/sg3_dimmer/driver.js', 'drivers/sg3_dimmer/pair/guide.html'].map(read).join('\n');
  const used = [...new Set([...`${sources}\n${sg3}`.matchAll(/['"](pair(?:\.[A-Za-z0-9]+)+)['"]/g)].map((m) => m[1]).concat(steps, durations))];
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
  for (const tag of fieldsets) assert.match(tag, /^<fieldset class="homey-form-fieldset"(?: id="[a-zA-Z]+")?>$/);
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
  // The keep-connected texts, as Trond worded them (2026-11-05, the English
  // "reach" 2026-11-07). A pairing search lets a held link go by itself, so
  // they say nothing of it.
  assert.deepEqual(no.settings.keepConnected, {
    label: 'Hold SG LEDDim Gen1 tilkoblet',
    hint: 'Slå på for raskere respons. Har du bare én Gen1-enhet, får ikke SG-appen på telefonen kontakt med den så lenge innstillingen er på.',
  });
  assert.deepEqual(en.settings.keepConnected, {
    label: 'Keep SG LEDDim Gen1 connected',
    hint: 'Enable for faster response. If you have only one Gen1 device, the SG app on your phone cannot reach it while this setting is on.',
  });
  assert.deepEqual(no.settings.sg3KeepConnected, {
    label: 'Hold SG Smart 3.0 tilkoblet',
    hint: 'Slå på for raskere respons. Har du bare én 3.0-enhet, får ikke SG-appen på telefonen kontakt med den så lenge innstillingen er på.',
  });
  assert.deepEqual(en.settings.sg3KeepConnected, {
    label: 'Keep SG Smart 3.0 connected',
    hint: 'Enable for faster response. If you have only one 3.0 device, the SG app on your phone cannot reach it while this setting is on.',
  });
  assert.equal(no.settings.signal.hint, 'Åpne en dimmer og se "Forbindelse". "Direkte" betyr at dimmeren har kontakt med Homey, og de andre nås via den. Svakt signal? Flytt Homey nærmere en dimmer.');
  assert.equal(en.settings.signal.hint, 'Open a dimmer and check "Link". "Direct" means the dimmer has contact with Homey, and the others are reached through it. Weak signal? Move Homey closer to a dimmer.');
  assert.ok(page.includes(en.settings.signal.hint));
  // "Signal to Homey" shows with a first generation dimmer or a 3.0 device;
  // its fieldset is found by its id.
  assert.match(page, /<fieldset class="homey-form-fieldset" id="signalFieldset">\s*<legend class="homey-form-legend" data-i18n="settings\.signal\.title">/);
  assert.ok(page.includes("const signalFieldset = document.getElementById('signalFieldset');"));
  assert.ok(page.includes('signalFieldset.hidden = shown !== true && sg3Shown !== true;'));
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

// On my.homey.app a lookup by data-i18n found nothing, and the settings page
// stopped with "Cannot read properties of null (reading 'closest')" (2026-11-06).
// data-i18n is only for the text; the scripts find elements by id, class or
// attributes of their own.
test('no view looks up an element by data-i18n, and every id a view looks up is on it', () => {
  const root = path.join(__dirname, '..');
  const views = ['settings/index.html'];
  for (const driver of fs.readdirSync(path.join(root, 'drivers'))) {
    for (const folder of ['pair', 'repair']) {
      const dir = path.join(root, 'drivers', driver, folder);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) if (name.endsWith('.html')) views.push(`drivers/${driver}/${folder}/${name}`);
    }
  }
  assert.ok(views.length >= 8, views.join(', '));
  for (const file of views) {
    const page = read(file);
    const scripts = (page.match(/<script[^>]*>[\s\S]*?<\/script>/g) || []).join('\n');
    assert.ok(scripts.length > 0, `${file} has a script`);
    // A selector, the dataset or an attribute call; a comment may name it.
    assert.doesNotMatch(scripts, /\[data-i18n|dataset\.i18n|Attribute\(\s*['"]data-i18n/, file);
    const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    for (const [, id] of scripts.matchAll(/getElementById\('([^']+)'\)/g)) assert.ok(ids.has(id), `${file}: #${id}`);
  }
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
  assert.match(en.settings.log.hint, /device activity is shown\. Send the log privately to the developer on the forum, not in the thread\.$/);
  assert.equal(en.settings.otherDevice.report, 'Something not working? Report it in the forum thread.');
  assert.match(no.settings.log.hint, /når enhetene brukes\. Send loggen privat til utvikleren i forumet, ikke i tråden\.$/);
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

test('the texts of this round, as Trond worded them (2026-11-05)', () => {
  // In the account summary's format since 2026-11-06.
  assert.equal(no.settings.account.sg3, 'SG Smart 3.0: __devices__. Støttes ikke ennå.');
  assert.equal(en.settings.account.sg3, 'SG Smart 3.0: __devices__. Not supported yet.');
  // noDimmersFound and fetchAgain as Trond worded them 2026-11-07.
  assert.equal(no.pair.noDimmersFound, 'Fant ingen dimmere. Har du LEDDim Smart 3.0, velg LEDDim Smart 3.0 i stedet. Lukk SG-appen på telefonen. Prøv igjen nærmere en dimmer. Hjelper ikke det, send en diagnoserapport: Innstillinger, Apper, SG LEDDim.');
  assert.equal(en.pair.noDimmersFound, "No dimmers found. If you have LEDDim Smart 3.0, select LEDDim Smart 3.0 instead. Close the SG app on your phone. Try again closer to a dimmer. If that doesn't help, send a diagnostic report: Settings, Apps, SG LEDDim.");
  assert.equal(no.pair.guide.near, 'Ha Homey nær en av enhetene.');
  assert.equal(en.pair.guide.near, 'Keep Homey close to one of the devices.');
  assert.equal(no.pair.guide.fetchAgain, 'Har du lagt til enheter i SG-appen siden sist? Trykk "Hent på nytt" i innstillingene til SG LEDDim.');
  assert.equal(en.pair.guide.fetchAgain, 'Added devices in the SG app since the last fetch? Tap "Fetch again" in the SG LEDDim settings.');
  assert.equal(no.device.badMeshId, 'Enheten mangler gyldig mesh-ID. Slett den og legg den til på nytt.');
  assert.equal(en.device.badMeshId, 'The device has no valid mesh ID. Delete it and add it again.');
  const objectId = JSON.parse(read('drivers/sg_mesh/driver.settings.compose.json'))
    .flatMap((group) => group.children || []).find((setting) => setting.id === 'object_id');
  assert.deepEqual(objectId.hint, {
    en: "Leave at 0. Gen1 only: the mesh ID is normally read from the @NDxxxx name the device broadcasts. Set a value only if this doesn't work.",
    no: 'La stå på 0. Kun for Gen1: mesh-ID leses normalt fra @NDxxxx-navnet enheten sender ut. Sett en verdi bare hvis dette ikke virker.',
  });
  // "Show log" gives its time span as "Fetched" does, so its text says no UTC.
  assert.equal(no.settings.log.summary, 'Siste __count__ linjer, fra __from__ til __to__.');
  assert.equal(en.settings.log.summary, 'Last __count__ lines, from __from__ to __to__.');
});

test('the texts of 2026-11-07, as Trond worded them: the settings page, the pairing and the 3.0 warning', () => {
  const texts = {
    'settings.troubleshooting.hint': ['Slå på bare når utvikleren ber om det. Slå av igjen før du sender en diagnoserapport.',
      'Enable only when the developer asks. Disable it before sending a diagnostic report.'],
    'settings.log.hint': ['Viser de siste linjene i loggen. Bluetooth-adresser og enhetsnavn er skjult, men det vises når enhetene brukes. Send loggen privat til utvikleren i forumet, ikke i tråden.',
      'Shows the latest log lines. Bluetooth addresses and device names are hidden, but device activity is shown. Send the log privately to the developer on the forum, not in the thread.'],
    'settings.account.forgetConfirm': ['Fjerne alt som er hentet fra SG-kontoen? Enheter som trenger passordet derfra, vil slutte å svare.',
      'Remove all data fetched from the SG account? Devices that need its password will stop responding.'],
    'settings.log.empty': ['Loggen er tom. Bruk enhetene litt og prøv igjen.',
      'The log is empty. Use your devices for a while and try again.'],
    'settings.log.copyManual': ['Teksten er merket. Kopier med Ctrl+C eller hold fingeren på teksten.',
      'The text is selected. Copy with Ctrl+C or press and hold the text.'],
    'pair.members.hint': ['Velg dimmerne gruppen skal styre. De må være lagt til i Homey først.',
      'Select dimmers for the group. They must already be added to Homey.'],
    'pair.guide.closeApp': ['Lukk SG-appen på alle telefoner og nettbrett.', 'Close the SG app on all phones and tablets.'],
    'pair.guide.password': ['Nettverkspassordet er 1234 hvis du ikke har endret det i SG-appen.',
      'The network password is 1234 unless you changed it in the SG app.'],
    'pair.account.quiet': ['Disse enhetene i SG-kontoen svarte ikke: __devices__. Prøv igjen nærmere dem.',
      'These devices in your SG account did not respond: __devices__. Try again closer to them.'],
    'device.sg3NoNetwork': ['Logg inn med SG-kontoen i innstillingene til SG LEDDim.', 'Log in with your SG account in the SG LEDDim settings.'],
  };
  const get = (locale, key) => key.split('.').reduce((o, k) => o[k], locale);
  for (const [key, [noText, enText]] of Object.entries(texts)) {
    assert.equal(get(no, key), noText, `no ${key}`);
    assert.equal(get(en, key), enText, `en ${key}`);
  }
  // The settings are named as "SG LEDDim" everywhere in the app's own texts.
  for (const [language, locale] of [['no', no], ['en', en]]) {
    assert.doesNotMatch(JSON.stringify(locale), /appens innstillinger|the app settings/, language);
  }
  // The settings page's own text is the English one, until Homey fills it.
  const page = read('settings/index.html');
  for (const key of ['settings.account.intro', 'settings.keepConnected.hint', 'settings.sg3KeepConnected.hint', 'settings.signal.hint',
    'settings.troubleshooting.hint', 'settings.log.hint']) {
    assert.ok(page.includes(`<p data-i18n="${key}">${get(en, key)}</p>`), key);
  }
});
