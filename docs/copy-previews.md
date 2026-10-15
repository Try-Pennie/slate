# Reading copy before it ships: the alert and booker previews

Two commands print every string Slate sends to Slack or shows a lead, by
calling the real copy builders, so wording is read in review before it ships.

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rule and points here; this is the
full text as it stood, with the reasoning, the incidents and the measurements
behind it.

## Read alert copy before it ships (`pnpm preview:alerts`, #1153)

Alert copy is a contract with a person holding a phone mid-incident, and it was
the one user-facing surface in Slate that could not be looked at before it
shipped. The 2026-07-28 page proved the cost: eight lines of raw Google JSON cut
off mid-word, advice to re-authenticate an account the same message called
self-healing, and "1 of 97 bookable agent". Unit tests assert substrings, so none
of that was visible until Slack rendered it at 7am.

**Run `pnpm preview:alerts` before changing any alert wording, and read the diff
in review.** It prints every alert, grouped by key, in each state that reads
differently (singular and plural, measured and unreadable, page and all-clear).

The rule that makes it trustworthy: **the preview CALLS the real copy builders,
it never holds its own copy of the wording.** That is why alert text lives in
pure builders (`*/alert-copy.ts`, `lane-copy.ts`, the `format*` functions) rather
than inline at the send site: a preview showing text that is not what ships would
be worse than no preview (L41).

`scripts/test-alert-preview-coverage.ts` keeps it honest: every catalog key has a
rendered state, every condition previews its all-clear too, the render is
deterministic (so a diff means the copy changed, not the clock), and no message
renders `undefined`, `NaN`, `[object Object]`, a leaked null, or a raw JSON blob.
A new alert cannot ship unreadable.

Note the guard also fails an alert that OPENS with the word **Slate**. In Slack
every one of these arrives under Slate's own app name and icon, so a "Slate:" (or
"Slate routing check:") label repeats the header and pushes the one fact worth
having further along a line read on a phone. Naming Slate inside a sentence is
fine and often necessary.

## Read lead-facing copy before it ships (`pnpm preview:booker`, #1343)

The copy a CUSTOMER reads had the same gap alert copy did: no way to look at it
before it shipped. The 2026-08-07 design session was a person clicking through a
mockup one screen at a time, catching a policy sentence that made the panel about
us, a message saying "pick another" without saying another what, dates in British
order, a pronoun we cannot know, and two sentences running together on one line.
None of it could have been found by reading the code.

**Run `pnpm preview:booker` before changing any wording on the booker or the manage
page, and read the diff in review.** It prints every string a lead can read,
grouped by screen and by the state that produces it, including the lines only
assistive tech hears, and its own last line says how many lines across how many
screens that came to.

The rule that makes it trustworthy is the same one as `preview:alerts`: it CALLS
the real copy builders and holds no wording of its own (L41). That is why the copy
lives in `src/lib/booking/booker-copy.ts` and `manage-copy.ts` rather than inline
in the components. **A string a lead can read belongs in those files**; the
component keeps the markup (a link, a tabular-nums span, a heading level), the
builder keeps the words.

Two guards, and each is blind where the other looks:

- `scripts/test-booker-preview-coverage.ts` (node): every state renders a real
  string, nothing leaks `undefined` / `NaN` / a raw blob, the render is
  deterministic (a builder reading the clock fails the build), the copy rules hold
  (no dashes, no emoji), and **no literal may be assigned to a `text` in the
  preview**.
- `src/components/copy-preview-parity.test.tsx` (vitest): mounts the real
  components and asserts the BUILDER's exact output is on screen. A static scan
  cannot mount React, so without this a component could go back to holding its own
  inline sentence while the preview rendered happily from the builder, showing text
  that no longer ships. That is worse than no preview, because it would be believed.

### A copy builder takes its clock (the `// clock-ok:` convention, #2497)

A sentence naming a day ("today", "tomorrow", "Thursday") is a relationship
between the appointment and the reader's present, so a builder that pins one end
and reads the other for itself renders a different sentence every day from the
same input. `dayWord` in `src/lib/booking/reminder.ts` did exactly that: its test
pinned the clock to a constant, the suite passed on the day it merged and went red
at midnight on 2026-09-17 with no code change, which skipped main's deploy and left
#2484's monitoring floor merged and not live.

**The determinism check that was supposed to catch it structurally could not.**
Rendering twice and comparing cannot see a clock read, because the clock does not
move between two renders a millisecond apart, so it read clean over the defect it
is named for (L713). `scanCopyClockReads` (`scripts/lib/scan-copy-clock-reads.ts`)
is the half that works: it reads the SOURCE of every copy module in
`src/lib/booking` plus `reminder.ts`, enumerated by GLOB rather than a hand written
list, so a module added tomorrow is covered by construction (L96).

It matches four spellings as text (`Date.now(`, `new Date()`, `DateTime.now(`,
`DateTime.local(`) and says in its own header what it cannot see: a clock reached
through an imported helper or an injected collaborator is not flagged.

**The escape hatch is `// clock-ok: <why>`**, on or in the `//` block directly
above the line, refused when it carries no reason, and a refused one is reported as
an unreasoned hatch rather than as a plain clock read, since the two send a reader
to do different things. It is deliberately its OWN token and not `error-ok` or
`parse-ok`: those are written about a database read or write, and putting a second
rule behind an existing suppression widens every existing use of it (L448).

**The alert preview carries the same scan** (#2502). Its copy cannot be globbed the
way the booker's can, because it lives across the monitoring tree in `*/alert-copy.ts`,
`lane-copy.ts` and a few dozen `format*` builders beside the check they describe, and a
hand written list of those would be exempt the moment somebody added the next one
(L96). So the list is DERIVED from what `src/lib/notify/alert-preview.ts` IMPORTS
(`scripts/lib/scan-alert-copy-modules.ts`): the preview is by construction the one
place naming every builder whose words reach Slack, since a builder it does not call
renders nothing to preview. The preview itself is scanned alongside them, because it
seeds every builder's fixtures.

Direct imports only, one hop, and the WHOLE module rather than the imported binding.
Both are deliberate: transitive coverage reaches most of `src` within three hops and
would flag unrelated runtime clock reads, which is how a guard gets switched off (L36);
and #2497's clock read was in `dayWord`, a local helper the exported builder called, so
a scan narrowed to the binding would have missed the only instance this family has had.
An import that resolves to no file is REPORTED rather than dropped, or a rename would
shrink the scanned set while everything left still read as clean (L98).

It found one live instance, in a module the preview imports one builder from:
`selectCandidates` in `src/lib/monitor/calcom-override-sweep.ts` defaulted `nowMs` to
`Date.now()`. `nowMs` is required now. The default was a seam nobody had to use, and
the one caller that skipped it was a test whose fixture start was pinned to a constant
while its horizon walked with real time, so the pair had drifted out of the window the
assertion names (L130).
