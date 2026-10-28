import {
  dayWord,
  howWeCallLine,
  placeholderReminderBody,
  soonWord,
  timeLabel,
  type ReminderCopyInput,
} from "./reminder.ts";
import { realAdvisorName } from "./advisor-contact-card.ts";

/**
 * The reminder email template engine (#4297, milestone "Editable reminder emails").
 *
 * An admin writes a reminder email's subject and body as text holding FILL-INS, and
 * this module is the only thing that knows what a fill-in is: the editor's picker, the
 * validator run on save and restore, and the renderer run at send time all derive from
 * `FILL_INS`, so none of them can accept a word another one refuses (L611).
 *
 * The fill-ins are PHRASE level rather than field level. `{call with}` is "your call
 * with Sam Rivera at Pennie", not a bare `{advisor name}`, because the phrase owns its
 * own fallback: with no real advisor name it is "your call with Pennie", and an admin
 * cannot write a sentence that reads wrong in the case they never previewed. For the
 * same reason the number paragraph is one fixed block, `{how we call}`, rather than
 * pieces: its wording changes with whether the calling number is known, and the card
 * attachment follows that wording.
 *
 * A call on the placeholder advisor keeps its fixed code body
 * (`placeholderReminderBody`): its rules are about who must never be replied to, which
 * no template should be able to undo. Only the email's own `{when}` goes into it.
 *
 * Pure: no database, no clock, no network. The clock arrives in the input (`nowMs`).
 */

/** One fill-in an admin can place in a reminder email. */
export interface FillIn {
  /** Exactly what is written in the template, the name in braces. */
  token: string;
  name: string;
  /** What it becomes, in the domain's words, for the picker. */
  description: string;
  /** Whether it may go in a subject: one line and no link. */
  subject: boolean;
  /** A fixed paragraph rather than a phrase inside a sentence. */
  block: boolean;
}

/**
 * The one vocabulary. Order is the picker's order: the phrases a sentence is built
 * from first, then the block.
 */
export const FILL_INS: readonly FillIn[] = [
  {
    token: "{call with}",
    name: "call with",
    description: 'Who the call is with: "your call with Sam Rivera at Pennie", or "your call with Pennie" when the advisor has no name on record.',
    subject: true,
    block: false,
  },
  {
    token: "{when}",
    name: "when",
    description:
      'When the call is, as this email says it: the day and time ("tomorrow at 2:30pm EDT") for an email two hours or more before the call, the time until it otherwise ("in about an hour, at 5:05pm EDT").',
    subject: true,
    block: false,
  },
  {
    token: "{call time}",
    name: "call time",
    description: 'The time of the call in the lead\'s own zone ("2:30pm EDT").',
    subject: true,
    block: false,
  },
  {
    token: "{manage link}",
    name: "manage link",
    description: "The link where the lead can move or cancel the call.",
    subject: false,
    block: false,
  },
  {
    token: "{signature}",
    name: "signature",
    description: 'The advisor\'s name above "Pennie", or "Your Pennie advisor" when they have no name on record.',
    subject: false,
    block: false,
  },
  {
    token: "{how we call}",
    name: "how we call",
    description:
      "The number we will call the lead on. With the contact card switched on and the number the call comes from known, it also names that number, asks them to save it and attaches the card.",
    subject: false,
    block: true,
  },
];

const FILL_IN_BY_TOKEN = new Map(FILL_INS.map((f) => [f.token, f]));

/**
 * The least lead, in minutes, for which `{when}` names the DAY ("tomorrow at 2:30pm
 * EDT"); under it, `{when}` says the time until the call ("in about an hour, at ...").
 * Two hours, because inside that the day word is nearly always "today", which tells a
 * lead less than how long they have.
 */
export const WHEN_SAYS_THE_DAY_FROM_MINUTES = 120;

export type TemplateField = "subject" | "body";

/** One reason a template cannot be saved or sent. */
export type TemplateProblem =
  | { kind: "empty"; field: TemplateField }
  | { kind: "unknown"; field: TemplateField; token: string }
  | { kind: "malformed"; field: TemplateField; fragment: string }
  | { kind: "body_only"; field: "subject"; token: string }
  | { kind: "multiline_subject"; field: "subject" }
  | { kind: "timing" };

