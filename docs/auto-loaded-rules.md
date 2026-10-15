# The auto loaded rules files and their budget

`CLAUDE.md` and `AGENTS.md` are loaded into every Slate session. This holds the
full text of their two opening sections as they stood before the 2026-10-15 cut
(#2393), which moved runbooks, incident histories and guard designs out of them
and into `docs/`, leaving each rule with a pointer. The budget's current figure
and the measurement behind it are in `scripts/lib/auto-loaded-docs.ts`; the
historical numbers below are kept as the record they were.

## This is NOT the Next.js you know

This version has breaking changes: APIs, conventions and file structure may all
differ from your training data. Read the relevant guide in
`node_modules/next/dist/docs/` (resolved from that file's own directory) before
writing any code, and heed deprecation notices.

Next writes this advice into AGENTS.md itself when `next dev` starts, inside a
pair of `nextjs-agent-rules` markers, and its wording carries a character the
repo's style gate refuses. Every dev server run therefore re-added an unexplained
modification that blocked the next push, three times in one session on 2026-09-10
(#2201). `agentRules: false` in `next.config.ts` turns that off, the paragraph
above it in `AGENTS.md` was Slate's own copy of what the block said, and
`scripts/test-agent-rules-generation.ts` holds both halves: that the setting is
there, and that Next's installed generator really would still write a banned
character.

## `AGENTS.md` has a size budget, and it is measured (#2393)

`CLAUDE.md` is loaded into every session and its first line is `@AGENTS.md`, so
every character of `AGENTS.md` is paid on every request of every session. It grew
from 51,740 characters on 2026-08-29 to 157,711 on 2026-09-17, a paragraph at a
time, with nothing measuring the total, which is how a file nobody decided to make
enormous becomes enormous.

**What the ceiling actually is, measured against Claude Code 2.1.274 rather than
assumed.** There is no per file character cut a rules file can reach: a probe
memory file carrying an unguessable end of file nonce was read in full at 400,105
characters, and at 2,000,043 characters the whole file was still counted into the
request rather than trimmed. What binds is the **request**, which is refused above
200,000 tokens with the memory payload counted inside it alongside the system
prompt, the tool definitions and the work. The exchange rate was measured on
`AGENTS.md`: an otherwise identical session cost 61,314 prompt tokens with an eight
character memory file and 103,544 with AGENTS.md as it stood, so `AGENTS.md` alone
cost 42,230 tokens, 3.73 characters per token and 21 percent of the whole limit.

So the budget is a share of the window: **125,000 characters for `CLAUDE.md` plus
everything it imports**, about 33,500 tokens, one sixth of the request. The
session also has to carry the machine's global config, the tool definitions and
the work itself. `scripts/test-auto-loaded-docs-budget.ts` measures it in
`pnpm test` and says how far over it is.

**When it fires, move a runbook section into `docs/` and leave the rule in
`AGENTS.md` with a pointer**, the way the `verify:` commands went to
`docs/verify-commands.md`. A rule belongs in `AGENTS.md`; an exit code table, a
set of flags and a record of what one live run measured belong beside the code,
because they are wanted on the day somebody runs the thing. Raising the number is
a decision about what share of the window this repo's rules may take, and it is
made out loud.
