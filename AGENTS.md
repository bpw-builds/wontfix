<!-- wontfix:rules -->
## Context ledger (wontfix)

This repo records decisions and dead ends with wontfix.

Reading it: in Claude Code the ledger is injected at session start, so it is
already above. If you do not see a section titled "Project context (generated
by wontfix)", run `npx wontfix pack --budget 1200` and read the output before
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
<!-- wontfix:rules -->
