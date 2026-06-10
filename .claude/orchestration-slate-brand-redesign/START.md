# Slate Brand Redesign Orchestrator

When `/start` (or "begin execution") is invoked, this orchestrator manages sequential
execution of all 28 tasks across 5 phases. Code-centric redesign; surfaces are Code + Browser.

---

## Startup Sequence

1. **Read PROGRESS.md** (`.claude/orchestration-slate-brand-redesign/PROGRESS.md`) — current state.
2. **Read PHASES.md** — full action plan + dependency graph + execution protocol.
3. **Verify surfaces** — Playwright MCP available (loads at session start), Peekaboo CLI responds,
   `pnpm dev` boots on :3000.
4. **Identify next task** — lowest-numbered pending task whose blocked-by deps are all `done`.
5. **Execute** — spawn a subagent (below).
6. **After completion** — confirm PROGRESS.md updated with status + evidence, then repeat from 4.

---

## Spawning a Subagent

For each task, spawn a `general-purpose` subagent:

```
You are executing Task N.M for the Slate Brand Redesign.

## Your Task File
Read your full spec at: .claude/orchestration-slate-brand-redesign/tasks/phase-N/task-N-M.md

## Execution Protocol
### Phase 0: Orient
- Read PROGRESS.md to confirm this task is next and its deps are done.
- Read your task file fully (objective, surfaces, actions, acceptance, verification).
- Read ALL skills in your task's Skills field (.claude/skills/).
- Read the research files your task references.
### Phase 1: Explore & Plan
- Read the actual source files you'll modify; understand current state + what prior tasks produced.
- Plan the MINIMAL visual-only change. NEVER alter logic (DISCOVERY D5).
### Phase 2: Execute
- [code]/[file] → Read / Write / Edit / Bash. Use design tokens / .pn-* classes, never raw hex.
- [browser] → Playwright MCP (navigate, snapshot, screenshot, evaluate for axe).
### Phase 3: Verify (MANDATORY) — per action:
  Execute → Verify (surface method) → pass? next : analyze→adjust→retry (max 3) → escalate.
  - [code]: `pnpm build` exit 0 / `pnpm lint` clean / `pnpm test` green
  - [browser]: snapshot + screenshot both themes; compare to DS preview/*.html; axe clean
  - [file]: read back; grep for stray neutral-/emerald-/amber-/red-/green-/#hex
### Phase 4: Complete
- Update PROGRESS.md: status=done, date, verification pass/fail, evidence paths (reports/).
- Confirm all acceptance criteria met.

## Hard constraints
- VISUAL-ONLY. No changes to booking logic, availability cache, Google sync, round-robin,
  webhooks, auth/RBAC, server actions, DB. If a restyle seems to need logic change → STOP & flag.
- Do NOT break the cal.com embed contract (Cal() API, data-cal-*, URL params,
  slate:resize/bookingSuccessful). widget.js stays vanilla.
- Use the licensed woff2 (400+600), never the personal-use OTFs.

## Key references
- DISCOVERY.md (top authority) · PHASES.md (plan) · research/ · reports/surface-verification.md
- Skills: pennie-design-system-in-slate, slate-ui-verification, slate-embed-contract
- Execution surfaces: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md
```

### Verification sweep tasks (x.V) — different prompt
Re-verify ALL deliverables from the phase across surfaces; screenshot key states both themes;
run build/lint/test + axe/Lighthouse on changed surfaces; grep stray colors; check cross-surface
coherence; fix failures and re-verify until green; record evidence in PROGRESS.md.

### Final phase (5) — comprehensive verification
Every surface checked in both themes + mobile; every D17/D18 a11y criterion validated;
build/lint/test green; booking E2E (standalone + embed); cal.com contract + CF deployability
intact; write reports/final-verification.md.

---

## Available Tools

### Playwright MCP (Browser) — loads at session start
browser_navigate, browser_snapshot, browser_take_screenshot, browser_evaluate (axe inject),
browser_resize, browser_click, browser_fill_form, browser_press_key, emulate reduced-motion.

### Peekaboo CLI (Native, fallback) 3.4.0
`peekaboo image`, `peekaboo see --app`, `peekaboo list windows`.

### Code / Files
Read, Write, Edit, Glob, Grep, Bash (`pnpm dev/build/lint/test`, `npx lighthouse`).

NOTE: the sandboxed Bash shell may lack `curl`/coreutils on PATH — use Node's global `fetch`
(`node -e '...'`) for HTTP probes (Node 24).

---

## Orchestrator Rules

- ONE task at a time, in numeric order; finish a phase (incl. its x.V sweep) before the next.
- Before spawning, confirm all blocked-by deps are `done` in PROGRESS.md.
- Note: 2.2–2.5 edit Booker.tsx and 3.2/3.3 edit admin/me — run sequentially to avoid edit collisions.
- **Auth blocker:** before 3.V and 5.1/5.2 for admin/me, resolve the OAuth gate (logged-in
  Playwright profile / injected Supabase session / user screenshots). If unresolved, mark those
  surfaces BLOCKED (never PASS).

### Failure Handling (3-Tier)
1. Subagent self-recovery (debug/retry/alt approach, max 3).
2. Orchestrator: read error + PROGRESS notes, spawn a targeted fix subagent, re-run.
3. User escalation: task #, surface, attempt, error, suggested fix; continue other unblocked tasks.

### Session Boundaries
PROGRESS.md is the continuity mechanism — a fresh session reads it first. If context grows large,
report progress and suggest a fresh session.

---

## File Locations

| File | Path |
|------|------|
| Master plan | `.claude/orchestration-slate-brand-redesign/PHASES.md` |
| Orchestrator | `.claude/orchestration-slate-brand-redesign/START.md` (this file) |
| Discovery (authority) | `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` |
| Project brief | `.claude/orchestration-slate-brand-redesign/PROJECT-BRIEF.md` |
| Research | `.claude/orchestration-slate-brand-redesign/research/` |
| Task files | `.claude/orchestration-slate-brand-redesign/tasks/phase-N/task-N-M.md` |
| Progress | `.claude/orchestration-slate-brand-redesign/PROGRESS.md` |
| Skills | `.claude/skills/{pennie-design-system-in-slate,slate-ui-verification,slate-embed-contract}/` |
| Reports | `.claude/orchestration-slate-brand-redesign/reports/` |
