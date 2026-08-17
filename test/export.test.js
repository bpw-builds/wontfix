'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ledger = require('../src/ledger');
const pack = require('../src/pack');
const exporter = require('../src/export');
const stats = require('../src/stats');

function tempRoot() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-export-')));
  fs.mkdirSync(path.join(dir, ledger.DIR_NAME));
  fs.writeFileSync(ledger.ledgerPath(dir), '', 'utf8');
  return dir;
}

function seed(root) {
  ledger.addEntry(root, {
    type: 'wontfix',
    title: 'redis for the job queue',
    why: '400ms cold start',
    durability: 'permanent',
    source: 'agent'
  });
  ledger.addEntry(root, { type: 'constraint', title: 'never touch billing directly' });
}

test('export block carries the rule, not a description', () => {
  const root = tempRoot();
  seed(root);
  const result = exporter.buildBlock(root, {});
  assert.match(result.text, /Rule: do not propose anything in the rejected list/);
  assert.match(result.text, /reason looks out of date/);
});

test('export defaults to a conservative budget and states it', () => {
  const root = tempRoot();
  seed(root);
  const result = exporter.buildBlock(root, {});
  assert.strictEqual(result.budget, 600);
  assert.match(result.text, /budget 600/);
});

test('export stamp shows the date and both counts', () => {
  const root = tempRoot();
  seed(root);
  const result = exporter.buildBlock(root, { now: '2026-08-17T10:00:00Z' });
  assert.match(result.text, /wontfix export: 2 of 2 entries, budget 600, 2026-08-17/);
});

test('export omission is reported inside the stamp', () => {
  const root = tempRoot();
  for (let i = 0; i < 40; i++) {
    ledger.addEntry(root, {
      type: i % 2 === 0 ? 'state' : 'wontfix',
      title: `entry number ${i} long enough to consume a real number of tokens`,
      why: 'a reason that costs tokens too'
    });
  }
  const result = exporter.buildBlock(root, { budget: 200 });
  assert.ok(result.dropped > 0);
  assert.match(result.text, /omitted \(/);
  assert.match(result.text, /Re-run "wontfix export"/);
});

test('the instruction line is charged against the budget', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) {
    entries.push({
      type: 'wontfix',
      title: `rejected approach ${i} with a title of realistic length`,
      why: 'it did not work for a specific and memorable reason',
      durability: 'permanent',
      created: '2026-08-16T00:00:00Z'
    });
  }
  const plain = pack.render(entries, { budget: 400 });
  const withRule = pack.render(entries, { budget: 400, instruction: exporter.INSTRUCTION });
  assert.ok(withRule.kept.length < plain.kept.length);
});

test('export writes a marker and staleness reads it back', () => {
  const root = tempRoot();
  seed(root);
  const result = exporter.buildBlock(root, {});
  exporter.writeMarker(root, {
    exported: result.exported,
    entries: result.total,
    packed: result.kept,
    budget: result.budget
  });
  assert.ok(fs.existsSync(exporter.markerPath(root)));
  assert.match(exporter.staleness(root).text, /current as of/);
});

test('staleness counts entries added after the export', () => {
  const root = tempRoot();
  const old = new Date(Date.now() - 86400000).toISOString();
  ledger.addEntry(root, { type: 'state', title: 'before the export', created: old });
  exporter.writeMarker(root, { exported: new Date(Date.now() - 1000).toISOString() });
  ledger.addEntry(root, { type: 'state', title: 'added later' });
  const result = exporter.staleness(root);
  assert.strictEqual(result.since, 1);
  assert.match(result.text, /1 entry added since your export/);
});

test('staleness ignores entries that predate the export', () => {
  const root = tempRoot();
  const old = new Date(Date.now() - 86400000).toISOString();
  ledger.addEntry(root, { type: 'state', title: 'old one', created: old });
  ledger.addEntry(root, { type: 'wontfix', title: 'also old', why: 'reason', created: old });
  exporter.writeMarker(root, { exported: new Date(Date.now() - 1000).toISOString() });
  const result = exporter.staleness(root);
  assert.strictEqual(result.since, 0);
  assert.match(result.text, /current as of/);
});

test('never exported is stated plainly', () => {
  const root = tempRoot();
  seed(root);
  assert.strictEqual(exporter.staleness(root).text, 'never exported');
});

test('a corrupt marker degrades to never exported', () => {
  const root = tempRoot();
  fs.writeFileSync(exporter.markerPath(root), '{ not json', 'utf8');
  assert.strictEqual(exporter.staleness(root).text, 'never exported');
});

test('stats includes the web export line', () => {
  const root = tempRoot();
  seed(root);
  assert.match(stats.render(root).text, /Web export\s+never exported/);
});

test('pack output is unchanged by the export additions', () => {
  const root = tempRoot();
  seed(root);
  const plain = pack.render(ledger.readEntries(root), { budget: 1200 });
  assert.match(plain.text, /<!-- wontfix: 2 of 2 entries packed\. Budget 1200\. -->/);
  assert.ok(!plain.text.includes('Rule:'));
});
