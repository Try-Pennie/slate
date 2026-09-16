// A phone corrected on the manage page is stored in the shape the PERSON LOOKUP
// consumes, and it is the same shape the create path writes (#2390).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-manage-phone-shape.ts
//
// Why this is worth its own suite. `findActiveBookingsForPerson` asks the database
// `attendee_phone = toE164(<the number the caller gave>)`, an exact equality on the
// column. A row written in any other spelling is a row that query can never fetch,
// and the candidate rows it fetches are the entire input to the one call per person
// gate: a booking nobody can find by phone is a booking the gate cannot see, so the
// same lead is booked a second time. The manage page wrote `formatPhoneAsTyped`,
// which returns "(215) 555-9999" and never E.164, so the rule failed precisely for
// the leads who had told us their number was wrong.
//
// The assertion that matters is NOT "the stored value looks like E.164". It is that
// the two writers are the same function of the same input, and both real writers are
// DRIVEN here to measure it: a test that restated the normalization would only prove
// this file agrees with itself (L70).
import { createBooking, updateBookingPhone } from "../src/lib/booking/orchestration.ts";
import { decidePersonBooking, findPersonMatch } from "../src/lib/booking/person-dedupe.ts";
import {
  bucket,
  createAsserter,
  eventType,
  input,
  makeBooking,
  makeDeps,
} from "./lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

const TOKEN = "tok-manage";
/** The number already on the booking, so every correction below really moves it. */
const OLD_PHONE = "+12035615295";

/** A manage-page world whose booking carries `phone` and answers on TOKEN. */
function manageWorld(phone: string = OLD_PHONE) {
  const booking = makeBooking({
    id: "bk-1",
    manage_token: TOKEN,
    attendee_phone: phone,
    gcal_event_id: "gcal-1",
  });
  return makeDeps({ existing: { booking, bucket, eventType } });
}

/** What the CREATE path really stores for `phone`, read off the row it inserts. */
async function storedByCreate(phone: string): Promise<string> {
  const { deps, calls } = makeDeps({ candidates: ["a"], freeEmails: new Set(["a@x.com"]) });
  await createBooking({ ...input, attendee: { ...input.attendee, phone } }, deps);
  return String(calls.insertBooking[0]?.attendee_phone ?? "");
}

/** What the MANAGE page really stores for `phone`, read off the patch it writes. */
async function storedByManage(phone: string): Promise<string> {
  const { deps, calls } = manageWorld();
  const res = await updateBookingPhone(TOKEN, phone, deps);
  if (!res.ok) throw new Error(`the correction was refused: ${res.error ?? ""}`);
  return calls.updateBookingPhone[0]?.phone ?? "";
}

/**
 * Every punctuation a person really types for one number. The field formats as they
 * type, but the route takes whatever it is sent, so a caller that does not format is
 * the case the column has to survive.
 */
const TYPED_SHAPES = [
  "2155559999",
  "(215) 555-9999",
  "215 555 9999",
  "215-555-9999",
  "+1 215 555 9999",
  "12155559999",
  "+12155559999",
];

