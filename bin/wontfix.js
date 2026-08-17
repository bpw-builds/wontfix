#!/usr/bin/env node
'use strict';

const ledger = require('../src/ledger');
const pack = require('../src/pack');
const hook = require('../src/hook');
const stats = require('../src/stats');
const exporter = require('../src/export');
const why = require('../src/why');
const backfill = require('../src/backfill');
const { init } = require('../src/init');
const pkg = require('../package.json');

// `wontfix list | head` closes the pipe early. Exit quietly instead of
// dumping a stack trace at the user.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

const HELP = `wontfix ${pkg.version}
A repo-local ledger of decisions and dead ends, for coding agents.

Usage:
  wontfix init [--guidance agents,claude,cursor] [--no-hook] [--private]
  wontfix add <type> "<title>" [--why "..."] [--scope <path>]
                               [--durability permanent|until-changed|session]
                               [--source agent|human]
  wontfix pack [--budget 1200] [--scope <path>] [--json]
  wontfix list [--type <type>] [--all]
  wontfix revoke <id>
  wontfix export [--copy] [--budget 600] [--scope <path>]
  wontfix why "<search>"
  wontfix backfill [--apply] [--limit 400]
  wontfix stats
  wontfix hook install|remove|status [--only claude,cursor,codex] [--local]
  wontfix hook run [--format claude|cursor]

Types:
  wontfix      tried or considered, rejected. --why required.
  constraint   a rule that must always hold.
  decision     chose this over that. --why required.
  state        what is true right now. Decays first when space runs out.

Examples:
  wontfix add wontfix "redis for the job queue" --why "400ms cold start"
  wontfix add constraint "never write to the billing table directly"
  wontfix pack --budget 800 --scope src/api
  wontfix export --copy
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// A flag given with no value parses as true. Commands want the string or
// nothing, never the boolean.
function value(flags, name) {
  return typeof flags[name] === 'string' ? flags[name] : undefined;
}

function fail(message) {
  process.stderr.write(`wontfix: ${message}\n`);
  process.exit(1);
}

function requireLedger(root) {
  if (!ledger.exists(root)) {
    fail('no ledger found. Run "npx wontfix init" in your project folder first.');
  }
}

function ranViaNpx() {
  // npx executes the package from a cache directory under _npx. A globally or
  // locally installed copy never does.
  if (__dirname.includes('_npx')) return true;
  const agent = process.env.npm_config_user_agent || '';
  return agent.includes('exec');
}

function cmdInit(root, flags) {
  let guidance;
  if (typeof flags.guidance === 'string') {
    guidance = flags.guidance.split(',').map((g) => g.trim()).filter(Boolean);
    const unknown = guidance.filter((g) => !['agents', 'claude', 'cursor'].includes(g));
    if (unknown.length > 0) {
      fail(`unknown guidance target "${unknown[0]}". Use agents, claude or cursor.`);
    }
  }
  const result = init(root, { private: flags.private === true, guidance });
  for (const [name, status] of result.files) {
    process.stdout.write(`${status.padEnd(15)} ${name}\n`);
  }
  if (result.warnings.length > 0) {
    process.stderr.write(
      '\nwontfix: --private added a .gitignore line, but the ledger is already tracked\n' +
        'by git, so it will keep being committed. Untrack it first:\n\n' +
        '    git rm --cached .wontfix/ledger.jsonl\n\n' +
        'Anything already pushed stays in history. Rewriting that is on you.\n'
    );
  }

  if (flags['no-hook'] !== true) {
    for (const result of hook.install(root, { local: flags.local === true })) {
      process.stdout.write(`${result.status.padEnd(15)} ${result.file}\n`);
    }
  }

  process.stdout.write('\nLedger ready.\n');
  if (flags['no-hook'] !== true) {
    process.stdout.write(
      'Claude Code, Cursor and Codex will each load it at the start of every session.\n'
    );
    if (ranViaNpx()) {
      process.stdout.write(
        '\nOne thing: you ran this through npx, and the hook calls wontfix on every\n' +
          'session start. Without a local copy that refetches each time, which costs a\n' +
          'second or two per session and fails with no network. Fix it once:\n\n' +
          '    npm install -g wontfix\n\n'
      );
    }
  }
  if (flags.private !== true) {
    process.stdout.write(
      'The ledger is committed to git by default. Use --private to keep it out.\n'
    );
  }
}

function cmdAdd(root, positional, flags) {
  requireLedger(root);
  const [type, title] = positional;
  if (!type || !title) {
    fail('usage: wontfix add <type> "<title>" [--why "..."]');
  }
  const entry = ledger.addEntry(root, {
    type,
    title,
    why: value(flags, 'why'),
    scope: value(flags, 'scope'),
    durability: value(flags, 'durability'),
    source: value(flags, 'source')
  });
  process.stdout.write(`added ${entry.type}#${ledger.shortId(entry.id)}\n`);
  if (entry.redactedCount > 0) {
    const plural = entry.redactedCount === 1 ? 'secret' : 'secrets';
    process.stdout.write(
      `wontfix: redacted ${entry.redactedCount} ${plural} from this entry before writing it.\n` +
        'The entry is stored scrubbed and cannot be edited. Revoke and re-add it if it now reads wrong.\n'
    );
  }
}

