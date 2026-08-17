# Changelog

## 0.2.0

- Session-start hooks for Claude Code, Cursor and Codex. `init` installs all
  three, so the ledger loads into every new session automatically. Claude Code
  and Codex share a hook shape; Cursor gets `--format cursor`, which returns
  `additional_context` instead of `hookSpecificOutput`. `hook install`,
  `hook remove`, `hook status` and `hook run` cover the rest, with `--only` to
  target one tool. Existing hooks are preserved, and a config that is not valid
  JSON is refused rather than overwritten.
- `stats` reports how many entries the agent wrote on its own, which is the
  number that says whether the tool is working.
- `export` builds a paste block for browser chats: project instructions in
  Claude, ChatGPT or Gemini. Carries an explicit rule line, defaults to a
  budget of 600, and stamps the block with its count, budget and date.
  `--copy` puts it straight on the clipboard.
- `export` records when it ran, and `stats` reports how many entries have landed
  since, so the pasted block has a visible expiry instead of going quietly stale.
- `pack --json` for tooling.
- `list` shows whether each entry came from the agent or a human.
- Rules rewritten: a worked example, and an instruction to challenge a rejection
  whose reason no longer holds instead of obeying it forever.
- `init` notices when it was run through npx and says so, because the hook pays
  that fetch cost on every session start.
- Exit quietly when output is piped into `head` or `less`.

- Short entry handles are taken from the end of the id. The leading characters
  are timestamp only, so two entries written in the same millisecond collided
  and `revoke` could have retired the wrong one. An ambiguous id is now refused
  rather than guessed.
- `add` says when it scrubbed something, because silent redaction plus an
  append-only file means a mangled entry survives unnoticed.
- `why` prints every match instead of the closest three.
- Credentials are scrubbed before an entry reaches disk, anchored to
  recognizable prefixes so ordinary prose survives. The ledger is append-only
  and committed, so a leak would be permanent.
- `backfill` scrubs credentials out of old commit messages before it prints a
  preview, not just before it writes, and reports the count on apply. It is the
  highest-volume write path and the likeliest to sweep up an old key.
- `backfill` proposes entries from git history: reverts, rollbacks and
  migrations. Writes nothing without `--apply`, drops candidates whose commit
  message never said why, and tags what it writes `source: git` so mined
  entries stay out of the agent share.
- `why "<search>"` prints the reason and a permalink to the commit that recorded
  it, for closing a duplicate pull request without retyping the argument.
- `init` now writes guidance to AGENTS.md by default. CLAUDE.md and Cursor rules
  are opt in via `--guidance`, since some repos forbid them.

### Cleanup pass, no behavior change

- `hook.js`: `install`/`installAll` and `remove`/`removeAll` collapsed into one
  `install` and one `remove`, each taking `{ tools, local }` and always
  returning one result per tool. `settingsPath` is `configPath`, `isOurs` is
  `isWontfixHook`, `alreadyInstalled` is `hasWontfixHook`.
- One error path: the CLI has a single try/catch at the entry point instead of
  three around individual commands.
- One swallow, in `hook.runPayload`, where a failure must cost context rather
  than the session. The two nested try/catch blocks under it are gone.
- `init` returns `{ files, warnings }` instead of a pair list with a magic
  'WARNING' key.
- `export.build` is `buildBlock`. Default parameters replace `options || {}`.
  20 exports nothing imported are gone. Comments that restated the code are
  gone; the ones carrying a decision stayed.

### Security pass

- Entry text is flattened on write and again at render: newlines, tabs, ANSI
  escapes, C0/C1 controls, zero width and bidi characters, and leading markdown
  structure. Fixes instruction forgery in the pack, where one entry could invent
  a "Rules that must hold" section, and ANSI injection into the terminal.
- Ledger ids are validated before reaching git argv, and lines with an invalid id
  are dropped on read.
- Reads are capped at 16MB with a tail read and a warning, instead of aborting
  the process on an oversized ledger.
- The ledger and the export marker are written 0600 inside a 0700 directory.
- `init --private` warns when the ledger is already tracked by git, and prints
  the `git rm --cached` command.
- `stats` reports the revocation count, so a forged revocation is visible.

## 0.1.0

- Ledger, `add`, `pack`, `list`, `revoke`, `init`.
