'use strict';

const { spawnSync } = require('child_process');
const ledger = require('./ledger');
const redact = require('./redact');

// Node refuses null bytes in spawn args, so git emits the separators itself.
const SEPARATOR = '\u001f';
const TERMINATOR = '\u001e';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout || '';
}

function isRepo(root) {
  return git(root, ['rev-parse', '--is-inside-work-tree']) !== null;
}

function commits(root, limit) {
  const out = git(root, [
    'log',
    `-n${limit || 400}`,
    '--format=%H%x1f%ad%x1f%s%x1f%b%x1e',
    '--date=short'
  ]);
  if (out === null) return [];
  return out
    .split(TERMINATOR)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, date, subject, body] = chunk.split(SEPARATOR);
      return { hash: hash || '', date: date || '', subject: subject || '', body: body || '' };
    })
    .filter((c) => c.subject);
}

// A revert is the clearest signal history gives: shipped, then taken back out.
// What it rarely gives is the reason, which is why nothing here writes.
function classify(commit) {
  const subject = commit.subject;
  const body = (commit.body || '').trim();

  const revert = subject.match(/^Revert\s+"?(.+?)"?\s*$/i);
  if (revert) {
    return {
      type: 'wontfix',
      title: revert[1].slice(0, 110),
      why: reasonFrom(body) || null,
      confidence: 'high'
    };
  }

  if (/^(rollback|roll back|back out|undo)\b/i.test(subject)) {
    return {
      type: 'wontfix',
      title: subject.replace(/^(rollback|roll back|back out|undo)\s*:?\s*/i, '').slice(0, 110),
      why: reasonFrom(body) || null,
      confidence: 'high'
    };
  }

  if (/\b(switch(ed)?|migrat(e|ed|ing)|replac(e|ed|ing)|mov(e|ed|ing))\b.*\b(from|to)\b/i.test(subject)) {
    return { type: 'decision', title: subject.slice(0, 110), why: reasonFrom(body) || null, confidence: 'medium' };
  }

  if (/^(feat|fix|chore|docs|test|refactor|style|build|ci)(\(|:)/i.test(subject)) return null;
  return null;
}

function reasonFrom(body) {
  if (!body) return null;
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(Co-authored-by|Signed-off-by|Reviewed-by|Closes|Fixes|Refs)\b/i.test(l));
  if (lines.length === 0) return null;
  const reason = lines.find((l) => /because|since|caused|broke|failed|slow|regress|revert/i.test(l));
  return (reason || lines[0]).slice(0, 200);
}

function existingTitles(root) {
  if (!ledger.exists(root)) return new Set();
  return new Set(
    ledger
      .readEntries(root, { includeStale: true, includeRevoked: true })
      .map((e) => (e.title || '').toLowerCase())
  );
}

function propose(root, options = {}) {
  if (!isRepo(root)) return { supported: false, candidates: [] };

  const seen = existingTitles(root);
  const candidates = [];
  for (const commit of commits(root, options.limit)) {
    const guess = classify(commit);
    if (!guess) continue;
    const key = guess.title.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Scrub before printing, not just before writing: an old commit message is
    // a likely place for a pasted credential, and the preview goes to a
    // terminal that may be logged.
    const title = redact.redact(guess.title);
    const why = guess.why ? redact.redact(guess.why) : { text: guess.why, hits: 0 };
    candidates.push(
      Object.assign({}, guess, {
        title: title.text,
        why: why.text,
        redactedCount: title.hits + why.hits,
        hash: commit.hash,
        date: commit.date
      })
    );
    if (candidates.length >= (options.max || 25)) break;
  }
  return { supported: true, candidates };
}

function apply(root, candidates) {
  const written = [];
  const skipped = [];
  let redactedCount = 0;
  for (const candidate of candidates) {
    // No reason means no entry. A prohibition nobody can evaluate is worse
    // than a gap, and history rarely records why.
    if (!candidate.why && (candidate.type === 'wontfix' || candidate.type === 'decision')) {
      skipped.push(candidate);
      continue;
    }
    const entry = ledger.addEntry(root, {
      type: candidate.type,
      title: candidate.title,
      why: candidate.why,
      durability: 'until-changed',
      // Not agent, not human. Keeps mined entries out of the agent share,
      // which is the number that decides whether this tool works.
      source: 'git'
    });
    redactedCount += entry.redactedCount || 0;
    written.push(entry);
  }
  return { written, skipped, redactedCount };
}

module.exports = { propose, apply, classify, reasonFrom };
