'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ledger = require('../src/ledger');
const hook = require('../src/hook');
const stats = require('../src/stats');

function tempRoot() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-hook-')));
  fs.mkdirSync(path.join(dir, ledger.DIR_NAME));
  fs.writeFileSync(ledger.ledgerPath(dir), '', 'utf8');
  return dir;
}

function readSettings(root, target) {
  return JSON.parse(fs.readFileSync(hook.configPath(root, target || 'claude', false), 'utf8'));
}

test('install creates settings.json with a SessionStart hook', () => {
  const root = tempRoot();
  const result = hook.install(root, { tools: ['claude'] })[0];
  assert.strictEqual(result.status, 'installed');
  const settings = readSettings(root);
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /wontfix hook run/);
  assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].type, 'command');
});

test('install is idempotent', () => {
  const root = tempRoot();
  hook.install(root, { tools: ['claude'] })[0];
  const second = hook.install(root, { tools: ['claude'] })[0];
  assert.strictEqual(second.status, 'already installed');
  assert.strictEqual(readSettings(root).hooks.SessionStart.length, 1);
});

test('install preserves unrelated settings and other hooks', () => {
  const root = tempRoot();
  const file = hook.configPath(root, 'claude', false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo guard' }] }]
      }
    }),
    'utf8'
  );

  hook.install(root, { tools: ['claude'] })[0];
  const settings = readSettings(root);
  assert.deepStrictEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
  assert.strictEqual(settings.hooks.PreToolUse.length, 1);
  assert.strictEqual(settings.hooks.SessionStart.length, 2);
  assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'echo hello');
});

test('remove takes out only our hook', () => {
  const root = tempRoot();
  const file = hook.configPath(root, 'claude', false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }] }
    }),
    'utf8'
  );
  hook.install(root, { tools: ['claude'] })[0];
  hook.remove(root, { tools: ['claude'] })[0];
  const settings = readSettings(root);
  assert.strictEqual(settings.hooks.SessionStart.length, 1);
  assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'echo hello');
});

test('remove cleans up an empty hooks object', () => {
  const root = tempRoot();
  hook.install(root, { tools: ['claude'] })[0];
  hook.remove(root, { tools: ['claude'] })[0];
  assert.deepStrictEqual(readSettings(root), {});
});

test('malformed settings.json is refused, not overwritten', () => {
  const root = tempRoot();
  const file = hook.configPath(root, 'claude', false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ broken json', 'utf8');
  assert.match(hook.install(root, { tools: ['claude'] })[0].status, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ broken json');
});

test('local flag targets settings.local.json', () => {
  const root = tempRoot();
  hook.install(root, { tools: ['claude'], local: true })[0];
  assert.ok(fs.existsSync(hook.configPath(root, 'claude', true)));
  assert.ok(!fs.existsSync(hook.configPath(root, 'claude', false)));
});

test('hook payload carries the pack output', () => {
  const root = tempRoot();
  ledger.addEntry(root, { type: 'wontfix', title: 'redis queue', why: 'cold start' });
  const payload = hook.runPayload(root, {});
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(payload.hookSpecificOutput.additionalContext, /redis queue/);
});

test('hook payload is valid and empty when there is no ledger', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wontfix-none-'));
  const payload = hook.runPayload(root, {});
  assert.strictEqual(payload.hookSpecificOutput.additionalContext, '');
});

test('hook payload is capped', () => {
  const root = tempRoot();
  for (let i = 0; i < 400; i++) {
    ledger.addEntry(root, {
      type: 'wontfix',
      title: `a fairly long rejected approach number ${i} with detail`,
      why: 'it was slow in a way that took a whole afternoon to discover'
    });
  }
  const payload = hook.runPayload(root, { budget: 100000 });
  const size = Buffer.byteLength(payload.hookSpecificOutput.additionalContext, 'utf8');
  assert.ok(size <= hook.MAX_CONTEXT_BYTES + 40);
});

test('stats separate agent writes from human writes', () => {
  const root = tempRoot();
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  ledger.addEntry(root, { type: 'state', title: 'a', source: 'agent', created: old });
  ledger.addEntry(root, { type: 'state', title: 'b', source: 'agent' });
  ledger.addEntry(root, { type: 'state', title: 'c', source: 'human' });
  const s = stats.summarize(root);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.bySource.agent, 2);
  assert.strictEqual(s.bySource.human, 1);
  assert.strictEqual(s.last7, 2);
  assert.strictEqual(s.last7Agent, 1);
});

