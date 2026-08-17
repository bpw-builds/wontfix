'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const ledger = require('./ledger');
const pack = require('./pack');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').trim();
}

// Turn any remote form into an https base. Returns null for hosts we cannot
// build a permalink for, rather than guessing wrong.
function remoteBase(root) {
  const remote = git(root, ['config', '--get', 'remote.origin.url']);
  if (!remote) return null;
  let url = remote.replace(/\.git$/, '');
  const ssh = url.match(/^git@([^:]+):(.+)$/);
  if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
  if (url.startsWith('ssh://')) url = 'https://' + url.slice(6).replace(/^git@/, '');
  if (!url.startsWith('https://')) return null;
  if (/github\.com|gitlab\.com|bitbucket\.org/.test(url)) return url;
  return url;
}

function blobPath(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  const file = ledger.ledgerPath(root);
  if (!top) return null;
  return path.relative(top, file).split(path.sep).join('/');
}

function commitFor(root, id) {
  // Never let a string from the ledger reach argv unvalidated. It is not
  // currently exploitable, because git reads the rest of the -S token as the
  // search value, but the safety of that depends on git's parser, not ours.
  if (!ledger.validId(id)) return null;
  const rel = blobPath(root);
  if (!rel) return null;
  const out = git(root, ['log', '--reverse', '--format=%H', `-S${id}`, '--', rel]);
  if (!out) return null;
  return out.split('\n')[0].trim() || null;
}

function permalink(root, id) {
  const commit = commitFor(root, id);
  if (!commit) return null;
  const base = remoteBase(root);
  const rel = blobPath(root);
  if (!base || !rel) return { commit, url: null };
  const host = /gitlab\.com/.test(base) ? '/-/blob/' : '/blob/';
  return { commit, url: `${base}${host}${commit}/${rel}` };
}

function score(entry, query) {
  const q = query.toLowerCase();
  const title = (entry.title || '').toLowerCase();
  const why = (entry.why || '').toLowerCase();
  if (title === q) return 100;
  if (title.includes(q)) return 60 + Math.max(0, 20 - title.length / 10);
  if (why.includes(q)) return 30;
  const words = q.split(/\s+/).filter(Boolean);
  const hit = words.filter((w) => title.includes(w) || why.includes(w)).length;
  return hit === 0 ? 0 : 10 + hit;
}

function find(root, query) {
  const entries = ledger.readEntries(root, { includeStale: true });
  return entries
    .map((entry) => ({ entry, score: score(entry, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.entry);
}

function render(root, query) {
  const matches = find(root, query);
  if (matches.length === 0) {
    return { text: `No entry matches "${query}".`, found: false };
  }

  const lines = [];
  if (matches.length > 1) {
    lines.push(`${matches.length} entries match "${query}".`);
    lines.push('');
  }
  for (const entry of matches) {
    lines.push(`${entry.type}: ${pack.safe(entry.title)}`);
    if (entry.why) lines.push(`  reason: ${pack.safe(entry.why)}`);
    lines.push(
      `  recorded: ${(entry.created || '').slice(0, 10)} by ${entry.source || 'human'} ` +
        `(${ledger.shortId(entry.id)})`
    );
    const link = permalink(root, entry.id);
    if (link && link.url) {
      lines.push(`  source: ${link.url}`);
    } else if (link) {
      lines.push(`  source: commit ${link.commit.slice(0, 10)}`);
    } else {
      lines.push('  source: not yet committed');
    }
    lines.push('');
  }
  return { text: lines.join('\n').trimEnd(), found: true, matches };
}

module.exports = { find, render, commitFor, remoteBase };