const FIELD_WORD: Record<TemplateField, string> = { subject: "subject", body: "body" };

/** The sentence an admin reads for a problem, naming what is wrong. */
export function describeTemplateProblem(p: TemplateProblem): string {
  switch (p.kind) {
    case "empty":
      return `The ${FIELD_WORD[p.field]} is empty.`;
    case "unknown":
      return `The ${FIELD_WORD[p.field]} uses ${p.token}, which is not a fill-in. Pick one from the list instead.`;
    case "malformed":
      return `The ${FIELD_WORD[p.field]} has a brace that does not make a fill-in: "${p.fragment}".`;
    case "body_only":
      return `${p.token} can only go in the body.`;
    case "multiline_subject":
      return "The subject must be a single line.";
    case "timing":
      return "This email has no readable timing, so {when} cannot be worked out.";
  }
}

type Piece = { text: string } | { fill: FillIn } | { unknown: string } | { malformed: string };

/**
 * Splits one field into literal text and fill-ins. A fill-in is a `{` and the next `}`
 * with no brace between; a `{` that meets another `{` or the end first, and a `}` with
 * no opening brace, are malformed, so a typo can never pass through as literal braces.
 */
function scan(text: string): Piece[] {
  const pieces: Piece[] = [];
  let literal = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "}") {
      if (literal) pieces.push({ text: literal });
      literal = "";
      pieces.push({ malformed: "}" });
      i += 1;
      continue;
    }
    if (ch !== "{") {
      literal += ch;
      i += 1;
      continue;
    }
    if (literal) pieces.push({ text: literal });
    literal = "";
    let j = i + 1;
    while (j < text.length && text[j] !== "{" && text[j] !== "}") j += 1;
    if (j < text.length && text[j] === "}") {
      const token = text.slice(i, j + 1);
      const fill = FILL_IN_BY_TOKEN.get(token);
      pieces.push(fill ? { fill } : { unknown: token });
      i = j + 1;
    } else {
      pieces.push({ malformed: text.slice(i, j) });
      i = j;
    }
  }
  if (literal) pieces.push({ text: literal });
  return pieces;
}

function fieldProblems(field: TemplateField, text: string): TemplateProblem[] {
  if (text.trim() === "") return [{ kind: "empty", field }];
  const problems: TemplateProblem[] = [];
  if (field === "subject" && /[\r\n]/.test(text)) problems.push({ kind: "multiline_subject", field });
  for (const piece of scan(text)) {
    if ("unknown" in piece) problems.push({ kind: "unknown", field, token: piece.unknown });
    else if ("malformed" in piece) problems.push({ kind: "malformed", field, fragment: piece.malformed });
    else if ("fill" in piece && field === "subject" && !piece.fill.subject) {
      problems.push({ kind: "body_only", field, token: piece.fill.token });
    }
  }
  return problems;
}

/**
 * Every reason this subject and body cannot be saved, in reading order, subject first.
 * Empty means it is valid. Run on save AND on restore, since a restored version was
 * written under whatever vocabulary held then.
 */
export function validateTemplate(subject: string, body: string): TemplateProblem[] {
  return [...fieldProblems("subject", subject), ...fieldProblems("body", body)];
}

/** What the renderer needs of a stored reminder email. */
export interface ReminderTemplate {
  /** How long before the call it goes out; decides what `{when}` says. */
  minutesBefore: number;
  subject: string;
  body: string;
  /** Whether `{how we call}` may name the calling number and attach the contact card. */
  cardBlock: boolean;
}

export type RenderedReminder =
  | { ok: true; subject: string; body: string; cardAttached: boolean }
  | { ok: false; problems: TemplateProblem[] };

/**
 * The email a lead receives from this template, or a refusal. A stored template
 * holding anything `validateTemplate` refuses is never rendered, so a lead can never
 * receive literal braces: the caller does not send, and alerts for that booking.
 *
 * `cardAttached` is true only when the rendered body carries the sentence the card is
 * named in, so the card never arrives without the words that explain it.
 */
