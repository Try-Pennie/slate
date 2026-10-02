/**
 * The one photo resolver (#3027), and the manage page's use of it (#2600).
 *
 * The resolver decides which picture every surface draws. The manage page path
 * must never throw, because it runs inside a lead-facing render, and must keep
 * the four resolver states apart rather than collapsing a failed read into
 * "no photo".
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-advisor-photo.ts
 */
import { resolveBookingAdvisorPhoto, type AdvisorPhotoReads } from "../src/lib/booking/advisor-photo.ts";
import {
  advisorPhotoPath,
  needsPhoto,
  photoSrc,
  resolveAdvisorPhoto,
  type PhotoRecord,
} from "../src/lib/advisor-photos/resolve.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SIGN_IN = "https://lh3.googleusercontent.com/a/ACg8ocK_example=s96-c";
const SHA = "b".repeat(64);
const person = (avatar_url: string | null) => ({ id: "u1", avatar_url });
const recs = (r?: PhotoRecord) => new Map<string, PhotoRecord>(r ? [["u1", r]] : []);

// --- the resolver: every branch -------------------------------------------------
{
  const photo = resolveAdvisorPhoto(person(SIGN_IN), recs({ state: "photo", sha256: SHA }));
  eq(photo.kind, "photo", "a stored directory photo is a photo");
  eq(photoSrc(photo), `/advisor-photo/${SHA}`, "served from Slate's own origin, by its hash");
  eq(advisorPhotoPath(SHA), photoSrc(photo), "through the one route builder");

  const none = resolveAdvisorPhoto(person(SIGN_IN), recs({ state: "none", sha256: null }));
  eq(none.kind, "none", "a measured none is none");
  eq(photoSrc(none), null, "and HIDES the sign in photo (the directory wins, Dan 2026-10-02)");
  assert(needsPhoto(none), "and is the only state that needs a photo");

  const never = resolveAdvisorPhoto(person(SIGN_IN), recs());
  eq(never.kind, "never-read", "no row is never read");
  eq(photoSrc(never), SIGN_IN, "which keeps the sign in photo meanwhile");
  assert(!needsPhoto(never), "and is not evidence anybody needs a photo");

  const blank = resolveAdvisorPhoto(person("   "), recs());
  eq(photoSrc(blank), null, "a blank sign in photo is no photo, never an empty src");

  const unreadable = resolveAdvisorPhoto(person(SIGN_IN), null);
  eq(unreadable.kind, "unreadable", "a failed table read is its own state");
  eq(photoSrc(unreadable), SIGN_IN, "keeping the sign in photo");
  assert(!needsPhoto(unreadable), "and never reads as needing a photo");
}

// --- the manage page path -------------------------------------------------------
function reads(over: Partial<{ user: { id: string; avatar_url: string | null } | null; userThrows: boolean; records: Map<string, PhotoRecord>; recordsThrow: boolean }>): AdvisorPhotoReads {
  return {
    readUser: async () => {
      if (over.userThrows) throw new Error("connection lost");
      return over.user === undefined ? person(SIGN_IN) : over.user;
    },
    readRecords: async () => {
      if (over.recordsThrow) throw new Error("relation advisor_photos does not exist");
      return over.records ?? recs();
    },
  };
}

eq(await resolveBookingAdvisorPhoto(reads({}), null), null, "no assignee means no photo");
eq(await resolveBookingAdvisorPhoto(reads({ user: null }), "u1"), null, "no such user means no photo");
eq(await resolveBookingAdvisorPhoto(reads({ userThrows: true }), "u1"), null, "a failed user read is caught and draws initials");
eq(
  await resolveBookingAdvisorPhoto(reads({ records: recs({ state: "photo", sha256: SHA }) }), "u1"),
  `/advisor-photo/${SHA}`,
  "the stored directory photo is what the lead sees",
);
eq(
  await resolveBookingAdvisorPhoto(reads({ records: recs({ state: "none", sha256: null }) }), "u1"),
  null,
  "a measured none draws initials",
);
eq(await resolveBookingAdvisorPhoto(reads({}), "u1"), SIGN_IN, "never read keeps the sign in photo");
eq(
  await resolveBookingAdvisorPhoto(reads({ recordsThrow: true }), "u1"),
  SIGN_IN,
  "the photo table failing (before the migration is applied, say) keeps the sign in photo rather than throwing",
);

finish();
