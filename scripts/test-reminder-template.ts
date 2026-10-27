// The reminder email template engine (#4297): one fill-in vocabulary, a validator and a
// renderer, and the PARITY proof that the seeded day and hour templates render exactly
// as today's builders do before any builder is retired.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reminder-template.ts
import {
  DEFAULT_TEMPLATES,
  FILL_INS,
  WHEN_SAYS_THE_DAY_FROM_MINUTES,
  describeTemplateProblem,
  renderReminder,
  validateTemplate,
  type ReminderTemplate,
} from "../src/lib/booking/reminder-template.ts";
import {
  reminderSubject,
  reminderBody,
  hourReminderSubject,
  hourReminderBody,
  type ReminderCopyInput,
} from "../src/lib/booking/reminder.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Em/en dash detector built from escapes, so this file holds no literal dash. */
const DASHES = new RegExp("[\\u2013\\u2014]");

const MIN = 60_000;
const HOUR = 60 * MIN;

// --- the one vocabulary ----------------------------------------------------------
{
  const tokens = FILL_INS.map((f) => f.token);
  eq(
    tokens,
    ["{call with}", "{when}", "{call time}", "{manage link}", "{signature}", "{how we call}"],
    "the fill-ins are exactly the five phrases and the how we call block",
  );
  eq(new Set(tokens).size, tokens.length, "no fill-in is listed twice");
  for (const f of FILL_INS) {
    assert(f.token === `{${f.name}}`, `${f.token} is its name in braces`);
    assert(f.description.length > 0 && !DASHES.test(f.description), `${f.token} has a description with no dash`);
  }
  eq(
    FILL_INS.filter((f) => f.block).map((f) => f.token),
    ["{how we call}"],
    "how we call is the only block",
  );
  eq(
    FILL_INS.filter((f) => f.subject).map((f) => f.token),
    ["{call with}", "{when}", "{call time}"],
    "only the one line phrases may go in a subject",
  );
  eq(WHEN_SAYS_THE_DAY_FROM_MINUTES, 120, "{when} names the day for an email two hours or more before the call");
}

// --- validation ------------------------------------------------------------------
{
  eq(validateTemplate(DEFAULT_TEMPLATES.day.subject, DEFAULT_TEMPLATES.day.body), [], "the day default is valid");
  eq(validateTemplate(DEFAULT_TEMPLATES.hour.subject, DEFAULT_TEMPLATES.hour.body), [], "the hour default is valid");

  eq(validateTemplate("", "Hi"), [{ kind: "empty", field: "subject" }], "an empty subject is refused");
  eq(validateTemplate("Hi", "  \n\n "), [{ kind: "empty", field: "body" }], "a blank body is refused");

  const unknown = validateTemplate("Your call {whne}", "Hi {name}, see {manage link} and {Signature}");
  eq(
    unknown,
    [
      { kind: "unknown", field: "subject", token: "{whne}" },
      { kind: "unknown", field: "body", token: "{name}" },
      { kind: "unknown", field: "body", token: "{Signature}" },
    ],
    "every unknown fill-in is named, in the field it is in",
  );

  eq(
    validateTemplate("Your call {when", "Hi } there {call with"),
    [
      { kind: "malformed", field: "subject", fragment: "{when" },
      { kind: "malformed", field: "body", fragment: "}" },
      { kind: "malformed", field: "body", fragment: "{call with" },
    ],
    "an unclosed brace and a stray closing brace are refused, quoting the fragment",
  );
  eq(
    validateTemplate("Ok", "Hi {call {when}} there"),
    [
      { kind: "malformed", field: "body", fragment: "{call " },
      { kind: "malformed", field: "body", fragment: "}" },
    ],
    "a brace opened inside another is malformed, and so is the brace left over",
  );

  eq(
    validateTemplate("Call {signature} {manage link} {how we call}", "Hi"),
    [
      { kind: "body_only", field: "subject", token: "{signature}" },
      { kind: "body_only", field: "subject", token: "{manage link}" },
      { kind: "body_only", field: "subject", token: "{how we call}" },
    ],
    "a fill-in that is several lines or a link is refused in the subject",
  );
  eq(validateTemplate("Line one\nline two", "Hi"), [{ kind: "multiline_subject", field: "subject" }], "a subject is one line");

  for (const problem of [
    ...validateTemplate("", ""),
    ...unknown,
    ...validateTemplate("{x", "}"),
    ...validateTemplate("{signature}\n", "Hi"),
  ]) {
    const text = describeTemplateProblem(problem);
    assert(text.length > 0 && !DASHES.test(text), `the message for ${problem.kind} reads without a dash: ${text}`);
  }
  assert(
    describeTemplateProblem({ kind: "unknown", field: "body", token: "{name}" }).includes("{name}"),
    "the message for an unknown fill-in names it",
  );
}

