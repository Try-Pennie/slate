/**
 * One-time backfill of `users.avatar_url` from the Google Workspace directory
 * (#2600).
 *
 * `avatar_url` is written from the Google OAuth payload AT LOGIN, and the roster
 * is synced from Salesforce, so an agent who has never signed into Slate has
 * none: measured 2026-09-22, 47 of 98 bookable agents had one. Every surface
 * that shows a face (the admin roster, the header, and the manage page a lead
 * reaches from their confirmation email) therefore showed initials for half the
 * roster.
 *
 * This is deliberately a ONE TIME command and not a scheduled job (Dan,
 * 2026-09-22: "we don't need a job. Agents really should be logging in. what we
 * need is just a one-time backfill right now"). Login stays the way a photo gets
 * updated from here, which also makes it the immediate override: somebody who
 * changes their Google picture signs in and Slate has it.
 *
 * TWO RULES, both of which matter:
 *
 *  - **It only ever FILLS an empty one.** A stored value came from that person's
 *    own login and is the fresher fact, so it is never replaced and never
 *    cleared. Nobody can come out of this run with less than they went in with.
 *  - **Google's placeholder is not a photo.** `thumbnailPhotoUrl` is served for
 *    accounts with NO picture, pointing at one Google generates, so counting the
 *    field counts the roster rather than the photos (L67, L192). `uploadedPhotoUrl`
 *    is the host rule that separates them; the first measurement of this reported
 *    94 of 98 when the real answer is 84.
 *
 * It PACES itself and rides out a rate limit. The first dry run met 429s from
 * the directory, and because a page-facing helper collapses every failure to
 * null, those arrived counted alongside the agents who genuinely have no photo:
 * a number that says "30 have none" when some of them were never asked is the
 * shape of a measurement nobody can act on (L11). The three outcomes are counted
 * separately now, and a run that could not read somebody says so.
 *
 * Dry run by default, because a write against the live roster should be a
 * deliberate second command rather than the thing that happens if you run it to
 * see what it would do:
 *
 *   pnpm backfill:advisor-photos              # says what it would change
 *   pnpm backfill:advisor-photos --apply      # changes it
 */
import { workspacePhotoUrl, directoryDeps } from "@/lib/google/directory";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import {
  runBackfill,
  backfillExitCode,
  DEFAULT_TUNING,
  type BackfillUser,
} from "./lib/backfill-photos.ts";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = supabaseAdmin();
  const deps = directoryDeps();

  const result = await runBackfill(
    {
      listUsers: async () =>
        unwrap(
          await db
            .from("users")
            .select("id,email,avatar_url")
            // Active only. A departed agent's face is on nothing a lead sees and
            // their Google account is routinely unlicensed on the way out, so
            // asking spends a call to be told no.
            .is("deactivated_at", null)
            // cap-safe: `users` is roster bounded (the design target is 100 to
            // 200 agents) and cannot fill a PostgREST page.
            .order("email"),
          "backfill-advisor-photos: active users",
        ) as unknown as BackfillUser[],
      photoFor: (email) => workspacePhotoUrl(email, deps),
      write: async (id, url) => {
        const { error } = await db.from("users").update({ avatar_url: url }).eq("id", id);
        return error ? (error.message ?? String(error)) : null;
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      apply: APPLY,
    },
    DEFAULT_TUNING,
  );

  console.log(`active users: ${result.active}`);
  console.log(`  already have a photo: ${result.alreadyHad}`);
  console.log(`  no photo on file:     ${result.hadNone}`);
  console.log(APPLY ? "\napplying\n" : "\ndry run, nothing will be written\n");
  console.log(`${APPLY ? "filled" : "would fill"}:           ${result.filled}`);
  console.log(`genuinely have no photo: ${result.noPhoto}`);
  console.log(`could not be read:       ${result.couldNotRead.length}`);
  for (const line of result.couldNotRead) console.log(`    ${line}`);
  if (result.writeFailed.length > 0) {
    console.log(`writes that FAILED:      ${result.writeFailed.length}`);
    for (const line of result.writeFailed) console.log(`    ${line}`);
  }
  console.log(
    `\nphotos after this run: ${result.alreadyHad + result.filled} of ${result.active}` +
      (APPLY ? "" : " (if applied)"),
  );

  const code = backfillExitCode(result, APPLY);
  if (code === 2) console.error("\nnothing could be read at all: not a result");
  if (code !== 0) process.exit(code);
}

await main();
