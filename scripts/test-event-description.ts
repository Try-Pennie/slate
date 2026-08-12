/**
 * #1335: the description a lead reads before booking, editable without a deploy.
 *
 * Dan rewrote it on 2026-08-07 and it should be the last time that needs an
 * engineer. It matters beyond the wording: the second half is a real instruction
 * that changes how the call goes ("not while driving", "with access to a screen"),
 * and being able to tune it against how calls actually land is worth more than any
 * single draft.
 *
 * Two paragraphs, deliberately. It is a description followed by an ask, and they
 * must not run together on the one panel a lead reads before committing.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-event-description.ts
 */
import {
  EVENT_DESCRIPTION_MAX,
  parseEventDescriptionForm,
} from "../src/lib/booking/settings.ts";
import { descriptionParagraphs } from "../src/lib/booking/booker-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DANS_COPY =
  "Twenty minutes with a senior advisor to confirm your income, then review the terms " +
  "and rates you may qualify for.\n\nA small ask: join from somewhere quiet, not while " +
  "driving, with access to a screen (phone, tablet, laptop, etc.). Some of what we will " +
  "cover is easier to follow along visually.";

// ------------------------------------------------------------- the parser

{
  const ok = parseEventDescriptionForm(DANS_COPY);
  eq(ok.errors, [], "the copy this issue was filed to ship is accepted");
  eq(ok.description, DANS_COPY, "and stored as written");

  // Blank CLEARS it rather than storing an empty string, so the booker renders no
  // panel at all instead of an empty one.
  const blank = parseEventDescriptionForm("   \n  ");
  eq(blank.description, null, "a blank field clears the description");
  eq(blank.errors, [], "which is not an error: an org may want no description");

  // A pasted value carries whatever the source had. Normalised on the way in, so the
  // stored value is the one thing every surface reads and none of them has to guess
  // what four blank lines meant.
  const messy = parseEventDescriptionForm("  One.  \r\n\r\n\r\n\r\n  Two.  \r\n");
  eq(messy.description, "One.\n\nTwo.", "windows line endings, padding and run-on blank lines are normalised");
  eq(messy.errors, [], "and normalising is not a refusal");

  // A single newline is a line break the author meant, not a paragraph. Kept, so
  // somebody writing a short list is not silently reflowed.
  eq(
    parseEventDescriptionForm("One.\nTwo.").description,
    "One.\nTwo.",
    "a single line break is the author's and survives",
  );
}

// The cap is a real limit, refused rather than truncated: silently storing half a
// sentence would put a cut-off instruction in front of every lead.
{
  const long = parseEventDescriptionForm("x".repeat(EVENT_DESCRIPTION_MAX + 1));
  eq(long.description, null, "an over-long description is not stored");
  assert(long.errors.length === 1, "and is refused with one message");
  assert(
    long.errors[0]!.includes(String(EVENT_DESCRIPTION_MAX)),
    `which says what the limit IS, so the author can act on it (got: ${long.errors[0]})`,
  );
  eq(
    parseEventDescriptionForm("x".repeat(EVENT_DESCRIPTION_MAX)).errors,
    [],
    "and a description exactly at the limit is accepted, not off by one",
  );
}

// -------------------------------------------------------- the paragraphs

{
  const paras = descriptionParagraphs(DANS_COPY);
  eq(paras.length, 2, "the description and the ask are two paragraphs");
  assert(paras[0]!.startsWith("Twenty minutes"), "the description first");
  assert(paras[1]!.startsWith("A small ask"), "then the ask");
  assert(
    !paras[0]!.includes("A small ask"),
    "and they do not run together, which is the whole reason this is a list",
  );

  eq(descriptionParagraphs("One only."), ["One only."], "one paragraph is one entry");
  eq(descriptionParagraphs(""), [], "an empty description is no paragraphs, not one empty one");
  eq(descriptionParagraphs(null), [], "and neither is a missing one");
  eq(
    descriptionParagraphs("A.\n\n\n\nB."),
    ["A.", "B."],
    "a value stored before the normalising parser existed still splits cleanly",
  );
  eq(
    descriptionParagraphs("\n\nA.\n\n"),
    ["A."],
    "and leading or trailing blank lines never become an empty paragraph, which would " +
      "render as a gap nobody wrote",
  );
}

finish();
