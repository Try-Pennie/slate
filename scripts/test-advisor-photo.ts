/**
 * Resolving the advisor's photo for the manage page (#2600).
 *
 * Every path here ends on the initials circle, and that is the point: this runs
 * inside a lead-facing server render, so anything that escapes is a page that
 * does not draw. None of these states is one a lead should be able to tell from
 * another, so none of them is reported differently.
 *
 * Run: node --experimental-strip-types scripts/test-advisor-photo.ts
 */
import { resolveAdvisorPhoto, type AdvisorPhotoReader } from "../src/lib/booking/advisor-photo.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const PHOTO = "https://lh3.googleusercontent.com/a/ACg8ocK_example=s96-c";

function reader(result: {
  data?: { avatar_url: string | null } | null;
  error?: unknown;
  throws?: boolean;
}): AdvisorPhotoReader {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (result.throws) throw new Error("connection lost");
            return { data: result.data ?? null, error: result.error ?? null };
          },
        }),
      }),
    }),
  } as AdvisorPhotoReader;
}

eq(
  await resolveAdvisorPhoto(reader({ data: { avatar_url: PHOTO } }), "u1"),
  PHOTO,
  "the advisor's photo comes back",
);
eq(await resolveAdvisorPhoto(reader({}), null), null, "no assignee means no photo");
eq(
  await resolveAdvisorPhoto(reader({ data: null }), "u2"),
  null,
  "no row means no photo",
);
eq(
  await resolveAdvisorPhoto(reader({ data: { avatar_url: null } }), "u3"),
  null,
  "an agent who has never had one drops to the initials",
);
eq(
  await resolveAdvisorPhoto(reader({ data: { avatar_url: "   " } }), "u4"),
  null,
  "a blank string is no photo, or the page renders an img with an empty src",
);
eq(
  await resolveAdvisorPhoto(reader({ error: { message: "nope" } }), "u5"),
  null,
  "a failed read drops to the initials rather than throwing",
);
eq(
  await resolveAdvisorPhoto(reader({ throws: true }), "u6"),
  null,
  "a thrown read is caught, because this runs inside a page render",
);

assert(true, "nothing thrown out of any path above");
finish();
