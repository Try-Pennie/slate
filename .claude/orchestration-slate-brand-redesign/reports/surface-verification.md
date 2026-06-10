# Surface Verification Report — Slate Brand Redesign

**Date**: 2026-06-09
**Phase**: 5–6 (Tool + Surface Setup & Verification)
**Verifier**: Main agent

> Verifies the TOOLING and SURFACES the redesign + its verification depend on. The redesign
> itself is not built yet (planning). Re-run the per-surface screenshot/axe walk at execution
> time (see `research/verification-toolchain-execution.md`).

## Tool / Surface Inventory + Status

| Tool/Surface | Type | Status | Test Performed | Notes |
|---|---|---|---|---|
| Peekaboo CLI | CLI | ✅ PASS | `peekaboo --version` → 3.4.0 | Screenshot fallback for browser verify |
| Playwright MCP | MCP | ⚠️ CONFIGURED | `claude mcp list` → playwright ✔ Connected (user scope) | Tools load at SESSION START — available at execution time, not this session |
| Node | Runtime | ✅ PASS | `node --version` → v24.12.0 | global `fetch` used for route probes |
| pnpm | PM | ✅ PASS | `pnpm --version` → 10.33.0 | dev/build/lint/test scripts present |
| npx / lighthouse | CLI | ✅ PASS | `npx --version` → 11.6.2 | `npx lighthouse` available for a11y/perf |
| Next dev server | Server | ✅ PASS | `pnpm dev` → Ready in 235ms, Next 16.2.7 Turbopack, port 3000 | boots from `.env.local` |
| `.env.local` | Config | ✅ PASS | present (3.3 KB); env.ts validates Supabase/Google/SF/Slack vars | local run works |
| File system | Files | ✅ PASS | orchestration folder + research/ writable | - |

## Route Reachability (live, dev server)

| Route | Status | Notes |
|---|---|---|
| `/` | 200 | landing (stub) |
| `/book?xbc=411&theme=light` | 200 | Booker renders; `neutral-*` grayscale present (to replace); "Pennie" present |
| `/book?xbc=411&theme=dark` | 200 | dark theme path |
| `/embed-example.html` | 200 | embed demo (static) |
| `/login` | 200 | Google-OAuth-only |
| `/widget.js` | 200 | embed script (static) |
| `/me` | 307 → /login | **AUTH-GATED** |
| `/admin` | 307 → /login | **AUTH-GATED** |

Canonical seed bucket for booking URLs: **`xbc=411`** (per README + test fixtures).

## Blocker — Authenticated surface verification (admin / me)

`/admin` and `/me` redirect to `/login`, which is **Google OAuth only** (`signInWithOAuth`,
no email/password). A headless Playwright/Peekaboo agent CANNOT self-authenticate. To
screenshot these surfaces at execution time, one of the following is required (HUMAN ACTION
— see Phase 5b decision):
1. **Reuse a logged-in browser profile** — point Playwright at a Chrome profile already
   signed into Slate (user logs in once).
2. **Inject a Supabase session** — paste a valid session cookie/JWT for a test admin user.
3. **User-supplied screenshots** — user logs in and captures admin/me states manually; agent
   verifies against them.

Public surfaces (Booker, embed, login, landing) have NO such blocker — fully auto-verifiable.

## Failure Protocol Result

No tool failed verification. The only gap is the auth-gated admin/me verification path, which
is a credential/human-action item, not a tool failure. Public-surface verification (the bulk
of the redesign's visible payload) is unblocked.

## Verdict

**Tooling: GREEN.** App boots, public surfaces reachable, all verification tools present.
Proceed. Resolve the admin/me auth path before the Phase-3 (internal pages) verification sweep
at execution time.
