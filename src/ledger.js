'use strict';

const fs = require('fs');
const path = require('path');
const redact = require('./redact');

const DIR_NAME = '.wontfix';
const FILE_NAME = 'ledger.jsonl';

const TYPES = ['wontfix', 'constraint', 'decision', 'state'];
const DURABILITIES = ['permanent', 'until-changed', 'session'];
const SESSION_DAYS = 14;
// A ledger arrives via git pull, so its size is not under our control. Reading
// a 350MB file into a string aborts the process, which on the hook path means a
// failed session start and on the add path means the agent cannot record.
const MAX_READ_BYTES = 16 * 1024 * 1024;
// Ids are generated here, but on read they come from a file a pull request can
// touch, and they reach git as an argv value in `why`.
const ID_PATTERN = /^[0-9A-Z]{6,40}$/i;
const FILE_MODE = 0o600;

function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  const seen = [];
  while (true) {
    seen.push(dir);
    if (fs.existsSync(path.join(dir, DIR_NAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of seen) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
  }
  return path.resolve(start || process.cwd());
}

function ledgerPath(root) {
  return path.join(root, DIR_NAME, FILE_NAME);
}

function exists(root) {
  return fs.existsSync(ledgerPath(root));
}

// Base36 timestamp plus randomness, so full ids sort by creation time. Note
// that the leading characters are time only, which is why the short handle
// shown to people is taken from the end.
function makeId() {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = Math.random().toString(36).slice(2, 8);
  return (t + r).toUpperCase();
}

// The last 8 characters carry all 6 random characters, so two entries written
// in the same millisecond still get different handles.
function shortId(id) {
  return String(id || '').slice(-8);
}

function matchesId(entry, query) {
  const id = String(entry.id || '').toUpperCase();
  const q = String(query || '').toUpperCase();
  if (!q) return false;
  return id === q || id.startsWith(q) || id.endsWith(q);
}

function validId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function readText(file) {
  const size = fs.statSync(file).size;
  if (size <= MAX_READ_BYTES) return { text: fs.readFileSync(file, 'utf8'), truncated: false };
  const buffer = Buffer.alloc(MAX_READ_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString('utf8');
  return { text: text.slice(text.indexOf('\n') + 1), truncated: true, size };
}

function readRaw(root) {
  const file = ledgerPath(root);
  if (!fs.existsSync(file)) return [];
  const read = readText(file);
  if (read.truncated) lastReadTruncated = true;
  const lines = read.text.split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && validId(obj.id)) out.push(obj);
    } catch (err) {
      // A corrupt line must never take down the whole ledger.
    }
  }
  return out;
}

let lastReadTruncated = false;

function wasTruncated() {
  return lastReadTruncated;
}

function daysSince(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return (Date.now() - then) / 86400000;
}

function countRevocations(root) {
  return readRaw(root).filter((e) => e.status === 'revoked').length;
}

function readEntries(root, options = {}) {
  const byId = new Map();
  for (const entry of readRaw(root)) {
    byId.set(entry.id, Object.assign({}, byId.get(entry.id), entry));
  }
  const out = [];
  for (const entry of byId.values()) {
    if (entry.status === 'revoked' && !options.includeRevoked) continue;
    if (
      entry.durability === 'session' &&
      !options.includeStale &&
      daysSince(entry.created) > SESSION_DAYS
    ) {
      continue;
    }
    out.push(entry);
  }
  return out;
}

function validate(entry) {
  if (!TYPES.includes(entry.type)) {
    return `type must be one of: ${TYPES.join(', ')}`;
  }
  if (!entry.title || !entry.title.trim()) return 'title is required';
  if (entry.title.length > 120) return 'title must be 120 characters or fewer';
  if (!DURABILITIES.includes(entry.durability)) {
    return `durability must be one of: ${DURABILITIES.join(', ')}`;
  }
  if ((entry.type === 'wontfix' || entry.type === 'decision') && !entry.why) {
    return `--why is required for type "${entry.type}"`;
  }
  return null;
}

function append(root, entry) {
  const file = ledgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: FILE_MODE });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function addEntry(root, input) {
  const draft = {
    id: input.id || makeId(),
    type: input.type,
    title: (input.title || '').trim(),
    why: input.why ? String(input.why).trim() : undefined,
    scope: input.scope ? String(input.scope).trim() : undefined,
    durability: input.durability || 'until-changed',
    created: input.created || new Date().toISOString(),
    status: 'active',
    source: ['agent', 'human', 'git'].includes(input.source) ? input.source : 'human'
  };
  const scrubbed = redact.scrubEntry(draft);
  const entry = scrubbed.entry;
  const problem = validate(entry);
  if (problem) throw new Error(problem);
  append(root, entry);
  return Object.assign({}, entry, { redactedCount: scrubbed.hits });
}

function revoke(root, id) {
  const live = readEntries(root, { includeStale: true });
  const found = live.filter((e) => matchesId(e, id));
  if (found.length === 0) throw new Error(`no active entry found for id "${id}"`);
  if (found.length > 1) {
    const handles = found.map((e) => shortId(e.id)).join(', ');
    throw new Error(`"${id}" matches ${found.length} entries (${handles}). Be more specific.`);
  }
  const target = found[0];
  return append(
    root,
    Object.assign({}, target, {
      status: 'revoked',
      revoked: new Date().toISOString()
    })
  );
}

module.exports = {
  DIR_NAME,
  FILE_NAME,
  findRoot,
  ledgerPath,
  exists,
  shortId,
  validId,
  wasTruncated,
  countRevocations,
  MAX_READ_BYTES,
  readRaw,
  readEntries,
  addEntry,
  revoke,
  daysSince
};
