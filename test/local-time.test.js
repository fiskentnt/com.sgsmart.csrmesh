'use strict';

// "Fetched" on the settings page (2.7.0): the time of the fetch in Homey's
// time zone (homey.clock.getTimezone()), summer time included, made on Homey
// with Intl for the numbers and locales (time.*) for the words, in Homey's
// language (homey.__): "4. nov. kl. 06:40", "4 Nov, 06:40", the year only
// when it is not this year there. In UTC with " UTC" after it when Intl
// cannot do the zone. What is kept and logged stays ISO in UTC
// (lib/localTime.js). The time zones are real ones; the times are made up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fake = require('./helpers/fake-homey');

const { MONTHS, localText, localTime } = require('../lib/localTime');
const { SETTING, SgAccount } = require('../lib/account');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const LOCALES = { en: JSON.parse(read('locales/en.json')), no: JSON.parse(read('locales/no.json')) };

// homey.__ in language: the text at key with __token__ filled in, or the key
// when there is none.
const translator = (language) => (key, tokens = {}) => {
  const text = key.split('.').reduce((at, part) => (at && typeof at === 'object' ? at[part] : undefined), LOCALES[language]);
  if (typeof text !== 'string') return key;
  return text.replace(/__([a-z]+)__/g, (all, name) => (name in tokens ? String(tokens[name]) : all));
};

const NOW = new Date('2026-11-04T12:00:00.000Z');
const shown = (iso, zone, language = 'no', options = {}) => localText(localTime(iso, zone, { now: NOW, ...options }), translator(language));

test('the fetch at 05:40 UTC on 4 November 2026 shows as 06:40 in Oslo, in Norwegian and in English', () => {
  assert.equal(shown('2026-11-04T05:40:00.000Z', 'Europe/Oslo', 'no'), '4. nov. kl. 06:40');
  assert.equal(shown('2026-11-04T05:40:00.000Z', 'Europe/Oslo', 'en'), '4 Nov, 06:40');
  assert.deepEqual(localTime('2026-11-04T05:40:00.000Z', 'Europe/Oslo', { now: NOW }),
    { parts: { year: 2026, month: 11, day: 4, hour: 6, minute: 40 }, zoned: true, why: null, sameYear: true });
});

test('Oslo in winter (UTC+1) and in summer (UTC+2)', () => {
  assert.equal(shown('2026-01-15T06:40:00.000Z', 'Europe/Oslo'), '15. jan. kl. 07:40');
  assert.equal(shown('2026-07-15T06:40:00.000Z', 'Europe/Oslo'), '15. jul. kl. 08:40');
  assert.equal(shown('2026-07-15T06:40:00.000Z', 'Europe/Oslo', 'en'), '15 Jul, 08:40');
});

test('summer time starts and ends: the minute before and the minute after, in Oslo and New York', () => {
  // Oslo: 29 March 2026 at 01:00 UTC the clock goes from 02:00 to 03:00.
  assert.equal(shown('2026-03-29T00:59:00.000Z', 'Europe/Oslo'), '29. mar. kl. 01:59');
  assert.equal(shown('2026-03-29T01:00:00.000Z', 'Europe/Oslo'), '29. mar. kl. 03:00');
  // Oslo: 25 October 2026 at 01:00 UTC the clock goes from 03:00 back to 02:00.
  assert.equal(shown('2026-10-25T00:59:00.000Z', 'Europe/Oslo'), '25. okt. kl. 02:59');
  assert.equal(shown('2026-10-25T01:00:00.000Z', 'Europe/Oslo'), '25. okt. kl. 02:00');
  // New York changes on other days: 8 March 2026 at 07:00 UTC, 02:00 to 03:00.
  assert.equal(shown('2026-03-08T06:59:00.000Z', 'America/New_York', 'en'), '8 Mar, 01:59');
  assert.equal(shown('2026-03-08T07:00:00.000Z', 'America/New_York', 'en'), '8 Mar, 03:00');
  assert.equal(shown('2026-03-29T01:00:00.000Z', 'America/New_York', 'en'), '28 Mar, 21:00');
});

