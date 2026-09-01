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
| `pnpm test` (about 320 node suites) | The pure logic, plus the repo invariants below. |
| `pnpm test:components` (vitest) | Route handlers, components, and anything needing module mocking. |
| `pnpm cf:build` | The real Cloudflare/OpenNext build, so a build-only break cannot reach main. |
| The test gate | A push whose changes carry no test. Overridable with `SKIP_TEST_CHECK=1`, once, out loud. |
| The style gate | An em dash, en dash or emoji in new lines. |
| The stale-main guard | A branch cut from a stale ref that carries another change's commits. |
| The workflow-settings check | A workflow referencing a repo variable or secret that does not exist, which GitHub interpolates as the empty string rather than failing. |
| `migration-drift` (CI) | Code shipping ahead of an unapplied migration. |
| `security-scan` (CI) | A secret in the commits a push adds, not merely in the working tree. |
| `merge-gap` (CI) | A commit pushed to a branch whose PR already merged, which would strand it. |
| The `main-push-guard` (CI) | A direct push to main, or a merge of a red PR. **Detective**, not preventive: it runs after the push and pages, because native branch protection needs a paid plan. |

On top of those sit about two dozen repo invariant guards, each written after a
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

## When to break the model

Get a second pair of eyes, before merging, when the change:

- weakens a security control (an auth check, a rate limit, a scanner allowlist), which
  additionally needs explicit sign-off and must never be pushed first;
- deletes or rewrites data, or changes a retention or erasure path;
- changes the cal.com URL or embed contract, or the webhook payload Regal consumes,
  since both are contracts with something outside this repo;
- turns a guard off, or widens one of its escape hatches.
