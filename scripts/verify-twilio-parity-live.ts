// Does Slate hold the same routing facts as the system that actually feeds cal.com?
//
//   pnpm verify:twilio-parity
//
// WHY. Slate reads each agent's debt tiers and backend service from Salesforce
// booleans (`LowDebt__c` and friends, `src/lib/salesforce/sync.ts`). cal.com is fed
// the same facts by a Pipedream job that reads each Twilio TaskRouter worker's
// `teams` tags. Two sources for one set of facts, and nothing reconciles them, so
// the agreement `pnpm verify:calcom-parity` reports is maintained by whoever keeps
// Salesforce and Twilio in step rather than by anything structural (#2096).
//
// `Redistribute` is the reason this was written. It exists ONLY as a Twilio tag: the
// Salesforce User object carries 14 custom fields and none is this one (checked
// 2026-09-08), and cal.com will not report per-user attribute values. So Twilio is
// the only place Slate can learn that an agent should not be taking booked calls,
// and until this command there was no way to see it at all.
//
// IT WRITES NOTHING. No Slate row, no Twilio worker, no cal.com attribute, no alert.
// It is the measurement that decides how wide the eventual sync should be, and it is
// deliberately NOT named `test-*.ts`, because that glob is the offline unit suite and
// this needs live Twilio plus the Supabase secret key.
//
// env-ok: TWILIO_API_KEY_SID (required; a TaskRouter-scoped API key, used as the
//   basic-auth username exactly as the Pipedream job does)
// env-ok: TWILIO_API_KEY_SECRET (required; the matching secret)
// env-ok: TWILIO_WORKSPACE_SID (required; the TaskRouter workspace holding the workers)
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { unwrap } = await import("@/lib/db/result");
const { readWorker, mergeWorkers, compareOne, TWILIO_VERDICT_RANK } = await import("./lib/twilio-roster.ts");
type TwilioSide = import("./lib/twilio-roster.ts").TwilioSide;
type TwilioVerdict = import("./lib/twilio-roster.ts").TwilioVerdict;

/** Every way this ends, each on its own code. Finding nothing to compare is never a pass (L98). */
const EXIT: Record<string, number> = {
  agree: 0,
  notConfigured: 1,
  nothingToCompare: 2,
  twilioUnreachable: 3,
  twilioUnreadable: 4,
  "absent-from-twilio": 11,
  "duplicate-worker": 12,
  "unmapped-tag": 13,
  "absent-from-slate": 14,
  "legal-differs": 15,
  "backend-differs": 16,
  "debt-teams-differ": 17,
  "redistribute-still-bookable": 18,
};

function stop(code: number, why: string): never {
  console.error(`\n${code === 0 ? "OK" : "FAILED"} (${code}): ${why}`);
  process.exit(code);
}

const sid = process.env.TWILIO_API_KEY_SID ?? "";
const secret = process.env.TWILIO_API_KEY_SECRET ?? "";
const workspace = process.env.TWILIO_WORKSPACE_SID ?? "";
if (!sid || !secret || !workspace) {
  stop(
    EXIT.notConfigured,
    "needs TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET and TWILIO_WORKSPACE_SID in .env.local. Nothing was attempted.",
  );
}

const authHeader = `Basic ${Buffer.from(`${sid}:${secret}`).toString("base64")}`;

/** Every worker, paged. Guards a repeating page token, which the Pipedream job hit. */
async function fetchWorkers(): Promise<{ attributes?: string }[]> {
  const all: { attributes?: string }[] = [];
  let pageToken: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const url = new URL(`https://taskrouter.twilio.com/v1/Workspaces/${workspace}/Workers`);
    url.searchParams.set("PageSize", "200");
    if (pageToken) url.searchParams.set("PageToken", pageToken);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: authHeader } });
    } catch (err) {
      stop(EXIT.twilioUnreachable, `Twilio did not answer: ${String(err).slice(0, 200)}`);
    }
    if (res.status === 401 || res.status === 403) {
      stop(EXIT.twilioUnreachable, `Twilio refused the credentials (${res.status}). Check the API key is TaskRouter-scoped.`);
    }
    if (!res.ok) stop(EXIT.twilioUnreachable, `Twilio's worker listing returned ${res.status}`);
    const body = (await res.json().catch(() => null)) as
      | { workers?: { attributes?: string }[]; meta?: { next_page_token?: string | null } }
      | null;
    if (!body || !Array.isArray(body.workers)) {
      stop(EXIT.twilioUnreadable, "Twilio's worker listing answered with no readable list");
    }
    all.push(...body.workers);
    const next = body.meta?.next_page_token ?? null;
    if (!next || seen.has(next)) break;
    seen.add(next);
    pageToken = next;
  }
  return all;
}