test('the year only when it is not this year in Homey\'s time zone', () => {
  assert.equal(shown('2025-11-04T05:40:00.000Z', 'Europe/Oslo', 'no'), '4. nov. 2025 kl. 06:40');
  assert.equal(shown('2025-11-04T05:40:00.000Z', 'Europe/Oslo', 'en'), '4 Nov 2025, 06:40');
  // 23:00 on 31 December 2026 in Oslo, seen at 00:30 on 1 January 2027 there
  // (still 2026 in UTC): last year, so with the year.
  const newYear = { now: new Date('2026-12-31T23:30:00.000Z') };
  assert.equal(shown('2026-12-31T22:00:00.000Z', 'Europe/Oslo', 'no', newYear), '31. des. 2026 kl. 23:00');
  // 00:15 on 1 January 2027 in Oslo, seen at 00:30 there: this year.
  assert.equal(shown('2026-12-31T23:15:00.000Z', 'Europe/Oslo', 'no', newYear), '1. jan. kl. 00:15');
  // New York is still in 2026 then: the same fetch is this year there too.
  assert.equal(shown('2026-12-31T22:00:00.000Z', 'America/New_York', 'en', newYear), '31 Dec, 17:00');
});

test('the day and the month change with the zone; midnight is 00, not 24', () => {
  assert.equal(shown('2026-11-04T23:30:00.000Z', 'Europe/Oslo'), '5. nov. kl. 00:30');
  assert.equal(shown('2026-11-04T23:00:00.000Z', 'Europe/Oslo'), '5. nov. kl. 00:00');
  assert.equal(shown('2026-11-01T02:00:00.000Z', 'America/New_York', 'en'), '31 Oct, 22:00');
});

test('other zones: southern summer, half and quarter hours, UTC itself; seconds are cut, not rounded', () => {
  assert.equal(shown('2026-01-15T06:40:00.000Z', 'Australia/Sydney', 'en'), '15 Jan, 17:40');
  assert.equal(shown('2026-07-15T06:40:00.000Z', 'Australia/Sydney', 'en'), '15 Jul, 16:40');
  assert.equal(shown('2026-11-04T06:40:00.000Z', 'Asia/Kolkata', 'en'), '4 Nov, 12:10');
  assert.equal(shown('2026-11-04T06:40:00.000Z', 'Asia/Kathmandu', 'en'), '4 Nov, 12:25');
  assert.equal(shown('2026-11-04T06:40:00.000Z', 'UTC', 'en'), '4 Nov, 06:40');
  assert.equal(shown('2026-11-04T05:40:59.999Z', 'Europe/Oslo'), '4. nov. kl. 06:40');
});

test('the twelve months come from locales, in both languages', () => {
  assert.deepEqual(Object.keys(LOCALES.en.time.months), MONTHS);
  assert.deepEqual(Object.keys(LOCALES.no.time.months), MONTHS);
  const months = (language) => MONTHS.map((key, i) => shown(`2026-${String(i + 1).padStart(2, '0')}-15T12:00:00.000Z`, 'UTC', language));
  assert.deepEqual(months('en'), ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m) => `15 ${m}, 12:00`));
  assert.deepEqual(months('no'), ['jan.', 'feb.', 'mar.', 'apr.', 'mai', 'jun.', 'jul.', 'aug.', 'sep.', 'okt.', 'nov.', 'des.']
    .map((m) => `15. ${m} kl. 12:00`));
  for (const language of ['en', 'no']) {
    assert.deepEqual(Object.keys(LOCALES[language].time).sort(), ['months', 'otherYear', 'sameYear']);
  }
});

test('the reserve: without a zone, with an unknown zone, or without Intl, the same form in UTC with UTC after it', () => {
  const iso = '2026-11-04T05:40:00.000Z';
  for (const zone of [null, '', undefined, 'Not/A_Zone']) {
    assert.equal(shown(iso, zone, 'no'), '4. nov. kl. 05:40 UTC');
    assert.equal(shown(iso, zone, 'en'), '4 Nov, 05:40 UTC');
  }
  assert.equal(localTime(iso, null, { now: NOW }).why, 'no time zone');
  assert.equal(localTime(iso, 'Not/A_Zone', { now: NOW }).why, 'Intl failed (RangeError)');
  assert.equal(shown(iso, 'Europe/Oslo', 'no', { intl: undefined }), '4. nov. kl. 06:40');
  for (const intl of [{}, null]) {
    assert.equal(shown(iso, 'Europe/Oslo', 'no', { intl }), '4. nov. kl. 05:40 UTC');
    assert.equal(localTime(iso, 'Europe/Oslo', { now: NOW, intl }).why, 'Intl failed (TypeError)');
  }
  // A runtime without time zone data refuses the zone.
  const noZones = { DateTimeFormat: function DateTimeFormat() { throw new RangeError('Invalid time zone specified'); } };
  assert.equal(shown(iso, 'Europe/Oslo', 'en', { intl: noZones }), '4 Nov, 05:40 UTC');
  // The year in the reserve is the UTC year, against now in UTC.
  assert.equal(shown('2025-11-04T05:40:00.000Z', null, 'no'), '4. nov. 2025 kl. 05:40 UTC');
  assert.equal(shown('2026-12-31T23:15:00.000Z', null, 'en', { now: new Date('2027-01-01T00:30:00.000Z') }), '31 Dec 2026, 23:15 UTC');
  // Not a time: nothing to show.
  assert.equal(shown('not a time', 'Europe/Oslo'), null);
  assert.equal(shown(null, 'Europe/Oslo'), null);
});

