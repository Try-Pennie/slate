// Add a retired booking API key to the retired list (#2879), and print the WHOLE list
// for the BOOKING_API_RETIRED_KEY_HASHES Worker secret. Run:
//   pnpm -s hash:retired-key <label> | npx wrangler secret put BOOKING_API_RETIRED_KEY_HASHES
// then commit docs/retired-booking-key-hashes.txt.
//
// The key is read from RETIRED_BOOKING_API_KEY (put it in .env.local, which this
// loads), never from an argument, so it never reaches the shell history or a
// transcript. Delete the line from .env.local afterwards.
//
// `wrangler secret put` REPLACES the secret, and a secret cannot be read back, so
// printing only the new entry would silently drop every key retired before it. The
// list is therefore kept in the committed file of hashes (not secret, one
// `label:sha256:<hash>` entry per line): this reads it, adds the new entry, writes
// it back, and prints every entry comma separated. A repeated label or an unreadable
// file is refused before anything is written or printed.
//
// A key still configured in a live booking key slot here is refused, since it is
// not retired and its hash would never fire.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { combineRetiredKeyEntries, parseRetiredKeyHashes, retiredKeyHashLine } from "../src/lib/booking/retired-keys.ts";
import { BOOKING_API_CALLERS, bookingApiKeyEnvName } from "../src/lib/booking/api-auth.ts";
import { RETIRED_KEY_HASHES_FILE } from "./lib/retired-key-file.ts";

const label = process.argv[2] ?? "";
const key = process.env.RETIRED_BOOKING_API_KEY ?? "";
if (!label) {
  process.stderr.write("usage: pnpm -s hash:retired-key <label>, with RETIRED_BOOKING_API_KEY set in .env.local\n");
  process.exit(1);
}
try {
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
  const existing = existsSync(RETIRED_KEY_HASHES_FILE) ? readFileSync(RETIRED_KEY_HASHES_FILE, "utf8") : "";
  const combined = combineRetiredKeyEntries(existing, line);
  writeFileSync(RETIRED_KEY_HASHES_FILE, `${parseRetiredKeyHashes(combined).map((e) => `${e.label}:sha256:${e.sha256}`).join("\n")}\n`);
  process.stderr.write(`${RETIRED_KEY_HASHES_FILE} now lists ${parseRetiredKeyHashes(combined).length} retired key(s); commit it\n`);
  process.stdout.write(`${combined}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
