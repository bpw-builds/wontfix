'use strict';

// Anchored to recognizable prefixes and structures. A ledger is append-only
// and committed, so a leak here is permanent by design. But over-matching is
// its own failure: "the key was wrong" must survive untouched.
const PATTERNS = [
  // OpenAI and Anthropic style keys
  [/\b(sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,})/g, 'sk-REDACTED'],
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'ghX-REDACTED'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_REDACTED'],
  // AWS access key ids and Google API keys
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AKIA-REDACTED'],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, 'AIza-REDACTED'],
  // Slack, Stripe, SendGrid
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox-REDACTED'],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, 'stripe-REDACTED'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, 'SG-REDACTED'],
  // JSON Web Tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt-REDACTED'],
  // Bearer headers and PEM blocks
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer REDACTED'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)?/g, 'PEM-REDACTED'],
  // Connection strings with inline credentials
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, '$1REDACTED:REDACTED@']
];

// ANSI escapes, C0/C1 controls and newlines all get flattened. Newlines are
// the dangerous one: one entry containing "\n### Rules that must hold." forges
// a whole section in the pack that the agent reads as instructions.
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b[@-_]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/g;

function sanitizeText(text) {
  if (typeof text !== 'string' || text.length === 0) return { text, changed: false };
  const out = text
    .replace(ANSI, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROL, '')
    // Prevents an entry from closing the comment when the block is embedded.
    .replace(/-->/g, '- ->')
    .replace(/^[\s>#*_`-]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text: out, changed: out !== text };
}

function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return { text, hits: 0 };
  let out = text;
  let hits = 0;
  for (const [pattern, replacement] of PATTERNS) {
    const found = out.match(pattern);
    if (!found) continue;
    hits += found.length;
    out = out.replace(pattern, replacement);
  }
  return { text: out, hits };
}

function scrubEntry(entry) {
  let hits = 0;
  let sanitized = false;
  const out = Object.assign({}, entry);
  for (const field of ['title', 'why', 'scope']) {
    if (typeof out[field] !== 'string') continue;
    const clean = sanitizeText(out[field]);
    if (clean.changed) sanitized = true;
    const result = redact(clean.text);
    out[field] = result.text;
    hits += result.hits;
  }
  if (sanitized) out.sanitized = true;
  if (hits > 0) out.redacted = true;
  return { entry: out, hits };
}

module.exports = { redact, sanitizeText, scrubEntry };