test('without the texts in locales: "YYYY-MM-DD HH:MM", with UTC after it for the reserve', () => {
  const none = (key) => key;
  const iso = '2026-11-04T05:40:00.000Z';
  assert.equal(localText(localTime(iso, 'Europe/Oslo', { now: NOW }), none), '2026-11-04 06:40');
  assert.equal(localText(localTime(iso, null, { now: NOW }), none), '2026-11-04 05:40 UTC');
  assert.equal(localText(localTime(iso, 'Europe/Oslo', { now: NOW }), () => undefined), '2026-11-04 06:40');
});

// An Intl whose DateTimeFormat gives these parts, whatever it is asked.
const intlGiving = (parts) => ({ DateTimeFormat: function DateTimeFormat() { return { formatToParts: () => parts }; } });
const partsOf = (year, month, day, hour, minute) => [
  { type: 'month', value: month }, { type: 'literal', value: '/' }, { type: 'day', value: day },
  { type: 'literal', value: '/' }, { type: 'year', value: year }, { type: 'literal', value: ', ' },
  { type: 'hour', value: hour }, { type: 'literal', value: ':' }, { type: 'minute', value: minute },
];

test('numbers from Intl that make no time give the reserve; 24 for midnight is taken as 00', () => {
  const iso = '2026-11-04T23:30:00.000Z';
  const reserve = '4. nov. kl. 23:30 UTC';
  const at = (parts) => shown(iso, 'Europe/Oslo', 'no', { intl: intlGiving(parts) });
  assert.equal(at(partsOf('2026', '11', '05', '24', '30')), '5. nov. kl. 00:30');
  assert.equal(at(partsOf('2026', '11', '05', '99', '30')), reserve);
  assert.equal(at(partsOf('2026', '11', '05', '25', '30')), reserve);
  assert.equal(at(partsOf('2026', '11', '04', '24', '90')), reserve, 'minute 90');
  assert.equal(at(partsOf('2026', '13', '05', '00', '30')), reserve, 'month 13');
  assert.equal(at(partsOf('2026', '11', '00', '00', '30')), reserve, 'day 0');
  assert.equal(at(partsOf('2026', '11', '06', '00', '30')), reserve, 'a day off');
  assert.equal(at(partsOf('2026', '11', '05', '00', '37')), reserve, 'not on a quarter hour');
  assert.equal(at(partsOf('2026', '11', '05', '00', 'x')), reserve);
  assert.equal(at([]), reserve);
  assert.equal(at(null), reserve);
  assert.equal(localTime(iso, 'Europe/Oslo', { now: NOW, intl: intlGiving([]) }).why, 'Intl gave no usable time');
});

// An app as SgAccount needs it for a fetch, with no devices, Homey's clock
// giving zone (or throwing it, when it is an Error), and homey.__ in
// language.
function clockApp(zone, language = 'no') {
  const app = {
    logs: [],
    errors: [],
    log(...args) { app.logs.push(args.join(' ')); },
    error(...args) { app.errors.push(args.join(' ')); },
    _devices: () => [],
    recentlyHeard: () => false,
    knownLocations: () => [],
    csr: { nodes: new Map(), requestStatus: async () => true },
  };
  const values = new Map();
  const settings = { values, get: (k) => (values.has(k) ? values.get(k) : null), set: (k, v) => values.set(k, v), unset: (k) => values.delete(k) };
  const extra = { settings, __: translator(language) };
  if (zone !== undefined) extra.clock = { getTimezone: () => { if (zone instanceof Error) throw zone; return zone; } };
  app.homey = fake.fakeHomey(app, extra);
  const home = { passphrase: null, netKey: null, appKey: null, locationId: null, devices: [] };
  app.account = new SgAccount(app, { fetch: async () => ({ homes: [home], loggedOut: true }) });
  return app;
}

const login = (app) => app.account.login('tester@example.invalid', 'made-up pass 7');

