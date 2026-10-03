# No browser or end-to-end tests in CI, with a production canary instead

CI green means unit logic plus a full production build. There is no Playwright
config in the repo and no automated browser test in CI. The funnel is covered
post-deploy by a scheduled canary against live production instead.

## Status

**Superseded on 2026-10-03 by [0011](./0011-browser-checks-before-merge.md)** (Dan's
decision, #3079, #3100): browser checks now run before merge against a production
build on a local stack. The premise below was about `next dev`, which that run does
not use. Kept for the reasoning; nothing below is current.

Accepted (#611, audit AUD-037). Recorded here because the decision reads as an
omission until you know it was deliberate (#1053); the reasoning lives in
`AGENTS.md` under "What CI covers".

## Why

Screenshots and DOM assertions against `next dev` are unstable to automate: the
`.pn-*` entrance and pulse keyframes never settle, and font loading stalls a
full-page capture. A headless browser job built on that would be flaky, and a flaky
gate is worse than no gate, because the response to a random failure is to re-run
rather than to look.

## What covers the funnel instead

The scheduled canary (`.github/workflows/smoke-canary.yml`) runs the real smoke
scripts against live production on isolated SMOKE agents and buckets, so it can never
touch a real agent (#396): a side-effect-free health tick every 30 minutes, and every
6 hours a full strict pass plus the reschedule smoke, which is the only automated
proof that a booking can be made, moved and cancelled end to end. Any failure posts a
Slack alert, and a dead man's switch pages if the schedule silently stops firing.

So the safety net is post-deploy rather than pre-merge. That is the trade, stated
plainly: a broken funnel is caught within 30 minutes of shipping rather than before
merging.

## Consequences

- The canary is load bearing. Keeping it healthy is the maintenance obligation this
  decision creates, and a canary that has stopped concluding is the failure mode to
  watch for (#1394).
- Visual and DOM checks are done with the Playwright MCP against a running dev server
  during development, by a person, not in CI.
- Before adding a browser job, read this record and #611: the compensating control is
  the thing to strengthen instead.
