// One-time import of the legacy OOO_Requests Google Sheet (exported as CSV)
// into ooo_requests. Idempotent: upserts on legacy_request_id, so re-runs are
// safe. NO side effects (no calendar/Slack/Cal.com writes — the old system
// already created those artifacts); the one carve-out is auditing that
// future-dated approved rows are covered by a busy block, with an opt-in
// slate-block backfill for the gaps.
//
// Run:  node --experimental-strip-types scripts/import-ooo-requests.ts <csv>            (dry run)
//       node --experimental-strip-types scripts/import-ooo-requests.ts <csv> --commit
//       node --experimental-strip-types scripts/import-ooo-requests.ts <csv> --commit --backfill-busy
import { readFileSync } from "node:fs";
import { join } from "node:path";

const csvPath = process.argv[2];
const commit = process.argv.includes("--commit");
const backfillBusy = process.argv.includes("--backfill-busy");
if (!csvPath) {
  console.error(
    "Usage: node --experimental-strip-types scripts/import-ooo-requests.ts <ooo_requests.csv> [--commit] [--backfill-busy]",
  );
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "../.env.local"), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const BASE = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1`;
const H = {
  apikey: env.SUPABASE_SECRET_KEY!,
  Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
  "content-type": "application/json",
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, { headers: H });
  const body = (await res.json()) as T;
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// --- minimal RFC4180 CSV parser (quoted fields, embedded commas/newlines) ---
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Legacy display_tz_id values like "GMT-04:00" -> Luxon-valid "UTC-04:00". */
const normalizeTzId = (tz: string): string => {
  const t = tz.trim();
  if (!t) return "America/New_York";
  if (/^GMT[+-]\d{2}:\d{2}$/i.test(t)) return t.replace(/^GMT/i, "UTC");
  if (/^GMT$/i.test(t)) return "Etc/UTC";
  return t;
};

const VALID_STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);

const [rawHeader, ...rawRows] = parseCsv(readFileSync(csvPath, "utf8"));
const header = rawHeader.map((h) => h.trim().toLowerCase());
const col = (row: string[], name: string): string => {
  const idx = header.indexOf(name);
  return idx === -1 ? "" : (row[idx] ?? "").trim();
};
console.log(`${rawRows.length} rows in ${csvPath}`);

const [org] = await get<{ id: string }[]>("organizations?select=id&limit=1");
if (!org) throw new Error("no organization row");
const users = await get<
  { id: string; email: string; manager_id: string | null }[]
>(`users?select=id,email,manager_id&org_id=eq.${org.id}`);
const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));

type ImportRow = Record<string, unknown> & {
  legacy_request_id: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
};
const toImport: ImportRow[] = [];
const skipped: { row: number; reason: string }[] = [];
const managerDisagreements: string[] = [];

rawRows.forEach((row, i) => {
  const line = i + 2; // 1-based + header
  const legacyId = col(row, "request_id");
  const agentEmail = col(row, "agent_email").toLowerCase();
  const managerEmail = col(row, "manager_email").toLowerCase();
  const status = col(row, "status").toLowerCase() || "pending";
  const startRaw = col(row, "start_time");
  const endRaw = col(row, "end_time");

  if (!legacyId) return skipped.push({ row: line, reason: "no request_id" });
  if (!VALID_STATUSES.has(status)) {
    return skipped.push({ row: line, reason: `unknown status "${status}"` });
  }
  const agent = userByEmail.get(agentEmail);
  if (!agent) {
    return skipped.push({ row: line, reason: `no Slate user for ${agentEmail || "(blank agent_email)"}` });
  }
  const starts = new Date(startRaw);
  const ends = new Date(endRaw);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
    return skipped.push({ row: line, reason: `unparseable times "${startRaw}" / "${endRaw}"` });
  }
  if (starts >= ends) {
    return skipped.push({ row: line, reason: "start_time is not before end_time" });
  }

  const manager = managerEmail ? userByEmail.get(managerEmail) : undefined;
  if (managerEmail && !manager) {
    managerDisagreements.push(
      `row ${line}: manager ${managerEmail} has no Slate user (snapshot left empty)`,
    );
  } else if (manager && agent.manager_id && agent.manager_id !== manager.id) {
    managerDisagreements.push(
      `row ${line}: sheet manager ${managerEmail} differs from Slate manager for ${agentEmail} (kept Slate's users.manager_id, imported the sheet snapshot)`,
    );
  }

  const created = new Date(col(row, "created_at"));
  toImport.push({
    legacy_request_id: legacyId,
    org_id: org.id,
    user_id: agent.id,
    manager_id: manager?.id ?? null,
    starts_at: starts.toISOString(),
    ends_at: ends.toISOString(),
    display_tz_id: normalizeTzId(col(row, "display_tz_id")),
    display_tz_label: col(row, "display_tz_label") || "ET",
    reason: col(row, "reason") || "(imported, no reason recorded)",
    notes: col(row, "notes") || null,
    status,
    rejection_note: col(row, "rejection_note") || null,
    side_effects: { imported: "ok (artifacts created by the legacy tool)" },
    created_at: Number.isNaN(created.getTime())
      ? starts.toISOString()
      : created.toISOString(),
  });
});

