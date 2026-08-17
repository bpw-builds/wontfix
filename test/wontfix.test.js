'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ledger = require('../src/ledger');
const pack = require('../src/pack');
const { init, MARKER } = require('../src/init');

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-'));
  fs.mkdirSync(path.join(dir, ledger.DIR_NAME));
  fs.writeFileSync(ledger.ledgerPath(dir), '', 'utf8');
  return fs.realpathSync(dir);
}

test('adds and reads an entry', () => {
  const root = tempRoot();
  ledger.addEntry(root, { type: 'wontfix', title: 'redis queue', why: 'cold start' });
  const entries = ledger.readEntries(root);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].title, 'redis queue');
  assert.strictEqual(entries[0].durability, 'until-changed');
});

test('requires why on wontfix and decision', () => {
  const root = tempRoot();
  assert.throws(() => ledger.addEntry(root, { type: 'wontfix', title: 'x' }), /why/);
  assert.throws(() => ledger.addEntry(root, { type: 'decision', title: 'x' }), /why/);
  assert.doesNotThrow(() => ledger.addEntry(root, { type: 'state', title: 'x' }));
});

test('rejects unknown types', () => {
  const root = tempRoot();
  assert.throws(() => ledger.addEntry(root, { type: 'nonsense', title: 'x' }), /type must be/);
});

test('revoking hides an entry without deleting the line', () => {
  const root = tempRoot();
  const entry = ledger.addEntry(root, { type: 'state', title: 'auth half migrated' });
  ledger.revoke(root, entry.id);
  assert.strictEqual(ledger.readEntries(root).length, 0);
  assert.strictEqual(ledger.readRaw(root).length, 2);
});

test('newest line wins for a repeated id', () => {
  const root = tempRoot();
  const entry = ledger.addEntry(root, { type: 'state', title: 'first' });
  fs.appendFileSync(
    ledger.ledgerPath(root),
    JSON.stringify(Object.assign({}, entry, { title: 'second' })) + '\n'
  );
  const entries = ledger.readEntries(root);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].title, 'second');
});

test('corrupt lines are skipped, not fatal', () => {
  const root = tempRoot();
  ledger.addEntry(root, { type: 'state', title: 'good' });
  fs.appendFileSync(ledger.ledgerPath(root), '{ this is not json\n');
  assert.strictEqual(ledger.readEntries(root).length, 1);
});

test('session entries decay after the window', () => {
  const root = tempRoot();
  const old = new Date(Date.now() - 20 * 86400000).toISOString();
  ledger.addEntry(root, {
    type: 'state',
    title: 'stale note',
    durability: 'session',
    created: old
  });
  assert.strictEqual(ledger.readEntries(root).length, 0);
  assert.strictEqual(ledger.readEntries(root, { includeStale: true }).length, 1);
});

test('ranking puts wontfix above state', () => {
  const entries = [
    { type: 'state', title: 's', durability: 'until-changed', created: '2026-08-16T00:00:00Z' },
    { type: 'wontfix', title: 'w', durability: 'session', created: '2020-01-01T00:00:00Z' }
  ];
  const ranked = pack.rank(entries);
  assert.strictEqual(ranked[0].type, 'wontfix');
});

test('permanent outranks session within a type', () => {
  const entries = [
    { type: 'decision', title: 'a', durability: 'session', created: '2026-08-16T00:00:00Z' },
    { type: 'decision', title: 'b', durability: 'permanent', created: '2020-01-01T00:00:00Z' }
  ];
  assert.strictEqual(pack.rank(entries)[0].title, 'b');
});

test('scope match wins over type weight', () => {
  const entries = [
    { type: 'wontfix', title: 'w', durability: 'permanent', created: '2026-08-16T00:00:00Z' },
    {
      type: 'state',
      title: 's',
      scope: 'src/api',
      durability: 'session',
      created: '2026-08-16T00:00:00Z'
    }
  ];
  assert.strictEqual(pack.rank(entries, 'src/api')[0].title, 's');
});

test('budget drops the lowest ranked entries first', () => {
  const entries = [];
  for (let i = 0; i < 40; i++) {
    entries.push({
      type: i % 2 === 0 ? 'state' : 'wontfix',
      title: `entry number ${i} with some length to it so tokens add up`,
      why: 'a reason that also costs tokens',
      durability: 'until-changed',
      created: '2026-08-16T00:00:00Z'
    });
  }
  const result = pack.render(entries, { budget: 300 });
  assert.ok(result.dropped.length > 0);
  assert.ok(result.kept.every((e) => e.type === 'wontfix'));
  assert.match(result.text, /omitted/);
});

test('pack output names the rejected section', () => {
  const entries = [
    {
      type: 'wontfix',
      title: 'redis queue',
      why: 'cold start',
      durability: 'permanent',
      created: '2026-08-16T00:00:00Z'
    }
  ];
  const result = pack.render(entries, { budget: 1200 });
  assert.match(result.text, /Do not propose these again/);
  assert.match(result.text, /Reason: cold start/);
});

test('empty ledger still produces valid output', () => {
  const result = pack.render([], { budget: 1200 });
  assert.match(result.text, /No entries recorded yet/);
});

test('init writes rules once and is safe to run twice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-init-'));
  init(root, { guidance: ['claude', 'cursor'] });
  const first = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  init(root, { guidance: ['claude', 'cursor'] });
  const second = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.strictEqual(first, second);
  assert.ok(fs.existsSync(path.join(root, '.cursor', 'rules', 'wontfix.mdc')));
  assert.ok(first.includes(MARKER));
});

test('init preserves existing CLAUDE.md content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-keep-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# My project\n\nSome notes.\n', 'utf8');
  init(root, { guidance: ['claude'] });
  const text = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.match(text, /Some notes/);
  assert.match(text, /Context ledger/);
});

test('private mode gitignores the ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-priv-'));
  init(root, { private: true });
  const text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(text, /\.wontfix\//);
});

test('findRoot walks up to the folder holding .wontfix', () => {
  const root = tempRoot();
  const nested = path.join(root, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  assert.strictEqual(ledger.findRoot(nested), fs.realpathSync(root));
});
