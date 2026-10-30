/**
 * #1337 / #1338: resolving the advisor a booking is currently with.
 *
 * The whole point of this lookup is that it is read LIVE, and the whole point of
 * these assertions is the fail-safe direction: EVERY failure resolves to null so
 * the surface renders no name. Naming nobody is a visible absence a lead can act
 * on; naming the wrong person looks exactly like success and sends someone else
 * (L75). A single wrong branch here would be invisible in review and invisible in
 * production until a lead met a different advisor than the page promised.
 *
 * Run: node --experimental-strip-types scripts/test-advisor-name.ts
 */
import { resolveAdvisorName, type AdvisorNameReader } from "../src/lib/booking/advisor-name.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A fake users table. Records the id it was asked for, so "never queried" is
 *  provable rather than assumed. */
function reader(result: {
  data?: { name: string | null; is_placeholder?: boolean | null } | null;
  error?: unknown;
  throws?: boolean;
}) {
  const asked: string[] = [];
  const db: AdvisorNameReader = {
    from: () => ({
      select: () => ({
        eq: (_col, value) => {
          asked.push(value);
          return {
            maybeSingle: async () => {
              if (result.throws) throw new Error("users read down");
              return { data: result.data ?? null, error: result.error ?? null };
            },
          };
        },
      }),
    }),
  };
  return { db, asked };
}

async function run() {
  {
    const { db, asked } = reader({ data: { name: "Aisha Bello" } });
    eq(await resolveAdvisorName(db, "u1"), "Aisha Bello", "a resolved agent yields their name");
    eq(asked.join(), "u1", "looked up by the assignee's id");
  }

  {
    const { db, asked } = reader({ data: { name: "Aisha Bello" } });
    eq(await resolveAdvisorName(db, null), null, "no assignee yields no name");
    eq(asked.length, 0, "and no query is made at all");
  }

  {
    const { db } = reader({ data: null });
    eq(await resolveAdvisorName(db, "gone"), null, "an id matching no row yields no name");
  }

  {
    const { db } = reader({ data: { name: null } });
    eq(await resolveAdvisorName(db, "u1"), null, "a row with no name yields no name");
  }

  {
    const { db } = reader({ data: { name: "   " } });
    eq(await resolveAdvisorName(db, "u1"), null, "a blank name is not a name");
  }

  {
    const { db } = reader({ data: { name: "  Aisha Bello  " } });
    eq(await resolveAdvisorName(db, "u1"), "Aisha Bello", "surrounding space is trimmed off");
  }

  // The two failure paths. Both must land on null, not throw: a page that 500s
  // because a presentational name could not be read is worse than one that
  // quietly omits it, and a thrown error here would take the manage page down.
  {
    const { db } = reader({ error: { message: "permission denied" } });
    eq(await resolveAdvisorName(db, "u1"), null, "a read error yields no name rather than throwing");
  }

  // #4391: the placeholder advisor holds a call nobody dials as her, so the manage page
  // and the existing call notice never name her ("Your loan advisor, Marcia").
  {
    const { db } = reader({ data: { name: "Marcia", is_placeholder: true } });
    eq(await resolveAdvisorName(db, "p"), null, "the placeholder advisor is never named to a lead");
    const control = reader({ data: { name: "Aisha Bello", is_placeholder: false } });
    eq(await resolveAdvisorName(control.db, "u1"), "Aisha Bello", "control: a real advisor still is");
  }

  {
    const { db } = reader({ throws: true });
    let threw = false;
    let out: string | null = "unset";
    try {
      out = await resolveAdvisorName(db, "u1");
    } catch {
      threw = true;
    }
    assert(!threw, "a thrown read is caught rather than taking the page down");
    eq(out, null, "and resolves to no name");
  }

  finish();
}

void run();
