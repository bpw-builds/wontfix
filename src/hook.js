'use strict';

const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');
const pack = require('./pack');

const TIMEOUT_SECONDS = 15;
const MAX_CONTEXT_BYTES = 8000;

// Claude Code and Codex share both the config shape and the output shape.
// Cursor differs in both: a flat hook entry, a lowercase event name, and
// additional_context instead of hookSpecificOutput.
const TOOLS = {
  claude: {
    label: 'Claude Code',
    config: ['.claude', 'settings.json'],
    localConfig: ['.claude', 'settings.local.json'],
    event: 'SessionStart',
    nested: true,
    command: 'npx wontfix hook run'
  },
  codex: {
    label: 'Codex',
    config: ['.codex', 'hooks.json'],
    event: 'SessionStart',
    nested: true,
    command: 'npx wontfix hook run'
  },
  cursor: {
    label: 'Cursor',
    config: ['.cursor', 'hooks.json'],
    event: 'sessionStart',
    nested: false,
    version: 1,
    command: 'npx wontfix hook run --format cursor'
  }
};

const TOOL_NAMES = Object.keys(TOOLS);

function configPath(root, tool, local) {
  const spec = TOOLS[tool];
  if (!spec) throw new Error(`unknown tool "${tool}"`);
  return path.join(root, ...(local && spec.localConfig ? spec.localConfig : spec.config));
}

// Throws on malformed JSON rather than returning a default, because the caller
// is about to write this file back and a default would erase someone's config.
function readConfig(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON, so it was left untouched. Fix it, then retry.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object, so it was left untouched.`);
  }
  return parsed;
}

function isWontfixHook(entry) {
  return Boolean(
    entry &&
      typeof entry.command === 'string' &&
      entry.command.includes('wontfix') &&
      entry.command.includes('hook run')
  );
}

function hookGroups(config, spec) {
  const groups = config.hooks && config.hooks[spec.event];
  return Array.isArray(groups) ? groups : [];
}

function hasWontfixHook(config, spec) {
  return hookGroups(config, spec).some((group) =>
    spec.nested ? (group.hooks || []).some(isWontfixHook) : isWontfixHook(group)
  );
}

function newHookGroup(spec) {
  return spec.nested
    ? { hooks: [{ type: 'command', command: spec.command, timeout: TIMEOUT_SECONDS }] }
    : { command: spec.command, timeout: TIMEOUT_SECONDS };
}

function withoutWontfixHook(config, spec) {
  const kept = [];
  for (const group of hookGroups(config, spec)) {
    if (!spec.nested) {
      if (!isWontfixHook(group)) kept.push(group);
      continue;
    }
    const hooks = (group.hooks || []).filter((hook) => !isWontfixHook(hook));
    if (hooks.length > 0) kept.push(Object.assign({}, group, { hooks }));
  }
  return kept;
}

function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function toolsFrom(options) {
  return options.tools && options.tools.length ? options.tools : TOOL_NAMES;
}

function install(root, options = {}) {
  return toolsFrom(options).map((tool) => {
    const file = configPath(root, tool, options.local);
    const spec = TOOLS[tool];
    let config;
    try {
      config = readConfig(file);
    } catch (err) {
      return { tool, file, status: `skipped (${err.message})` };
    }
    if (hasWontfixHook(config, spec)) return { tool, file, status: 'already installed' };

    if (spec.version && config.version === undefined) config.version = spec.version;
    if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
    if (!Array.isArray(config.hooks[spec.event])) config.hooks[spec.event] = [];
    config.hooks[spec.event].push(newHookGroup(spec));

    writeConfig(file, config);
    return { tool, file, status: 'installed' };
  });
}

function remove(root, options = {}) {
  return toolsFrom(options).map((tool) => {
    const file = configPath(root, tool, options.local);
    const spec = TOOLS[tool];
    if (!fs.existsSync(file)) return { tool, file, status: 'nothing to remove' };

    let config;
    try {
      config = readConfig(file);
    } catch (err) {
      return { tool, file, status: `skipped (${err.message})` };
    }
    if (!hasWontfixHook(config, spec)) return { tool, file, status: 'nothing to remove' };

    const kept = withoutWontfixHook(config, spec);
    if (kept.length > 0) {
      config.hooks[spec.event] = kept;
    } else {
      delete config.hooks[spec.event];
      if (Object.keys(config.hooks).length === 0) {
        delete config.hooks;
        // A lone version key is not a config anyone wants left behind.
        if (Object.keys(config).length === 1 && config.version !== undefined) delete config.version;
      }
    }
    writeConfig(file, config);
    return { tool, file, status: 'removed' };
  });
}

function status(root) {
  return TOOL_NAMES.map((tool) => {
    const spec = TOOLS[tool];
    const files = [configPath(root, tool, false)];
    if (spec.localConfig) files.push(configPath(root, tool, true));

    let installed = false;
    let unreadable = false;
    for (const file of files) {
      try {
        if (hasWontfixHook(readConfig(file), spec)) installed = true;
      } catch (err) {
        unreadable = true;
      }
    }
    return {
      tool,
      label: spec.label,
      file: files[0],
      status: unreadable ? 'unreadable config' : installed ? 'installed' : 'not installed'
    };
  });
}

// The only place in the codebase that swallows an error, and the only place
// that should. This runs when a session opens: a corrupt ledger or an
// unreadable file must cost the user their context, not their session.
function runPayload(root, options = {}) {
  let context = '';
  try {
    if (ledger.exists(root)) {
      const entries = ledger.readEntries(root);
      if (entries.length > 0) {
        context = pack.render(entries, { budget: options.budget || 1200 }).text;
      }
    }
  } catch (err) {
    context = '';
  }
  if (Buffer.byteLength(context, 'utf8') > MAX_CONTEXT_BYTES) {
    context = context.slice(0, MAX_CONTEXT_BYTES) + '\n<!-- wontfix: truncated -->';
  }

  return options.format === 'cursor'
    ? { additional_context: context }
    : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
}

module.exports = {
  TOOL_NAMES,
  MAX_CONTEXT_BYTES,
  configPath,
  install,
  remove,
  status,
  runPayload
};