test('the summary: fetchedAt stays ISO in UTC, as it is kept; fetchedAtShown is in Homey\'s time zone and language', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T05:40:12.345Z') });
  const app = clockApp('Europe/Oslo', 'no');
  const summary = await login(app);
  assert.equal(summary.fetchedAt, '2026-11-04T05:40:12.345Z');
  assert.equal(summary.fetchedAtShown, '4. nov. kl. 06:40');
  assert.equal(app.homey.settings.values.get(SETTING).fetchedAt, '2026-11-04T05:40:12.345Z');
  assert.ok(!JSON.stringify(app.homey.settings.values.get(SETTING)).includes('06:40'), 'the shown time is not kept');
  const english = clockApp('Europe/Oslo', 'en');
  assert.equal((await login(english)).fetchedAtShown, '4 Nov, 06:40');
});

test('the summary follows Homey\'s time zone when it changes, and the year when a new one has begun', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-15T06:40:00.000Z') });
  let zone = 'Europe/Oslo';
  const app = clockApp('Europe/Oslo', 'en');
  app.homey.clock.getTimezone = () => zone;
  await login(app);
  assert.equal(app.account.summary().fetchedAtShown, '15 Jan, 07:40');
  zone = 'America/New_York';
  assert.equal(app.account.summary().fetchedAtShown, '15 Jan, 01:40');
  assert.equal(app.account.summary().fetchedAt, '2026-01-15T06:40:00.000Z');
  t.mock.timers.setTime(Date.parse('2027-02-01T12:00:00.000Z'));
  assert.equal(app.account.summary().fetchedAtShown, '15 Jan 2026, 01:40');
});

test('without Homey\'s clock, or when it fails or gives an unknown zone: UTC with UTC after it, and the log says why once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T05:40:00.000Z') });
  for (const [zone, why] of [[undefined, 'no time zone'], [new Error('made-up'), 'no time zone'], [42, 'no time zone'],
    ['Not/A_Zone', 'Intl failed (RangeError)']]) {
    const app = clockApp(zone, 'no');
    await login(app);
    for (let i = 0; i < 3; i += 1) assert.equal(app.account.summary().fetchedAtShown, '4. nov. kl. 05:40 UTC');
    const said = app.logs.filter((line) => line.includes('fetched time'));
    assert.deepEqual(said, [`[SG account] the fetched time is shown in UTC (${why})`]);
  }
});

test('the log says once that Homey\'s time zone is used, and never names the zone', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T05:40:00.000Z') });
  const app = clockApp('Europe/Oslo');
  await login(app);
  for (let i = 0; i < 3; i += 1) app.account.summary();
  assert.deepEqual(app.logs.filter((line) => line.includes('fetched time')), ['[SG account] the fetched time is shown in Homey\'s time zone']);
  assert.ok(![...app.logs, ...app.errors].some((line) => /Europe|Oslo/.test(line)));
  // Before a fetch there is no time, and nothing is said.
  const before = clockApp('Europe/Oslo');
  assert.equal(before.account.summary().fetchedAtShown, undefined);
  assert.deepEqual(before.logs.filter((line) => line.includes('fetched time')), []);
});

test('the settings page shows fetchedAtShown for "Fetched", and "Show log" its time span the same way', () => {
  const page = read('settings/index.html');
  assert.ok(page.includes("Homey.__('settings.account.fetchedAt', { when: summary.fetchedAtShown || when(summary.fetchedAt) })"));
  assert.ok(page.includes("const when = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '?');"));
  assert.ok(page.includes('count: result.count, from: result.fromShown || when(result.from), to: result.toShown || when(result.to),'));
});

test('"Show log": the span in Homey\'s time zone and language as "Fetched", in UTC marked "UTC" without a zone that works', () => {
  fake.install();
  const SGSmartApp = require('../app');
  const appIn = (zone, language) => {
    const app = Object.create(SGSmartApp.prototype);
    app.homey = { clock: { getTimezone: () => zone }, __: translator(language) };
    return app;
  };
  // Today's year is not shown; another year is.
  const year = new Date().getUTCFullYear();
  assert.equal(appIn('Europe/Oslo', 'no')._shownTime(`${year}-11-05T18:38:32.050Z`), '5. nov. kl. 19:38');
  assert.equal(appIn('Europe/Oslo', 'en')._shownTime(`${year}-11-05T18:38:32.050Z`), '5 Nov, 19:38');
  assert.equal(appIn('Not/AZone', 'no')._shownTime(`${year}-11-05T18:38:32.050Z`), '5. nov. kl. 18:38 UTC');
  assert.equal(appIn('Europe/Oslo', 'no')._shownTime(null), null);
});