function cmdPack(root, flags) {
  requireLedger(root);
  const entries = ledger.readEntries(root);
  const budget = Number(flags.budget) > 0 ? Number(flags.budget) : 1200;
  const scope = value(flags, 'scope');
  const result = pack.render(entries, { budget, scope });
  if (flags.json === true) {
    process.stdout.write(
      JSON.stringify(
        {
          text: result.text,
          budget,
          kept: result.kept.length,
          dropped: result.dropped.length
        },
        null,
        2
      ) + '\n'
    );
    return;
  }
  process.stdout.write(result.text + '\n');
}

function warnIfTruncated() {
  if (!ledger.wasTruncated()) return;
  process.stderr.write(
    'wontfix: the ledger is larger than 16MB, so only the most recent entries were read.\n' +
      'Older entries are being ignored. Consider archiving the file.\n'
  );
}

function cmdList(root, flags) {
  requireLedger(root);
  const entries = ledger.readEntries(root, { includeStale: flags.all === true });
  const wanted = value(flags, 'type') || null;
  const shown = wanted ? entries.filter((e) => e.type === wanted) : entries;
  if (shown.length === 0) {
    process.stdout.write('Ledger is empty.\n');
    return;
  }
  const ranked = pack.rank(shown);
  let currentType = null;
  for (const entry of ranked) {
    if (entry.type !== currentType) {
      currentType = entry.type;
      process.stdout.write(`\n${currentType.toUpperCase()}\n`);
    }
    const date = (entry.created || '').slice(0, 10);
    const who = entry.source === 'agent' ? 'agent' : 'human';
    process.stdout.write(
      `  ${ledger.shortId(entry.id)}  ${date}  ${who.padEnd(5)}  ${pack.safe(entry.title)}\n`
    );
    if (entry.why) {
      process.stdout.write(`                                  reason: ${pack.safe(entry.why)}\n`);
    }
  }
  process.stdout.write(`\n${shown.length} entries.\n`);
  warnIfTruncated();
}

function cmdRevoke(root, positional) {
  requireLedger(root);
  const id = positional[0];
  if (!id) fail('usage: wontfix revoke <id>');
  ledger.revoke(root, id);
  process.stdout.write(`revoked ${id}\n`);
}

function cmdExport(root, flags) {
  requireLedger(root);
  const result = exporter.buildBlock(root, {
    budget: flags.budget,
    scope: value(flags, 'scope')
  });

  let copied = null;
  if (flags.copy === true) {
    copied = exporter.copyToClipboard(result.text);
  }

  // The marker is the whole point of this being a separate command.
  exporter.writeMarker(root, {
    exported: result.exported,
    entries: result.total,
    packed: result.kept,
    budget: result.budget
  });

  if (flags.copy === true && copied) {
    process.stdout.write(
      `Copied to clipboard: ${result.kept} of ${result.total} entries, budget ${result.budget}.\n` +
        'Paste it into your project instructions, replacing any previous wontfix block.\n'
    );
    return;
  }

  if (flags.copy === true && !copied) {
    process.stderr.write('wontfix: no clipboard tool found, printing instead.\n');
  }
  process.stdout.write(result.text + '\n');
}

function cmdWhy(root, positional) {
  requireLedger(root);
  const query = positional.join(' ').trim();
  if (!query) fail('usage: wontfix why "<search>"');
  const result = why.render(root, query);
  process.stdout.write(result.text + '\n');
  if (!result.found) process.exit(1);
}