console.log(`\nready to import: ${toImport.length}`);
console.log(`skipped: ${skipped.length}`);
skipped.forEach((s) => console.log(`  row ${s.row}: ${s.reason}`));
if (managerDisagreements.length) {
  console.log(`\nmanager mismatches: ${managerDisagreements.length}`);
  managerDisagreements.forEach((m) => console.log(`  ${m}`));
}

// --- busy-block coverage audit for future-dated approved rows ---
const nowIso = new Date().toISOString();
const futureApproved = toImport.filter(
  (r) => r.status === "approved" && r.ends_at > nowIso,
);
const uncovered: ImportRow[] = [];
for (const r of futureApproved) {
  const blocks = await get<{ id: string }[]>(
    `busy_blocks?select=id&user_id=eq.${r.user_id}&starts_at=lt.${encodeURIComponent(r.ends_at)}&ends_at=gt.${encodeURIComponent(r.starts_at)}&limit=1`,
  );
  if (blocks.length === 0) uncovered.push(r);
}
console.log(
  `\nfuture-dated approved rows: ${futureApproved.length}; without an overlapping busy block: ${uncovered.length}`,
);
uncovered.forEach((r) =>
  console.log(`  ${r.legacy_request_id}: ${r.starts_at} -> ${r.ends_at}`),
);
if (uncovered.length && !backfillBusy) {
  console.log(
    "  (the agent calendar event from the legacy tool normally syncs in; re-run with --backfill-busy to insert slate blocks for these)",
  );
}

if (!commit) {
  console.log("\nDRY RUN — nothing written. Re-run with --commit to import.");
  process.exit(0);
}

// --- upsert in batches on legacy_request_id ---
let imported = 0;
const conflicts: string[] = [];
for (let i = 0; i < toImport.length; i += 100) {
  const batch = toImport.slice(i, i + 100);
  const res = await fetch(
    `${BASE}/ooo_requests?on_conflict=legacy_request_id`,
    {
      method: "POST",
      headers: { ...H, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(batch),
    },
  );
  if (res.ok) {
    imported += batch.length;
    continue;
  }
  // A batch can trip the active-window unique index against a live request;
  // retry row-by-row so one collision doesn't sink the rest.
  for (const row of batch) {
    const single = await fetch(
      `${BASE}/ooo_requests?on_conflict=legacy_request_id`,
      {
        method: "POST",
        headers: { ...H, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify([row]),
      },
    );
    if (single.ok) imported++;
    else {
      conflicts.push(
        `${row.legacy_request_id}: ${single.status} ${(await single.text()).slice(0, 160)}`,
      );
    }
  }
}
console.log(`\nimported/updated: ${imported}`);
if (conflicts.length) {
  console.log(`conflicts (left untouched): ${conflicts.length}`);
  conflicts.forEach((c) => console.log(`  ${c}`));
}

// --- optional slate-block backfill for uncovered future approved rows ---
if (backfillBusy && uncovered.length) {
  let filled = 0;
  for (const r of uncovered) {
    const res = await fetch(`${BASE}/busy_blocks`, {
      method: "POST",
      headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify([
        {
          user_id: r.user_id,
          starts_at: r.starts_at,
          ends_at: r.ends_at,
          source: "slate",
        },
      ]),
    });
    if (!res.ok) {
      console.log(`  backfill failed for ${r.legacy_request_id}: ${res.status}`);
      continue;
    }
    const [block] = (await res.json()) as { id: string }[];
    await fetch(
      `${BASE}/ooo_requests?legacy_request_id=eq.${encodeURIComponent(r.legacy_request_id)}`,
      {
        method: "PATCH",
        headers: H,
        body: JSON.stringify({ busy_block_id: block.id }),
      },
    );
    filled++;
  }
  console.log(`backfilled busy blocks: ${filled}/${uncovered.length}`);
}
console.log("\nDone.");