test('stats count revoked and decayed entries as written', () => {
  const root = tempRoot();
  const entry = ledger.addEntry(root, { type: 'state', title: 'gone', source: 'agent' });
  ledger.revoke(root, entry.id);
  const s = stats.summarize(root);
  assert.strictEqual(s.total, 1);
  assert.strictEqual(s.live, 0);
});

test('verdict calls out a ledger the agent is ignoring', () => {
  const s = { total: 4, spanDays: 14, agentPerWeek: 0, agentShare: 0 };
  assert.match(stats.verdict(s), /not writing entries/);
  const healthy = { total: 20, spanDays: 14, agentPerWeek: 5, agentShare: 0.8 };
  assert.match(stats.verdict(healthy), /Healthy/);
});

test('installAll writes configs for all three tools', () => {
  const root = tempRoot();
  const results = hook.install(root, {});
  assert.strictEqual(results.length, 3);
  assert.ok(results.every((r) => r.status === 'installed'));

  const claude = JSON.parse(fs.readFileSync(hook.configPath(root, 'claude'), 'utf8'));
  assert.match(claude.hooks.SessionStart[0].hooks[0].command, /wontfix hook run/);

  const codex = JSON.parse(fs.readFileSync(hook.configPath(root, 'codex'), 'utf8'));
  assert.match(codex.hooks.SessionStart[0].hooks[0].command, /wontfix hook run/);

  const cursor = JSON.parse(fs.readFileSync(hook.configPath(root, 'cursor'), 'utf8'));
  assert.strictEqual(cursor.version, 1);
  assert.match(cursor.hooks.sessionStart[0].command, /--format cursor/);
});

test('cursor uses its own flat shape and lowercase event', () => {
  const root = tempRoot();
  hook.install(root, { tools: ['cursor'] })[0];
  const cursor = JSON.parse(fs.readFileSync(hook.configPath(root, 'cursor'), 'utf8'));
  assert.ok(Array.isArray(cursor.hooks.sessionStart));
  assert.strictEqual(cursor.hooks.sessionStart[0].hooks, undefined);
  assert.strictEqual(cursor.hooks.SessionStart, undefined);
});

test('installAll is idempotent across targets', () => {
  const root = tempRoot();
  hook.install(root, {});
  const second = hook.install(root, {});
  assert.ok(second.every((r) => r.status === 'already installed'));
  const cursor = JSON.parse(fs.readFileSync(hook.configPath(root, 'cursor'), 'utf8'));
  assert.strictEqual(cursor.hooks.sessionStart.length, 1);
});

test('install preserves an existing cursor hook config', () => {
  const root = tempRoot();
  const file = hook.configPath(root, 'cursor');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: './hooks/session-init.sh' }],
        afterFileEdit: [{ command: './hooks/format.sh' }]
      }
    }),
    'utf8'
  );
  hook.install(root, { tools: ['cursor'] })[0];
  const cursor = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(cursor.hooks.afterFileEdit.length, 1);
  assert.strictEqual(cursor.hooks.sessionStart.length, 2);
  assert.strictEqual(cursor.hooks.sessionStart[0].command, './hooks/session-init.sh');
});

test('remove takes out only our entry across shapes', () => {
  const root = tempRoot();
  hook.install(root, {});
  hook.remove(root, {});
  for (const name of hook.TOOL_NAMES) {
    const config = JSON.parse(fs.readFileSync(hook.configPath(root, name), 'utf8'));
    assert.deepStrictEqual(config, {});
  }
});

test('cursor payload uses additional_context', () => {
  const root = tempRoot();
  ledger.addEntry(root, { type: 'wontfix', title: 'redis queue', why: 'cold start' });
  const payload = hook.runPayload(root, { format: 'cursor' });
  assert.match(payload.additional_context, /redis queue/);
  assert.strictEqual(payload.hookSpecificOutput, undefined);
});

test('claude and codex share one payload shape', () => {
  const root = tempRoot();
  ledger.addEntry(root, { type: 'wontfix', title: 'redis queue', why: 'cold start' });
  const payload = hook.runPayload(root, { format: 'claude' });
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.strictEqual(payload.additional_context, undefined);
});

test('targets can be limited', () => {
  const root = tempRoot();
  const results = hook.install(root, { tools: ['cursor'] });
  assert.strictEqual(results.length, 1);
  assert.ok(!fs.existsSync(hook.configPath(root, 'claude')));
});