async function run() {
  // --- the two writers are one function ------------------------------------------
  const storedFromManage = new Set<string>();
  for (const typed of TYPED_SHAPES) {
    const fromCreate = await storedByCreate(typed);
    const fromManage = await storedByManage(typed);
    storedFromManage.add(fromManage);
    assert(
      fromManage === fromCreate,
      `"${typed}" is stored the same by the correction and by the create path (manage ${JSON.stringify(fromManage)}, create ${JSON.stringify(fromCreate)})`,
    );
    assert(
      fromManage.trim().length > 0,
      `"${typed}" never lands as an empty column, which would match nothing and read as a number we hold`,
    );
  }
  assert(
    storedFromManage.size === 1,
    `every spelling of one number collapses to ONE stored string, which is what an exact equality query needs (got ${JSON.stringify([...storedFromManage])})`,
  );

  // --- the lookup's own grader finds the corrected booking ------------------------
  //
  // `findPersonMatch` is the real grader the booking API runs over whatever the
  // candidate query fetched. Driving it here proves the stored value is one the
  // rule can act on; the vitest sibling (manage-phone-lookup.test.ts) drives the
  // query itself, which is the half that decides whether the row is fetched at all.
  {
    const stored = await storedByManage("(215) 555-9999");
    const candidate = makeBooking({ id: "bk-existing", attendee_phone: stored });
    for (const typed of TYPED_SHAPES) {
      const match = findPersonMatch(
        { externalId: null, salesforceId: null, email: null, phone: typed },
        [candidate],
      );
      assert(
        match?.booking.id === "bk-existing",
        `a lead whose number reads "${typed}" is matched to the booking they corrected`,
      );
      const decision = decidePersonBooking({
        startIso: "2026-06-09T13:00:00.000Z",
        match,
        confirmReschedule: false,
      });
      assert(
        decision.action !== "create",
        `and a second booking at another time is not silently created for them (got ${decision.action})`,
      );
    }
  }

  // --- re-saving the number we already hold writes NOTHING ------------------------
  //
  // A lead who opens the field, changes nothing and presses save must not cost a row
  // write and an invite rewrite. Before #2390 this was not a no-op at all: the row
  // held E.164 and the correction rewrote it into the formatted shape, so the ONLY
  // way to reach the defect was to press save without editing anything.
  {
    const { deps, calls } = manageWorld("+12155559999");
    const res = await updateBookingPhone(TOKEN, "(215) 555-9999", deps);
    assert(res.ok, `re-saving the stored number is accepted (got ${res.error ?? ""})`);
    assert(
      calls.updateBookingPhone.length === 0,
      `and writes nothing, because nothing moved (wrote ${JSON.stringify(calls.updateBookingPhone)})`,
    );
    assert(
      calls.updateEventDescription.length === 0,
      "and rewrites no invite, so neither person is emailed about a change nobody made",
    );
  }

  // --- a number the normalizer cannot read ---------------------------------------
  //
  // `toE164` is libphonenumber, and it REFUSES some numbers the product accepts:
  // 555 exchanges and 000 exchanges are ten US digits, so `validateAttendee` lets
  // them through, and libphonenumber hands the input back verbatim rather than
  // producing E.164. What must hold is that this is not a silent empty or a second
  // spelling: the value is kept, and the create path keeps exactly the same one, so
  // the column holds one string for one number either way.
  for (const typed of ["5555555555", "(555) 555-5555", "2150000000", "(215) 000-0000"]) {
    const fromCreate = await storedByCreate(typed);
    const fromManage = await storedByManage(typed);
    assert(
      fromManage === fromCreate,
      `"${typed}" is stored the same by both writers even though it cannot be normalised (manage ${JSON.stringify(fromManage)}, create ${JSON.stringify(fromCreate)})`,
    );
    assert(
      fromManage.trim().length > 0,
      `"${typed}" is never reduced to an empty value, which every other record would then be compared against`,
    );
    const match = findPersonMatch(
      { externalId: null, salesforceId: null, email: null, phone: typed },
      [makeBooking({ id: "bk-existing", attendee_phone: fromManage })],
    );
    assert(
      match?.booking.id === "bk-existing",
      `and "${typed}" still grades as the same person against what was stored for it`,
    );
  }

  // --- a number that cannot be accepted at all reaches the column not at all -------
  //
  // An empty field would normalise to nothing, and a blank `attendee_phone` is worse
  // than a wrong one: it is a value the grader compares every other record against.
  // The refusal happens before the write, so nothing blank can ever be stored.
  for (const bad of ["", "   ", "215555", "+442071838750"]) {
    const { deps, calls } = manageWorld();
    const res = await updateBookingPhone(TOKEN, bad, deps);
    assert(!res.ok, `"${bad}" is refused rather than normalised into the column`);
    assert(
      calls.updateBookingPhone.length === 0 && calls.updateBookingContact.length === 0,
      `and "${bad}" writes nothing at all`,
    );
  }
}

run().then(finish);