const workers = await fetchWorkers();
if (workers.length === 0) {
  // REFUSED. An empty worker list makes every Slate agent look absent from Twilio,
  // which is a hundred findings about one broken read, and zero is never a healthy
  // answer for a roster of this size (L98).
  stop(EXIT.nothingToCompare, "Twilio returned no workers at all, so nothing was compared");
}

const byEmail = new Map<string, TwilioSide[]>();
let unreadable = 0;
for (const w of workers) {
  const side = readWorker(w.attributes);
  if (!side) { unreadable++; continue; }
  const list = byEmail.get(side.email) ?? [];
  list.push(side);
  byEmail.set(side.email, list);
}

// cap-safe: users is a roster-bounded table, ~148 rows against a 200-agent design target
const slateUsers = (unwrap(
  await supabaseAdmin().from("users").select("email, bookable, deactivated_at, is_test, attributes"),
  "all users",
) ?? []) as {
  email: string;
  bookable: boolean;
  deactivated_at: string | null;
  is_test: boolean;
  attributes: Record<string, unknown> | null;
}[];
const realUsers = slateUsers.filter((u) => !u.is_test);
if (realUsers.length === 0) stop(EXIT.nothingToCompare, "read no non-test Slate users, so nothing was compared");

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).sort() : typeof v === "string" ? [v] : [];

console.log(
  `twilio parity: ${workers.length} Twilio worker(s) covering ${byEmail.size} address(es), ` +
    `against ${realUsers.length} non-test Slate user(s)` +
    (unreadable > 0 ? `\nnote: ${unreadable} worker(s) carry no readable email and were not compared` : ""),
);

const rows: { email: string; verdict: TwilioVerdict; detail: string }[] = [];
const seenSlate = new Set<string>();
for (const u of realUsers) {
  const key = String(u.email).toLowerCase();
  seenSlate.add(key);
  const sides = byEmail.get(key);
  const twilio = sides ? mergeWorkers(sides).merged : null;
  const duplicates = sides ? mergeWorkers(sides).duplicates : 0;
  const attrs = u.attributes ?? {};
  const { verdict, detail } = compareOne(
    twilio,
    {
      email: key,
      debtTeams: asList(attrs.debt_team),
      backendServices: asList(attrs.backend_service),
      legalEligibleN: String(attrs.legal_eligible ?? "") === "N",
      bookable: u.bookable,
      deactivated: u.deactivated_at !== null,
    },
    duplicates,
  );
  rows.push({ email: u.email, verdict, detail });
}
// A Twilio worker with no Slate row, carried through rather than dropped: iterating
// only Slate's side is how somebody cal.com is being fed can be invisible.
for (const [email, sides] of byEmail) {
  if (seenSlate.has(email)) continue;
  const { verdict, detail } = compareOne(mergeWorkers(sides).merged, null);
  rows.push({ email, verdict, detail });
}

const findings = rows
  .filter((r) => TWILIO_VERDICT_RANK[r.verdict] > 0)
  .sort((a, b) => TWILIO_VERDICT_RANK[b.verdict] - TWILIO_VERDICT_RANK[a.verdict] || a.email.localeCompare(b.email));
if (findings.length > 0) {
  console.log("\n--- findings ---");
  for (const r of findings) console.log(`${r.verdict}  ${r.email}\n    ${r.detail}`);
}

const counts = new Map<string, number>();
for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
console.log(
  "\n" + [...counts.entries()].sort((a, b) => TWILIO_VERDICT_RANK[b[0] as TwilioVerdict] - TWILIO_VERDICT_RANK[a[0] as TwilioVerdict])
    .map(([v, n]) => `${v}: ${n}`).join("   "),
);
const uncomparable = new Set(["absent-from-slate", "absent-from-twilio", "not-our-worker"]);
const compared = rows.filter((r) => !uncomparable.has(r.verdict)).length;
console.log(`${compared} of ${rows.length} address(es) had facts on both sides to compare`);
if (compared === 0) {
  stop(EXIT.nothingToCompare, "not one address had facts on both sides, so nothing was judged");
}

// `not-our-worker` ranks level with agreement, so it is never in `findings` and
// deliberately carries no exit code: sixteen vendor accounts must not be able to
// name a run. Asserted here rather than assumed, because a rank changed later would
// otherwise index EXIT with undefined and exit 0 on a real finding.
const worst = findings[0];
if (worst && EXIT[worst.verdict] === undefined) {
  stop(EXIT.twilioUnreadable, `no exit code for verdict "${worst.verdict}", so this run cannot be judged`);
}
if (!worst) stop(EXIT.agree, `Slate and Twilio agree on all ${compared} address(es) compared`);
const n = findings.filter((f) => f.verdict === worst.verdict).length;
stop(EXIT[worst.verdict]!, `${n} address(es) reported ${worst.verdict}: ${findings.filter((f) => f.verdict === worst.verdict).slice(0, 6).map((f) => f.email).join(", ")}`);