function cmdBackfill(root, flags) {
  requireLedger(root);
  const result = backfill.propose(root, {
    limit: Number(flags.limit) > 0 ? Number(flags.limit) : undefined
  });
  if (!result.supported) fail('not a git repository, so there is no history to read.');
  if (result.candidates.length === 0) {
    process.stdout.write('No reverts or switches found in recent history.\n');
    return;
  }

  if (flags.apply !== true) {
    process.stdout.write(
      `Found ${result.candidates.length} ${result.candidates.length === 1 ? 'candidate' : 'candidates'} in git history. Nothing written yet.\n\n`
    );
    for (const c of result.candidates) {
      process.stdout.write(`${c.type.padEnd(9)} ${pack.safe(c.title)}\n`);
      if (c.redactedCount > 0) {
        process.stdout.write(`          (${c.redactedCount} ${c.redactedCount === 1 ? 'secret' : 'secrets'} scrubbed from this commit message)\n`);
      }
      process.stdout.write(
        `          ${c.why ? 'reason: ' + pack.safe(c.why) : 'NO REASON FOUND, will be skipped'}\n`
      );
      process.stdout.write(`          ${c.date} ${c.hash.slice(0, 8)}\n\n`);
    }
    process.stdout.write('Read these first. Anything without a reason is dropped.\n');
    process.stdout.write('Run "wontfix backfill --apply" to write the rest.\n');
    return;
  }

  const applied = backfill.apply(root, result.candidates);
  process.stdout.write(`Wrote ${applied.written.length} ${applied.written.length === 1 ? 'entry' : 'entries'}, ` +
      `skipped ${applied.skipped.length} with no reason.\n`);
  process.stdout.write('They are tagged source=git and excluded from the agent share in stats.\n');
  if (applied.redactedCount > 0) {
    const plural = applied.redactedCount === 1 ? 'secret' : 'secrets';
    process.stdout.write(
      `wontfix: redacted ${applied.redactedCount} ${plural} found in old commit messages.\n` +
        'Those entries are stored scrubbed. Revoke and re-add any that now read wrong.\n'
    );
  }
}

function cmdStats(root) {
  requireLedger(root);
  process.stdout.write(stats.render(root).text + '\n');
  warnIfTruncated();
}

function cmdHook(root, positional, flags) {
  const sub = positional[0] || 'status';

  if (sub === 'run') {
    const payload = hook.runPayload(root, {
      format: flags.format === 'cursor' ? 'cursor' : 'claude',
      budget: Number(flags.budget) > 0 ? Number(flags.budget) : 1200
    });
    process.stdout.write(JSON.stringify(payload) + '\n');
    return;
  }

  let tools;
  if (typeof flags.only === 'string') {
    tools = flags.only.split(',').map((t) => t.trim()).filter(Boolean);
    const unknown = tools.filter((t) => !hook.TOOL_NAMES.includes(t));
    if (unknown.length > 0) {
      fail(`unknown tool "${unknown[0]}". Use ${hook.TOOL_NAMES.join(', ')}.`);
    }
  }
  const options = { local: flags.local === true, tools };

  if (sub === 'install' || sub === 'remove') {
    const results = sub === 'install' ? hook.install(root, options) : hook.remove(root, options);
    for (const result of results) {
      process.stdout.write(`${result.status.padEnd(18)} ${result.file}\n`);
    }
    if (sub === 'install' && results.some((r) => r.status === 'installed')) {
      process.stdout.write('\nStart a new session for it to take effect.\n');
    }
    return;
  }

  if (sub === 'status') {
    for (const row of hook.status(root)) {
      process.stdout.write(`${row.status.padEnd(18)} ${row.label.padEnd(12)} ${row.file}\n`);
    }
    return;
  }

  fail(`unknown hook command "${sub}". Use install, remove, status or run.`);
}

function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const command = positional.shift();

  if (!command || command === 'help' || flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'version' || flags.version) {
    process.stdout.write(pkg.version + '\n');
    return;
  }

  const root = ledger.findRoot(process.cwd());

  switch (command) {
    case 'init':
      return cmdInit(root, flags);
    case 'add':
      return cmdAdd(root, positional, flags);
    case 'pack':
      return cmdPack(root, flags);
    case 'list':
      return cmdList(root, flags);
    case 'revoke':
      return cmdRevoke(root, positional);
    case 'export':
      return cmdExport(root, flags);
    case 'why':
      return cmdWhy(root, positional);
    case 'backfill':
      return cmdBackfill(root, flags);
    case 'stats':
      return cmdStats(root);
    case 'hook':
      return cmdHook(root, positional, flags);
    default:
      fail(`unknown command "${command}". Run "wontfix help".`);
  }
}

try {
  main();
} catch (err) {
  // Every thrown Error in this codebase carries a message written for the
  // person running the command, so there is one place that prints them.
  fail(err.message);
}
