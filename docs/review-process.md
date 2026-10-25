# How code gets reviewed here

Slate is reviewed by **self-merge with automated gates as the reviewer**. A PR is
opened, the gates run, and it merges within seconds, then auto-deploys. There is no
second person, no CODEOWNERS, and no approval step.

That is a deliberate model for a one-engineer project, not an accident (#1043). What
follows is what actually substitutes for a human reviewer, so the trade can be
judged rather than assumed, and what the gates provably cannot do.

## What the gates check, and where

Every one of these runs **before** a push lands, in the pre-push hook, and again in
CI. The hook is what makes them meaningful: a check that only runs after the merge
is a report, not a gate.

| Gate | What it prevents |
|---|---|
| `tsc --noEmit` | A type error, including in every construction site a changed interface touches. This is doing more work than it looks: several invariants here are held by making a field required so the compiler enumerates the callers. |
| `pnpm test` (the node suites; the run prints how many) | The pure logic, plus the repo invariants below. |
| `pnpm test:components` (vitest) | Route handlers, components, and anything needing module mocking. |
| `pnpm cf:build` | The real Cloudflare/OpenNext build, so a build-only break cannot reach main. |
| The test gate | A push whose changes carry no test. Overridable with `SKIP_TEST_CHECK=1`, once, out loud. |
| The style gate | An em dash, en dash or emoji in new lines. |
| The stale-main guard | A branch cut from a stale ref that carries another change's commits. |
| The workflow-settings check | A workflow referencing a repo variable or secret that does not exist, which GitHub interpolates as the empty string rather than failing. |
| The migration drift check (CI, in `static-checks`) | Code shipping ahead of an unapplied migration. |
| `security-scan` (CI) | A secret in the commits a push adds, not merely in the working tree. |
| `merge-gap` (CI) | A commit pushed to a branch whose PR already merged, which would strand it. |
| The `main-push-guard` (CI) | A direct push to main, or a merge of a red PR. **Detective**, the backstop behind the "Protect main" ruleset (#4197), which now prevents both: it runs after the push and pages, so it matters only if the ruleset is switched off. |

On top of those sit the repo invariant guards, each written after a
defect got through: capped single-page reads, swallowed error reads, raw
`Date.parse`, unclassified alert keys, alert copy carrying a raw error, api.md
route coverage, and so on. They are the accumulated memory of what a reviewer here
would have missed, which is the honest description of what they are for.

## What no gate can do

Three things, stated plainly because they are what a second person would be for:

1. **Judgement about whether a permission is too broad.** A test proves the code does
   what it says. Nothing notices that what it says lets a manager edit an admin. This
   is the real gap, and it is partly covered: a push touching the authorization,
   webhook, routing or schema surfaces prints a reminder to run `/security-review`
   (`.githooks/lib/security-review-reminder.sh`). It is a reminder and not a gate on
   purpose, because a blocking version could only ever be satisfied by skipping it.
2. **Whether the change was worth making.** No gate has an opinion about scope,
   product fit, or whether a simpler design existed.
3. **Whether the tests test the right thing.** The test gate checks that a test
   exists and (through a model judge) that error paths are exercised. A test that
   asserts the wrong invariant passes every gate here. The compensating habit is the
   one written all over this codebase: a guard is only real once it has been seen to
   fail, so a new guard ships with a control that proves it catches the defect.

## The one boundary nothing pre-merge touches

Named because it is the highest-risk uncovered thing in the repo, and leaving it unnamed
makes it look overlooked (#1050): **no test before a merge talks to a real Supabase or a
real Google.** The Supabase query chain is mocked, which means a mock and the real
client agree by construction, and a chain that is subtly wrong (a filter that does not
apply, a column that no longer exists) passes every gate here.

What covers it instead, and it is a real set rather than a shrug:

- the **migration drift check** (in the `static-checks` job), so code cannot merge expecting schema that is not applied;
- the **swallowed-error guards**, which is the class that made a broken query
  indistinguishable from an empty result, the thing that actually hurt (#277, #1629, #1641);
- the **capped-read guards**, for the other way a query lies quietly;
- the **post-deploy probe** and the **canary**, which run the funnel against the real
  database within minutes of a merge.

The depth increase the audit suggested was a nightly lane running a handful of
booking and availability tests against a disposable Supabase branch. It is **not built**,
deliberately: it would catch a query-chain break a few hours earlier than the canary
already does, and it needs a second environment to keep in sync, which is the cost ADR
0007 declines for the same reason.

What would change it: a query-chain break actually reaching production and not being
caught by the canary. That is the evidence this decision is wrong, and none exists yet.
If it happens, the nightly lane is the answer, and the Supabase branch it needs is the
same reversal ADR 0007 names.

## What compensates after the merge

Because the gates are pre-merge and the risk is post-merge, the net is deliberately
downstream as well:

- the **post-deploy probe** refuses to judge health until the expected commit is live;
- the **smoke canary** proves the funnel end to end against production every 6 hours,
  on isolated test agents and buckets, and pages on failure;
- the **monitor lane** re-measures the system every minute, with a dead man's switch
  on every lane;
- **alert copy is previewable** (`pnpm preview:alerts`, `pnpm preview:booker`), so the
  one surface a reviewer would have read is readable before it ships.

## What is expected of a PR

The template (`.github/pull_request_template.md`) asks for the three things a reader
needs later and cannot reconstruct: what changed and why, the test evidence, and the
migration status. Those are the fields, and they exist because the PR body is the
only durable record of a decision made without a conversation.

It also asks whether the change makes a decision somebody could reasonably try to
undo later, and if so, for an architecture decision record in the same PR
(`docs/adr/`, with the rule for when one is due in `docs/adr/README.md`, "When to
write one"). A PR body is findable only by somebody who already knows which PR to
read; a decision record is where the next engineer looks before undoing something
(#3130).

## When a UI PR is ready

The gates cover a11y in exactly one place: the contrast guard, which checks the token
pairings in both themes on every push. Everything else about an interface (focus order,
keyboard reachability, an ARIA misuse, a heading jump, a control with no accessible
name) is invisible to every check in this repo, and axe finds most of it in seconds.

So a PR that adds or restyles a surface carries **an axe run in both themes**, saved to
`docs/a11y/axe/<surface>-<theme>.axe.json`, following
`.claude/skills/slate-ui-verification/SKILL.md`. Both themes is not thoroughness for its
own sake: the internal pages support light and dark, and a contrast or focus defect
routinely exists in exactly one of them.

If a UI change ships without one, the PR says why in the body. That is the whole
enforcement, and it is honest about what it is: an axe job in CI is a deliberate non-goal
(ADR 0004), so this is a habit written down where a PR author is looking, not a gate.

## When to break the model

Get a second pair of eyes, before merging, when the change:

- weakens a security control (an auth check, a rate limit, a scanner allowlist), which
  additionally needs explicit sign-off and must never be pushed first;
- deletes or rewrites data, or changes a retention or erasure path;
- changes the cal.com URL or embed contract, or the webhook payload Regal consumes,
  since both are contracts with something outside this repo;
- turns a guard off, or widens one of its escape hatches.