export function renderReminder(template: ReminderTemplate, input: ReminderCopyInput): RenderedReminder {
  if (!Number.isFinite(template.minutesBefore)) return { ok: false, problems: [{ kind: "timing" }] };
  const problems = validateTemplate(template.subject, template.body);
  if (problems.length > 0) return { ok: false, problems };

  // A placeholder call is always "with Pennie": the seat's name is the sender's display
  // name and nothing more (#4206), so no fill-in names it either.
  const name = input.onPlaceholder ? null : realAdvisorName(input.agentName);
  const when =
    template.minutesBefore >= WHEN_SAYS_THE_DAY_FROM_MINUTES
      ? `${dayWord(input)} at ${timeLabel(input)}`
      : `${soonWord(input)}, at ${timeLabel(input)}`;
  // The card only for a call that is not on the placeholder: its number reaches nobody.
  const howWeCall = howWeCallLine(
    input.leadPhone,
    template.cardBlock && !input.onPlaceholder ? input.callingNumber : null,
    name !== null,
  );
  let cardAttached = false;
  const values: Record<string, () => string> = {
    "{call with}": () => (name ? `your call with ${name} at Pennie` : "your call with Pennie"),
    "{when}": () => when,
    "{call time}": () => timeLabel(input),
    "{manage link}": () => input.manageUrl,
    "{signature}": () => (name ? `${name}\nPennie` : "Your Pennie advisor"),
    "{how we call}": () => {
      if (howWeCall.card) cardAttached = true;
      return howWeCall.line;
    },
  };
  const fill = (text: string): string =>
    scan(text)
      .map((piece) => ("text" in piece ? piece.text : "fill" in piece ? values[piece.fill.token]() : ""))
      .join("");

  const subject = fill(template.subject);
  if (input.onPlaceholder) {
    return { ok: true, subject, body: placeholderReminderBody(when, input.leadPhone), cardAttached: false };
  }
  const body = fill(template.body);
  return { ok: true, subject, body, cardAttached };
}

/** How a reminder email treats a call booked after its window has already opened. */
export type LateBooking = "send_now" | "skip";

/**
 * An email's stored name as an alert says it ("the 24 hour reminder email"), with a
 * name that already ends in "email" not given a second one. ONE helper for every page
 * about a reminder email (the lane's, the failure share's and the owed check's, #4300),
 * so the three can never name the same email two ways.
 */
export function reminderEmailLabel(name: string): string {
  const label = name.trim().replace(/\s*emails?$/i, "").trim();
  return label === "" ? "reminder" : label;
}

export interface DefaultReminderTemplate extends ReminderTemplate {
  slug: "day" | "hour";
  name: string;
  lateBooking: LateBooking;
  placeholderSends: boolean;
}

/** Today's body, shared by both emails, which differ only in what `{when}` says. */
const DEFAULT_BODY = [
  "Hi, this is a reminder that {call with} is {when}.",
  "",
  "{how we call}",
  "",
  "If that time no longer works, you can pick another or cancel here: {manage link}",
  "",
  "If it is easier, just reply to this email and it will reach me directly.",
  "",
  "{signature}",
].join("\n");

/**
 * The two emails as they are sent today (#2359, #4282), written as templates. This
 * exists ONLY so the migration that seeds `reminder_emails` can be pinned to it, and
 * so the parity test can prove these render exactly as `reminderBody` and
 * `hourReminderBody` do. The lane never falls back to it: a failed read of the stored
 * emails sends nothing and pages.
 */
export const DEFAULT_TEMPLATES: Record<"day" | "hour", DefaultReminderTemplate> = {
  day: {
    slug: "day",
    name: "24 hour reminder",
    minutesBefore: 1440,
    lateBooking: "send_now",
    subject: "Your Pennie call {when}",
    body: DEFAULT_BODY,
    cardBlock: true,
    placeholderSends: true,
  },
  hour: {
    slug: "hour",
    name: "1 hour reminder",
    minutesBefore: 60,
    lateBooking: "skip",
    subject: "Your Pennie call is {when}",
    body: DEFAULT_BODY,
    cardBlock: true,
    placeholderSends: true,
  },
};