// --- rendering -------------------------------------------------------------------
const START = "2026-10-28T18:30:00.000Z"; // 2:30pm in New York, a Wednesday
const START_MS = Date.parse(START);
const base: ReminderCopyInput = {
  agentName: "Sam Rivera",
  startsAtIso: START,
  timezone: "America/New_York",
  manageUrl: "https://slate.example/manage/abc123",
  nowMs: START_MS - 24 * HOUR,
  callingNumber: "+17867054716",
  leadPhone: "+12155550100",
  onPlaceholder: false,
};

{
  const tpl: ReminderTemplate = {
    minutesBefore: 1440,
    subject: "About {call with}",
    body: "{call with}|{when}|{call time}|{manage link}|{signature}|{how we call}",
    cardBlock: true,
  };
  const out = renderReminder(tpl, base);
  assert(out.ok, "a valid template renders");
  if (out.ok) {
    eq(out.subject, "About your call with Sam Rivera at Pennie", "{call with} names a real advisor");
    eq(
      out.body,
      [
        "your call with Sam Rivera at Pennie",
        "tomorrow at 2:30pm EDT",
        "2:30pm EDT",
        "https://slate.example/manage/abc123",
        "Sam Rivera\nPennie",
        "We will call you at (215) 555-0100. The call will come from (786) 705-4716. Save it to your contacts so your phone lets it through. My contact card is attached, so one tap adds it.",
      ].join("|"),
      "each fill-in renders its phrase",
    );
    assert(out.cardAttached, "the card is attached when the block says so");
  }

  const nameless = renderReminder(tpl, { ...base, agentName: "sam@trypennie.com" });
  assert(nameless.ok && nameless.subject === "About your call with Pennie", "an address is never shown as a name");
  assert(nameless.ok && nameless.body.includes("|Your Pennie advisor|"), "the signature speaks for Pennie with no name");
  assert(nameless.ok && nameless.body.includes("Our contact card is attached"), "the card is our card with no name");

  const noCard = renderReminder({ ...tpl, cardBlock: false }, base);
  assert(noCard.ok && !noCard.cardAttached, "the card switch off attaches no card");
  assert(
    noCard.ok && noCard.body.endsWith("We will call you at (215) 555-0100, so there is nothing you need to set up."),
    "the card switch off keeps the plain number line",
  );

  const noBlock = renderReminder({ ...tpl, body: "Hi {call with}" }, base);
  assert(noBlock.ok && !noBlock.cardAttached, "a body without the block attaches no card it never mentions");

  // A number Salesforce holds but nobody can read as a phone: no sentence names it,
  // so no card goes with it either (the card goes only with the copy that mentions it).
  const unreadableNumber = renderReminder(tpl, { ...base, callingNumber: "not a phone" });
  assert(unreadableNumber.ok && !unreadableNumber.cardAttached, "an unreadable calling number attaches no card");

  const hourTpl = { ...tpl, minutesBefore: 60 };
  const hour = renderReminder(hourTpl, { ...base, nowMs: START_MS - 47 * MIN });
  assert(hour.ok && hour.body.includes("|in about 45 minutes, at 2:30pm EDT|"), "a short lead's {when} is the time until the call");
  const edge = renderReminder({ ...tpl, minutesBefore: 119 }, base);
  assert(edge.ok && edge.body.includes("|in about"), "under two hours says the time until the call");
  const edge2 = renderReminder({ ...tpl, minutesBefore: 120 }, { ...base, nowMs: START_MS - 2 * HOUR });
  assert(edge2.ok && edge2.body.includes("|today at 2:30pm EDT|"), "two hours says the day");

  // Refused at send time: never literal braces in a lead's inbox.
  const broken = renderReminder({ ...tpl, body: "Hi {first name}, {when}" }, base);
  assert(!broken.ok, "a stored template with an unknown fill-in is refused at render time");
  if (!broken.ok) eq(broken.problems, [{ kind: "unknown", field: "body", token: "{first name}" }], "the refusal names it");
  const brokenSubject = renderReminder({ ...tpl, subject: "Call {when" }, base);
  assert(!brokenSubject.ok, "a malformed subject is refused at render time");
  const empty = renderReminder({ ...tpl, subject: " " }, base);
  assert(!empty.ok, "an empty subject is refused at render time");
  const noTiming = renderReminder({ ...tpl, minutesBefore: Number.NaN }, base);
  assert(!noTiming.ok, "an email with no readable timing is refused, since {when} depends on it");
  if (!noTiming.ok) eq(noTiming.problems, [{ kind: "timing" }], "named as timing");
  const brokenPlaceholder = renderReminder({ ...tpl, body: "Hi {first name}" }, { ...base, onPlaceholder: true });
  assert(!brokenPlaceholder.ok, "a broken template is refused for a placeholder call too, whose subject it supplies");

  // The placeholder call: the fixed body with the email's own {when}, no card ever.
  const placeholder = renderReminder(tpl, { ...base, onPlaceholder: true });
  assert(placeholder.ok && !placeholder.cardAttached, "a placeholder call never carries a card");
  assert(placeholder.ok && placeholder.subject === "About your call with Pennie", "a placeholder call is with Pennie");
  assert(
    placeholder.ok && placeholder.body.startsWith("Hi, this is a reminder that your call with Pennie is tomorrow at 2:30pm EDT."),
    "the placeholder body is the fixed one with this email's {when}",
  );
  const placeholderHour = renderReminder(hourTpl, { ...base, onPlaceholder: true, nowMs: START_MS - 60 * MIN });
  assert(
    placeholderHour.ok && placeholderHour.body.startsWith("Hi, this is a reminder that your call with Pennie is in about an hour, at 2:30pm EDT."),
    "and for a short lead, the time until the call",
  );
}

