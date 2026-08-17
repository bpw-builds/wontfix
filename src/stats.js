'use strict';

const ledger = require('./ledger');
const exporter = require('./export');

const TYPE_ORDER = ['wontfix', 'constraint', 'decision', 'state'];

function summarize(root) {
  const all = ledger.readEntries(root, { includeStale: true, includeRevoked: true });
  const live = ledger.readEntries(root);

  const bySource = { agent: 0, human: 0, git: 0 };
  const byType = {};
  for (const entry of all) {
    const source = ['agent', 'git'].includes(entry.source) ? entry.source : 'human';
    bySource[source]++;
    byType[entry.type] = (byType[entry.type] || 0) + 1;
  }

  // Backfilled entries are neither written by the agent nor by a person at the
  // keyboard. Counting them either way would corrupt the retention signal.
  const authored = all.filter((e) => e.source !== 'git');
  const recent = authored.filter((e) => ledger.daysSince(e.created) <= 7);
  const recentAgent = recent.filter((e) => e.source === 'agent').length;

  const oldest = authored.reduce((min, e) => {
    const t = Date.parse(e.created);
    return Number.isNaN(t) ? min : Math.min(min, t);
  }, Date.now());
  const spanDays = Math.max(1, (Date.now() - oldest) / 86400000);
  const perWeek = (authored.length / spanDays) * 7;
  const agentPerWeek = (bySource.agent / spanDays) * 7;

  return {
    total: all.length,
    live: live.length,
    bySource,
    byType,
    last7: recent.length,
    last7Agent: recentAgent,
    spanDays,
    perWeek,
    agentPerWeek,
    authored: authored.length,
    agentShare: authored.length === 0 ? 0 : bySource.agent / authored.length
  };
}

function verdict(s) {
  if (s.authored === 0) return 'No entries written yet. Run a real session and check back.';
  if (s.total === 0) return 'No entries yet. Run a real session and check back.';
  if (s.spanDays < 5) return 'Too early to judge. Give it a week of real work.';
  if (s.agentPerWeek >= 3) return 'Healthy. The agent is filling this on its own.';
  if (s.agentPerWeek >= 1) return 'Thin but alive. Watch it another week.';
  return 'The agent is not writing entries. Fix the rules install before launching.';
}

function render(root) {
  const s = summarize(root);
  const lines = [];
  lines.push(`Entries        ${s.total} total, ${s.live} live`);
  const backfilled = s.bySource.git ? `, ${s.bySource.git} backfilled` : '';
  lines.push(`Written by     ${s.bySource.agent} agent, ${s.bySource.human} human${backfilled}`);
  lines.push(`Agent share    ${Math.round(s.agentShare * 100)}%`);
  lines.push(`Last 7 days    ${s.last7} entries (${s.last7Agent} by agent)`);
  lines.push(`Rate           ${s.perWeek.toFixed(1)} per week, ${s.agentPerWeek.toFixed(1)} by agent`);
  lines.push(`Age            ${s.spanDays.toFixed(0)} days since first entry`);
  lines.push(`Revoked        ${ledger.countRevocations(root)} revocation lines`);
  lines.push(`Web export     ${exporter.staleness(root).text}`);
  lines.push('');
  const types = TYPE_ORDER.filter((t) => s.byType[t]).map((t) => `${s.byType[t]} ${t}`);
  lines.push(`By type        ${types.length ? types.join(', ') : 'none'}`);
  lines.push('');
  lines.push(verdict(s));
  return { text: lines.join('\n'), stats: s };
}

module.exports = { summarize, verdict, render };
