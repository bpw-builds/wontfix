'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ledger = require('./ledger');
const pack = require('./pack');

// Instructions fields are far smaller than an agent context window, and an
// oversized paste is truncated silently rather than rejected.
const DEFAULT_BUDGET = 600;

const MARKER_NAME = 'export.local.json';

// Worded as a rule, not a description. Without it the model treats the block
// as reference material and suggests the rejected thing anyway.
const INSTRUCTION =
  'Rule: do not propose anything in the rejected list below. ' +
  'If a reason looks out of date, say so instead of quietly following it.';

function markerPath(root) {
  return path.join(root, ledger.DIR_NAME, MARKER_NAME);
}

function readMarker(root) {
  const file = markerPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.exported ? parsed : null;
  } catch (err) {
    return null;
  }
}

function writeMarker(root, data) {
  const file = markerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return data;
}

function buildBlock(root, options = {}) {
  const budget = Number(options.budget) > 0 ? Number(options.budget) : DEFAULT_BUDGET;
  const entries = ledger.readEntries(root);
  const now = options.now ? new Date(options.now) : new Date();
  const rendered = pack.render(entries, {
    budget,
    scope: options.scope,
    instruction: INSTRUCTION,
    stampDate: now.toISOString().slice(0, 10)
  });
  return {
    text: rendered.text,
    budget,
    kept: rendered.kept.length,
    dropped: rendered.dropped.length,
    total: entries.length,
    exported: now.toISOString()
  };
}

function copyToClipboard(text) {
  const candidates =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']]
          ];

  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, { input: text });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

function entriesSince(root, iso) {
  if (!iso) return null;
  const cutoff = Date.parse(iso);
  if (Number.isNaN(cutoff)) return null;
  return ledger
    .readEntries(root, { includeStale: true, includeRevoked: true })
    .filter((e) => Date.parse(e.created) > cutoff).length;
}

function staleness(root) {
  const marker = readMarker(root);
  if (!marker) return { exported: null, since: null, text: 'never exported' };
  const since = entriesSince(root, marker.exported);
  const when = marker.exported.slice(0, 10);
  if (since === 0) return { exported: marker.exported, since, text: `current as of ${when}` };
  const plural = since === 1 ? 'entry' : 'entries';
  return {
    exported: marker.exported,
    since,
    text: `${since} ${plural} added since your export on ${when}`
  };
}

module.exports = {
  INSTRUCTION,
  markerPath,
  writeMarker,
  buildBlock,
  copyToClipboard,
  staleness
};