// --- PARITY: the seeded templates render as today's builders, byte for byte --------
//
// Across every combination of the five preview cases (calling number known or not,
// lead phone known or not, no advisor name, placeholder) and several clocks, zones
// and starts, the unreadable ones included.
{
  const names = ["Sam Rivera", null, "sam@trypennie.com", "   "];
  const callingNumbers = ["+17867054716", null];
  const leadPhones = ["+12155550100", null, "not a phone"];
  const zones = ["America/New_York", "America/Los_Angeles"];
  const starts = [START, "2026-11-01T13:05:00.000Z", "2026-11-02T04:30:00.000Z", "garbage"];
  const dayOffsets = [24 * HOUR, 23 * HOUR, 40 * HOUR, 3 * HOUR, 45 * MIN, -5 * MIN, 14 * HOUR + 31 * MIN];
  const hourOffsets = [60 * MIN, 55 * MIN, 47 * MIN, 33 * MIN, 12 * MIN, -5 * MIN, 52 * MIN + 29_999];
  let compared = 0;
  let cards = 0;
  const mismatches: string[] = [];
  for (const agentName of names) {
    for (const callingNumber of callingNumbers) {
      for (const leadPhone of leadPhones) {
        for (const onPlaceholder of [false, true]) {
          for (const timezone of zones) {
            for (const startsAtIso of starts) {
              const startMs = Date.parse(startsAtIso);
              const anchor = Number.isFinite(startMs) ? startMs : START_MS;
              for (const [slug, offsets] of [["day", dayOffsets], ["hour", hourOffsets]] as const) {
                for (const nowMs of [...offsets.map((o) => anchor - o), Number.NaN]) {
                  // The lane never passes a calling number for a placeholder call.
                  const input: ReminderCopyInput = {
                    agentName,
                    startsAtIso,
                    timezone,
                    manageUrl: "https://slate.example/manage/xyz789",
                    nowMs,
                    callingNumber: onPlaceholder ? null : callingNumber,
                    leadPhone,
                    onPlaceholder,
                  };
                  const out = renderReminder(DEFAULT_TEMPLATES[slug], input);
                  const subject = slug === "day" ? reminderSubject(input) : hourReminderSubject(input);
                  const body = slug === "day" ? reminderBody(input) : hourReminderBody(input);
                  // Today's lane attaches the card whenever it holds a calling number.
                  const card = input.callingNumber !== null;
                  compared += 1;
                  if (out.ok && out.cardAttached) cards += 1;
                  if (!out.ok || out.subject !== subject || out.body !== body || out.cardAttached !== card) {
                    mismatches.push(`${slug} ${JSON.stringify(input)}: ${JSON.stringify(out)}`);
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  assert(compared > 3000, `the parity grid is large (${compared} renders compared)`);
  assert(cards > 0, `the grid exercises the card branch (${cards} renders with a card)`);
  eq(mismatches.length, 0, "the seeded day and hour templates render exactly as today's builders");
  for (const m of mismatches.slice(0, 5)) console.error("  mismatch:", m);
}

// --- the defaults' settings ---------------------------------------------------------
{
  eq(DEFAULT_TEMPLATES.day.minutesBefore, 1440, "the day email goes 24 hours before");
  eq(DEFAULT_TEMPLATES.day.lateBooking, "send_now", "a call booked inside the day is reminded at once");
  eq(DEFAULT_TEMPLATES.hour.minutesBefore, 60, "the hour email goes an hour before");
  eq(DEFAULT_TEMPLATES.hour.lateBooking, "skip", "a call booked inside the hour gets no hour email");
  for (const slug of ["day", "hour"] as const) {
    const t = DEFAULT_TEMPLATES[slug];
    eq(t.slug, slug, `${slug} carries its own slug`);
    assert(t.cardBlock && t.placeholderSends, `${slug} carries the card and goes to placeholder calls, as today`);
    assert(!DASHES.test(t.subject + t.body + t.name), `${slug} holds no dash`);
  }
}

finish();
