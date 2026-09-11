import { envOr } from "./smoke-env.ts";
// THROWAWAY (benchmark). Slot-load latency: Slate vs trypennie.cal.com, same
// xbc codes, same agents. Read-only (GET availability/slots on both). Delete after.
//
// Validate one code:   node --experimental-strip-types scripts/spike-slotload-bench.ts 411
// Full 60-code sweep:  node --experimental-strip-types scripts/spike-slotload-bench.ts
//
// NOTE: Slate's number only reflects BOOKABLE agents. Until the roster is flipped
// bookable + synced, the Slate side is not at scale — run the full sweep AFTER the
// flip for the real comparison; use the single-code validate to confirm wiring now.

// `envOr`, not `??`: SLATE_BASE became a WIRED workflow variable when the load run
// landed (#2244), and an unset `${{ vars.X }}` arrives as the EMPTY STRING, which
// `??` accepts. The fallback would then never apply and this bench would point at
// an empty base rather than at production (#1498).
const SLATE_BASE = envOr(process.env.SLATE_BASE, "https://slate.trypennie.app");
const CAL_BASE = "https://trypennie.cal.com";
const ROUTER_FORM = "fa681846-d287-4f18-9d8a-5e3ff306386f";
const TZ = "America/New_York";
const REPS = Number(process.env.REPS ?? 8);

const argCodes = process.argv.slice(2).filter((a) => /^[1-5][0-3][0-2]$/.test(a));
const ALL_CODES: string[] = [];
for (const a of "12345") for (const b of "0123") for (const c of "012") ALL_CODES.push(`${a}${b}${c}`);
const codes = argCodes.length ? argCodes : ALL_CODES;

const now = new Date();
const fromIso = now.toISOString();
const toIso = new Date(now.getTime() + 14 * 86_400_000).toISOString();

async function timed(url: string, headers: Record<string, string> = {}): Promise<{ ms: number; status: number; ok: boolean }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers });
    await res.text(); // drain body so timing covers full response
    return { ms: performance.now() - t0, status: res.status, ok: res.ok };
  } catch {
    return { ms: performance.now() - t0, status: 0, ok: false };
  }
}

/** Resolve an xbc code to cal.com's slots/available URL via the router redirect. */
async function calSlotsUrl(code: string): Promise<string | null> {
  const routerUrl = `${CAL_BASE}/router?form=${ROUTER_FORM}&xbc=${code}`;
  const res = await fetch(routerUrl, { redirect: "manual" });
  const loc = res.headers.get("location");
  if (!loc) return null;
  const u = new URL(loc, CAL_BASE);
  const parts = u.pathname.split("/").filter(Boolean); // ["team","loan-consult","income"]
  const teamSlug = parts[1];
  const eventSlug = parts[2];
  const memberIds = (u.searchParams.get("cal.routedTeamMemberIds") ?? "").split(",").filter(Boolean);
  const formResp = u.searchParams.get("cal.routingFormResponseId") ?? "";
  if (!teamSlug || !eventSlug) return null;

  const p = new URLSearchParams({
    isTeamEvent: "true",
    eventTypeSlug: eventSlug,
    startTime: fromIso,
    endTime: toIso,
    timeZone: TZ,
    orgSlug: "trypennie",
    routingFormResponseId: formResp,
  });
  p.append("usernameList[]", teamSlug);
  for (const id of memberIds) p.append("routedTeamMemberIds[]", id);
  return `${CAL_BASE}/api/v2/slots/available?${p.toString()}`;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const fmt = (xs: number[]) => xs.length ? `p50=${pct(xs, 50).toFixed(0)}ms p95=${pct(xs, 95).toFixed(0)}ms (n=${xs.length})` : "no data";

console.log(`Window ${fromIso.slice(0, 10)}..${toIso.slice(0, 10)}, ${REPS} reps/code, ${codes.length} code(s).`);
console.log(`Slate: ${SLATE_BASE}/api/availability   cal.com: ${CAL_BASE}/api/v2/slots/available\n`);

const slateAll: number[] = [];
const calAll: number[] = [];
for (const code of codes) {
  const calUrl = await calSlotsUrl(code);
  const slate: number[] = [];
  const cal: number[] = [];
  let slateStatus = 0, calStatus = 0;
  for (let i = 0; i < REPS; i++) {
    const s = await timed(`${SLATE_BASE}/api/availability?bucket=${code}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`);
    slateStatus = s.status;
    if (s.ok) { slate.push(s.ms); slateAll.push(s.ms); }
    if (calUrl) {
      const c = await timed(calUrl);
      calStatus = c.status;
      if (c.ok) { cal.push(c.ms); calAll.push(c.ms); }
    }
  }
  console.log(`xbc ${code}: Slate[${slateStatus}] ${fmt(slate)}   |   cal.com[${calStatus}] ${fmt(cal)}${calUrl ? "" : "  (router did not resolve)"}`);
}

if (codes.length > 1) {
  console.log(`\n=== OVERALL ===`);
  console.log(`Slate   : ${fmt(slateAll)}`);
  console.log(`cal.com : ${fmt(calAll)}`);
}
