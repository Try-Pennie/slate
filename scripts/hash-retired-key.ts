// Retire a booking API key (#2879). Two steps, in this order:
//
//   pnpm -s hash:retired-key <label> | npx wrangler secret put BOOKING_API_RETIRED_KEY_HASHES
//   pnpm -s hash:retired-key --record <label>
//
// then commit docs/retired-booking-key-hashes.txt.
//
// The first prints the WHOLE list (every entry in the committed file plus the new
// one) for the secret, and writes nothing: `wrangler secret put` REPLACES the secret
// and a secret cannot be read back, so printing only the new entry would silently
// drop every key retired before it. If the put fails, run it again; nothing changed.
// The second, run once the put succeeded, adds the entry to the committed file. Both
// are idempotent for the same label and key, and a label reused for a DIFFERENT key
// is refused.
//
// The key is read from RETIRED_BOOKING_API_KEY (put it in .env.local, which this
// loads), never from an argument, so it never reaches the shell history or a
// transcript. Delete the line from .env.local afterwards.
//
// A MISSING list file is refused, never read as empty: that is the one way the
// printed value could quietly lack every earlier entry. A key still configured in a
// live booking key slot here is refused, since it is not retired and its hash would
// never fire.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { combineRetiredKeyEntries, parseRetiredKeyHashes, retiredKeyHashLine } from "../src/lib/booking/retired-keys.ts";
import { BOOKING_API_CALLERS, bookingApiKeyEnvName } from "../src/lib/booking/api-auth.ts";
import { retiredKeyHashesPath } from "./lib/retired-key-file.ts";

const args = process.argv.slice(2);
const record = args[0] === "--record";
const label = (record ? args[1] : args[0]) ?? "";
const key = process.env.RETIRED_BOOKING_API_KEY ?? "";
if (!label) {
  process.stderr.write(
    "usage: pnpm -s hash:retired-key [--record] <label>, with RETIRED_BOOKING_API_KEY set in .env.local\n",
  );
  process.exit(1);
}
try {
  const path = retiredKeyHashesPath();
  if (!existsSync(path)) {
    throw new Error(
      `${path} not found; it holds every retired entry, and without it the printed value would drop them all. Restore it from git before retiring a key`,
    );
  }
  // Every booking key configured here (.env.local), so a key still in a live slot is
  // refused: it authenticates, so the watcher would never see it. The Worker checks
  // the same against its own slots, which this machine may not hold.
  const live = BOOKING_API_CALLERS.flatMap((caller) =>
    (["primary", "secondary"] as const).map((slot) => ({
      id: `${caller}:${slot}`,
      secret: process.env[bookingApiKeyEnvName(caller, slot)] ?? "",
    })),
  ).filter((k) => k.secret.trim() !== "");
  const line = await retiredKeyHashLine(label, key, live);
  const existing = readFileSync(path, "utf8");
  const combined = combineRetiredKeyEntries(existing, line);
  if (record) {
    const header = existing.split(/\r?\n/).filter((l) => l.trim().startsWith("#"));
    const entries = parseRetiredKeyHashes(combined).map((e) => `${e.label}:sha256:${e.sha256}`);
    writeFileSync(path, `${[...header, ...entries].join("\n")}\n`);
    process.stderr.write(`${path} now lists ${entries.length} retired key(s); commit it\n`);
  } else {
    process.stdout.write(`${combined}\n`);
  }
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
