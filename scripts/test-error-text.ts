// `errorText` is the one place a caught `unknown` becomes alert text, and
// `shortErrorReason` (used by every catch block that pages) goes through it. So it
// must never SERIALIZE an object it does not recognise: a thrown row or payload
// carries a lead's contact data, and a JSON dump would put it in Slack from call
// sites that do no scrubbing of their own. It names the object's type or code
// instead, and scrubs whatever it does produce, so every caller is covered.
//
// Every value here is a fixture.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-error-text.ts
import { errorText, shortErrorReason, shortFailureReason } from "@/lib/notify/error-text";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";
import { assert, eq, finish } from "./lib/harness.ts";

const EMAIL = "jane.doe@example.com";
const PHONE = "(203) 561-5295";

// An object with no message is never serialized, whatever it carries.
{
  const row = { attendee_email: EMAIL, attendee_phone: PHONE, booking_id: "b1" };
  const text = errorText(row);
  assert(!text.includes(EMAIL), `a row's email never reaches the text (got: ${text})`);
  assert(!text.includes("561-5295"), `a row's phone never reaches the text (got: ${text})`);
  assert(!text.includes("b1") && !text.includes("{"), `nothing of the row is serialized (got: ${text})`);
  assert(!text.includes("[object Object]"), "and it is not [object Object] either");
  assert(text.length > 0, "it still says something");
  const short = shortErrorReason(row);
  assert(!short.includes(EMAIL) && !short.includes("561-5295"), "shortErrorReason carries none of it");
}

// A code or a numeric status is named, since that is the diagnosis and not data.
{
  const text = errorText({ code: "PGRST116", attendee_email: EMAIL });
  assert(text.includes("PGRST116"), "a code is named");
  assert(!text.includes(EMAIL), "and nothing else of the object");
  assert(errorText({ status: 418 }).includes("418"), "a numeric status is named");
}

// The type is named for a class instance with no message.
{
  class Weird {
    email = EMAIL;
  }
  const text = errorText(new Weird());
  assert(text.includes("Weird"), `the type is named (got: ${text})`);
  assert(!text.includes(EMAIL), "and not its fields");
}

// A message is kept, and scrubbed here, so a caller that does no scrubbing of its
// own still cannot page with an address in it.
{
  const pg = { message: `duplicate key for ${EMAIL} phone ${PHONE}`, code: "23505" };
  const text = errorText(pg);
  assert(text.includes("duplicate key"), "the message survives");
  assert(text.includes("23505"), "with its code");
  assert(!text.includes(EMAIL) && !text.includes("561-5295"), `contact data is scrubbed (got: ${text})`);
  assert(!errorText(new Error(`insert failed for ${EMAIL}`)).includes(EMAIL), "an Error's message is scrubbed too");
  assert(!errorText(`refused ${EMAIL}`).includes(EMAIL), "a string is scrubbed too");
}

// #3263: a deadline reads as what happened, in words. "supabase did not answer
// within 0ms" sounds like supabase was slow; the truth is Slate never asked it,
// because the request's budget was already used up.
{
  const confirm = { label: "the booking confirm", totalMs: 12_000 };
  const spent = "the booking confirm had used up its 12 seconds before Slate asked supabase";
  eq(
    shortFailureReason(
      "DeadlineExceededError: supabase did not answer within 0ms, when the booking confirm ran out of its 12000ms",
    ),
    spent,
    "a stored PostgREST error for a refused call says the budget was used up before Slate asked",
  );
  eq(
    shortFailureReason("supabase did not answer within 0ms, when the booking confirm ran out of its 12000ms"),
    spent,
    "the bare sentence, as an Error's own message stores it, reads the same",
  );
  eq(shortErrorReason(new DeadlineExceededError("supabase", 0, confirm)), spent, "and so does the caught error");
  eq(
    shortErrorReason(new Error("insert failed", { cause: new DeadlineExceededError("supabase", 0, confirm) })),
    spent,
    "found through a cause too",
  );
  eq(
    shortErrorReason(new DeadlineExceededError("supabase", 3000, confirm)),
    "supabase was still running when the booking confirm ran out of its 12 seconds",
    "a call the budget cut short says it was still running",
  );
  eq(
    shortErrorReason(new DeadlineExceededError("google events.insert", 8000)),
    "google events.insert did not answer within 8 seconds",
    "a call that ran out of its own limit says it did not answer",
  );
  eq(
    shortErrorReason(new DeadlineExceededError("slack", 1000)),
    "slack did not answer within 1 second",
    "one second is singular",
  );
  eq(
    shortErrorReason(new DeadlineExceededError("slack", 250)),
    "slack did not answer within 250ms",
    "under a second keeps its milliseconds rather than rounding to zero seconds",
  );
  eq(
    shortFailureReason("refused: supabase did not answer within 0ms in a sentence somebody wrote"),
    "refused: supabase did not answer within 0ms in a sentence somebody wrote",
    "control: text that merely contains the words is left as it is",
  );
}

eq(errorText(undefined), "", "nothing gives empty, so the caller's fallback applies");
eq(errorText(null), "", "null gives empty too");
eq(shortErrorReason(undefined), "no detail", "and the fallback is what reaches the page");

finish();
