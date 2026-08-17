'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ledger = require('./ledger');

const MARKER = '<!-- wontfix:rules -->';

const RULES = `${MARKER}
## Context ledger (wontfix)

This repo records decisions and dead ends with wontfix.

Reading it: in Claude Code the ledger is injected at session start, so it is
already above. If you do not see a section titled "Project context (generated
by wontfix)", run \`npx wontfix pack --budget 1200\` and read the output before
you plan anything. Never propose something listed under "already tried and
rejected" unless the reason given no longer holds, and say so explicitly if you
think it no longer holds.

Writing to it matters more than reading it. A ledger nobody writes to is dead
inside a week. Append an entry the moment one of these happens. Do not batch
them up at the end of a session, because the session may not end cleanly.
- You tried an approach and abandoned it:
    npx wontfix add wontfix "<what you tried>" --why "<why it failed>" --source agent
- You chose between real options:
    npx wontfix add decision "<what you chose>" --why "<why>" --source agent
- You learned a rule that must always hold:
    npx wontfix add constraint "<the rule>" --source agent
- A fact about the repo changed and matters next session:
    npx wontfix add state "<what is true now>" --source agent

Keep titles under 120 characters. Add --scope <path> when the entry is local to
one area, for example --scope src/api.

The reason is the whole value. "tried redis" is useless. "400ms cold start on
the free tier" can be checked later and reversed when it stops being true.

Worked example. You try a websocket for live updates, it breaks behind the
customer's proxy, you fall back to polling. That is two entries:
    npx wontfix add wontfix "websockets for live updates" --why "blocked by the corporate proxy at the pilot customer" --source agent
    npx wontfix add decision "poll every 5s instead" --why "works behind proxies, cost is acceptable at this scale" --source agent
${MARKER}`;

function appendRules(file, root) {
  const full = path.join(root, file);
  let existing = '';
  if (fs.existsSync(full)) existing = fs.readFileSync(full, 'utf8');
  if (existing.includes(MARKER)) return 'already present';
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const prefix = existing && !existing.endsWith('\n\n') ? '\n\n' : '';
  fs.writeFileSync(full, existing + prefix + RULES + '\n', 'utf8');
  return existing ? 'updated' : 'created';
}

function writeCursorRule(root) {
  const full = path.join(root, '.cursor', 'rules', 'wontfix.mdc');
  if (fs.existsSync(full)) return 'already present';
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const front = ['---', 'description: Project context ledger', 'alwaysApply: true', '---', ''];
  fs.writeFileSync(full, front.join('\n') + RULES + '\n', 'utf8');
  return 'created';
}

function addIgnore(root, line) {
  const full = path.join(root, '.gitignore');
  let existing = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
  if (existing.split('\n').some((l) => l.trim() === line)) return 'already present';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(full, existing + prefix + line + '\n', 'utf8');
  return 'updated';
}

const GUIDANCE = {
  agents: { label: 'AGENTS.md', write: (root) => appendRules('AGENTS.md', root) },
  claude: { label: 'CLAUDE.md', write: (root) => appendRules('CLAUDE.md', root) },
  cursor: { label: '.cursor/rules/wontfix.mdc', write: (root) => writeCursorRule(root) }
};

// Adding a gitignore line does nothing to a file git already tracks. Someone
// running init --private on an existing repo would otherwise believe the ledger
// is private while it keeps getting committed.
function trackedInGit(root, relative) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relative], {
    cwd: root,
    stdio: 'pipe'
  });
  return !result.error && result.status === 0;
}

function init(root, options = {}) {
  const files = [];
  const warnings = [];

  const file = ledger.ledgerPath(root);
  if (fs.existsSync(file)) {
    files.push(['ledger', 'already present']);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '', { mode: 0o600 });
    files.push(['ledger', 'created']);
  }

  // AGENTS.md is read natively by Codex, Cursor, Aider, Jules, Zed and others,
  // and some repos explicitly forbid adding guidance to CLAUDE.md or Cursor
  // rules. One file by default, the rest on request.
  const targets = options.guidance && options.guidance.length ? options.guidance : ['agents'];
  for (const name of targets) {
    const target = GUIDANCE[name];
    if (!target) continue;
    files.push([target.label, target.write(root)]);
  }

  if (options.private) {
    files.push(['.gitignore', addIgnore(root, `${ledger.DIR_NAME}/`)]);
    const relative = `${ledger.DIR_NAME}/${ledger.FILE_NAME}`;
    if (trackedInGit(root, relative)) {
      warnings.push(`${relative} is already tracked by git`);
    }
  } else {
    // The export marker is per person. Committing it would make one teammate's
    // paste look like everyone else's.
    files.push(['.gitignore', addIgnore(root, `${ledger.DIR_NAME}/export.local.json`)]);
  }

  return { files, warnings };
}

module.exports = { init, RULES, MARKER, GUIDANCE };
