'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ledger = require('../src/ledger');
const redact = require('../src/redact');
const backfill = require('../src/backfill');
const why = require('../src/why');
const stats = require('../src/stats');
const { init } = require('../src/init');

function tempRoot() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-sec-')));
  fs.mkdirSync(path.join(dir, ledger.DIR_NAME));
  fs.writeFileSync(ledger.ledgerPath(dir), '', 'utf8');
  return dir;
}

function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-git-')));
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['remote', 'add', 'origin', 'git@github.com:acme/thing.git']);
  return { dir, run };
}

function commit(repo, subject, body) {
  fs.writeFileSync(path.join(repo.dir, `f${Date.now()}${Math.random()}.txt`), 'x');
  repo.run(['add', '-A']);
  const args = ['commit', '-q', '-m', subject];
  if (body) args.push('-m', body);
  repo.run(args);
}

// Redaction

test('scrubs credentials with recognizable prefixes', () => {
  // Assembled from parts on purpose. These are fake, but a literal with the
  // real shape trips GitHub push protection and every other secret scanner,
  // which blocks the push and teaches the wrong lesson about unblocking.
  const cases = [
    'sk-' + 'ant-api03-AbCdEf1234567890XyZq',
    'ghp' + '_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    'github' + '_pat_11ABCDEFG0abcdefghijklmnop',
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'AIza' + 'SyA1234567890abcdefghijklmnopqrstuvw',
    'xoxb' + '-123456789012-abcdefghijklmnop',
    'sk' + '_live_51ABCdefGHIjklMNOpqrs',
    'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  ];
  for (const secret of cases) {
    const result = redact.redact(`we leaked ${secret} in the log`);
    assert.ok(result.hits > 0, `missed ${secret}`);
    assert.ok(!result.text.includes(secret), `left ${secret} in place`);
  }
});

test('ordinary debugging prose survives untouched', () => {
  const safe = [
    'the key was wrong so we regenerated it',
    'sk- prefixed keys are annoying to rotate',
    'AKIA is the prefix for AWS access key ids',
    'the bearer token expired after an hour',
    'switched from mongo to postgres for transactions',
    'reduced bundle by 40kb after dropping zod'
  ];
  for (const text of safe) {
    const result = redact.redact(text);
    assert.strictEqual(result.hits, 0, `false positive on: ${text}`);
    assert.strictEqual(result.text, text);
  }
});

test('connection string credentials are replaced, host is kept', () => {
  const result = redact.redact('postgres://admin:hunter2@db.internal:5432/app');
  assert.match(result.text, /db\.internal:5432\/app/);
  assert.ok(!result.text.includes('hunter2'));
});

test('secrets never reach disk', () => {
  const root = tempRoot();
  ledger.addEntry(root, {
    type: 'wontfix',
    title: 'hardcoded ' + 'ghp' + '_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 in the client',
    why: 'it shipped to prod'
  });
  const raw = fs.readFileSync(ledger.ledgerPath(root), 'utf8');
  assert.ok(!raw.includes('ghp' + '_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'));
  assert.match(raw, /ghX-REDACTED/);
  assert.match(raw, /"redacted":true/);
});

// Backfill

test('reverts become rejected approaches', () => {
  const guess = backfill.classify({
    subject: 'Revert "add caching layer"',
    body: 'Cache invalidation broke on every deploy.'
  });
  assert.strictEqual(guess.type, 'wontfix');
  assert.strictEqual(guess.title, 'add caching layer');
  assert.match(guess.why, /invalidation/);
});

test('routine commits are ignored', () => {
  assert.strictEqual(backfill.classify({ subject: 'fix: typo in readme', body: '' }), null);
  assert.strictEqual(backfill.classify({ subject: 'chore(deps): bump lodash', body: '' }), null);
});

test('trailers are not mistaken for reasons', () => {
  const reason = backfill.reasonFrom('Co-authored-by: Someone <a@b.co>\nSigned-off-by: Other <c@d.co>');
  assert.strictEqual(reason, null);
});

test('propose writes nothing', () => {
  const repo = gitRepo();
  commit(repo, 'feat: add caching layer');
  commit(repo, 'Revert "feat: add caching layer"', 'Stale reads for 20 minutes.');
  init(repo.dir, {});
  const before = fs.readFileSync(ledger.ledgerPath(repo.dir), 'utf8');
  const result = backfill.propose(repo.dir, {});
  assert.ok(result.candidates.length > 0);
  assert.strictEqual(fs.readFileSync(ledger.ledgerPath(repo.dir), 'utf8'), before);
});

test('apply drops candidates with no reason', () => {
  const repo = gitRepo();
  commit(repo, 'Revert "bump deps"');
  commit(repo, 'Revert "add caching layer"', 'Stale reads for 20 minutes.');
  init(repo.dir, {});
  const result = backfill.propose(repo.dir, {});
  const applied = backfill.apply(repo.dir, result.candidates);
  assert.strictEqual(applied.written.length, 1);
  assert.strictEqual(applied.skipped.length, 1);
  assert.match(applied.written[0].why, /Stale reads/);
});

test('backfilled entries are tagged git and stay out of the agent share', () => {
  const root = tempRoot();
  ledger.addEntry(root, { type: 'wontfix', title: 'mined', why: 'from history', source: 'git' });
  ledger.addEntry(root, { type: 'state', title: 'written by the agent', source: 'agent' });
  const s = stats.summarize(root);
  assert.strictEqual(s.bySource.git, 1);
  assert.strictEqual(s.bySource.agent, 1);
  assert.strictEqual(s.authored, 1);
  assert.strictEqual(s.agentShare, 1);
});

test('an unknown source falls back to human', () => {
  const root = tempRoot();
  const entry = ledger.addEntry(root, { type: 'state', title: 'x', source: 'robot' });
  assert.strictEqual(entry.source, 'human');
});

test('backfill on a folder with no git history is handled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-nogit-'));
  assert.strictEqual(backfill.propose(dir, {}).supported, false);
});

// why

test('why finds an entry and cites the commit', () => {
  const repo = gitRepo();
  init(repo.dir, {});
  ledger.addEntry(repo.dir, {
    type: 'wontfix',
    title: 'redis for the job queue',
    why: '400ms cold start'
  });
  repo.run(['add', '-A']);
  repo.run(['commit', '-q', '-m', 'record decision']);

  const result = why.render(repo.dir, 'redis');
  assert.ok(result.found);
  assert.match(result.text, /400ms cold start/);
  assert.match(result.text, /https:\/\/github\.com\/acme\/thing\/blob\/[0-9a-f]{40}\//);
});

test('why reports honestly when the entry is not committed yet', () => {
  const repo = gitRepo();
  init(repo.dir, {});
  ledger.addEntry(repo.dir, { type: 'wontfix', title: 'zod', why: 'bundle size' });
  const result = why.render(repo.dir, 'zod');
  assert.match(result.text, /not yet committed/);
});

test('why says so when nothing matches', () => {
  const root = tempRoot();
  ledger.addEntry(root, { type: 'state', title: 'something else' });
  const result = why.render(root, 'kafka');
  assert.strictEqual(result.found, false);
  assert.match(result.text, /No entry matches/);
});

test('ssh remotes become https permalinks', () => {
  const repo = gitRepo();
  assert.strictEqual(why.remoteBase(repo.dir), 'https://github.com/acme/thing');
});

// init defaults

test('init writes AGENTS.md only by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-guid-'));
  init(root, {});
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')));
  assert.ok(!fs.existsSync(path.join(root, '.cursor', 'rules', 'wontfix.mdc')));
});

test('extra guidance targets are opt in', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-guid2-'));
  init(root, { guidance: ['agents', 'claude', 'cursor'] });
  assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(root, '.cursor', 'rules', 'wontfix.mdc')));
});

test('why prints every match, not just the closest', () => {
  const root = tempRoot();
  ledger.addEntry(root, { type: 'wontfix', title: 'redis for the job queue', why: 'cold start' });
  ledger.addEntry(root, { type: 'wontfix', title: 'redis for session storage', why: 'eviction bugs' });
  ledger.addEntry(root, { type: 'decision', title: 'postgres over mongo', why: 'transactions' });
  const result = why.render(root, 'redis');
  assert.match(result.text, /2 entries match "redis"/);
  assert.match(result.text, /job queue/);
  assert.match(result.text, /session storage/);
  assert.ok(!result.text.includes('postgres'));
});

test('a single match is printed without a count header', () => {
  const root = tempRoot();
  ledger.addEntry(root, { type: 'wontfix', title: 'kafka', why: 'ops burden' });
  assert.ok(!why.render(root, 'kafka').text.includes('entries match'));
});

test('the redaction count comes back to the caller', () => {
  const root = tempRoot();
  const entry = ledger.addEntry(root, {
    type: 'wontfix',
    title: 'leaked ' + 'ghp' + '_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    why: 'and also ' + 'AKIA' + 'IOSFODNN7EXAMPLE was in there'
  });
  assert.strictEqual(entry.redactedCount, 2);
  assert.strictEqual(entry.redacted, true);
});

test('short handles stay unique across rapid writes', () => {
  const root = tempRoot();
  const handles = new Set();
  for (let i = 0; i < 200; i++) {
    const entry = ledger.addEntry(root, { type: 'state', title: `entry ${i}` });
    handles.add(ledger.shortId(entry.id));
  }
  assert.strictEqual(handles.size, 200);
});

test('an ambiguous id is refused rather than guessed', () => {
  const root = tempRoot();
  const a = ledger.addEntry(root, { type: 'state', title: 'a' });
  ledger.addEntry(root, { type: 'state', title: 'b' });
  const prefix = a.id.slice(0, 6);
  assert.throws(() => ledger.revoke(root, prefix), /matches \d+ entries/);
});

test('revoke works from the short handle', () => {
  const root = tempRoot();
  const entry = ledger.addEntry(root, { type: 'state', title: 'gone' });
  ledger.revoke(root, ledger.shortId(entry.id));
  assert.strictEqual(ledger.readEntries(root).length, 0);
});

test('backfill scrubs secrets before printing a preview', () => {
  const repo = gitRepo();
  commit(repo, 'Revert "add s3 upload"', 'The key ' + 'AKIA' + 'IOSFODNN7EXAMPLE was hardcoded and leaked.');
  init(repo.dir, {});
  const result = backfill.propose(repo.dir, {});
  const candidate = result.candidates[0];
  assert.ok(!candidate.why.includes('AKIA' + 'IOSFODNN7EXAMPLE'));
  assert.match(candidate.why, /AKIA-REDACTED/);
  assert.strictEqual(candidate.redactedCount, 1);
});

test('backfill reports how many secrets it scrubbed on apply', () => {
  const repo = gitRepo();
  commit(repo, 'Revert "add s3 upload"', 'Leaked ' + 'AKIA' + 'IOSFODNN7EXAMPLE in the logs.');
  init(repo.dir, {});
  const result = backfill.propose(repo.dir, {});
  const applied = backfill.apply(repo.dir, result.candidates);
  assert.strictEqual(applied.written.length, 1);
  const raw = fs.readFileSync(ledger.ledgerPath(repo.dir), 'utf8');
  assert.ok(!raw.includes('AKIA' + 'IOSFODNN7EXAMPLE'));
});
