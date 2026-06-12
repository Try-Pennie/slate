// Branded booking email template tests: subjects, lead-timezone time
// formatting, manage link, agent first name, and the copy rules (no dashes,
// no guarantees).
// Run: node --experimental-strip-types scripts/test-email-templates.ts
import {
  formatLeadTime,
  renderBookingEmail,
  type BookingEmailKind,
  type BookingEmailPayload,
} from "../src/lib/email/templates.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const base: Omit<BookingEmailPayload, "kind"> = {
  agentName: "Avery Agent",
  attendeeName: "Kris Lead",
  eventTypeName: "Senior Loan Advisor Call",
  startIso: "2026-06-20T17:00:00.000Z",
  timezone: "America/New_York",
  durationMin: 30,
  manageUrl: "https://slate.test/booking/manage/tok1",
};

const KINDS: BookingEmailKind[] = ["created", "rescheduled", "cancelled"];
const EXPECTED_TIME = "Saturday, June 20 at 1:00pm ET";

// --- formatLeadTime ---
{
  assert(
    formatLeadTime(base.startIso, base.timezone) === EXPECTED_TIME,
    `formatLeadTime: "${EXPECTED_TIME}" in the lead's timezone`,
  );
  assert(
    formatLeadTime(base.startIso, "America/Los_Angeles") ===
      "Saturday, June 20 at 10:00am PT",
    "formatLeadTime: respects a different lead timezone",
  );
  assert(
    formatLeadTime("2026-01-20T17:00:00.000Z", "America/New_York").endsWith("ET"),
    "formatLeadTime: EST also collapses to ET",
  );
}

// --- per-kind rendering ---
for (const kind of KINDS) {
  const { subject, html, text } = renderBookingEmail({ ...base, kind });

  assert(
    html.includes(base.manageUrl) && text.includes(base.manageUrl),
    `${kind}: manage link in html + text`,
  );
  assert(
    html.includes(EXPECTED_TIME) && text.includes(EXPECTED_TIME),
    `${kind}: timezone-formatted time appears in html + text`,
  );
  assert(
    html.includes("Avery") && text.includes("Avery") && !text.includes("Avery Agent"),
    `${kind}: agent FIRST name only`,
  );
  assert(text.includes("Hi Kris,"), `${kind}: greets the lead by first name`);
  assert(
    kind === "cancelled" || (html.includes("30 minutes") && text.includes("30 minutes")),
    `${kind}: duration appears`,
  );
  assert(html.includes("Manage my booking"), `${kind}: Manage my booking button`);
  assert(
    html.includes("Pennie · trypennie.com") || html.includes("Pennie ·"),
    `${kind}: Pennie footer in html`,
  );
  assert(text.includes("Pennie · trypennie.com"), `${kind}: Pennie footer in text`);

  // Copy rules: no em dashes anywhere, no spaced hyphens in copy, never "Submit".
  assert(!subject.includes("—") && !html.includes("—") && !text.includes("—"), `${kind}: no em dashes`);
  assert(
    !subject.includes(" - ") && !html.includes(" - ") && !text.includes(" - "),
    `${kind}: no spaced hyphens`,
  );
  assert(!/guarantee/i.test(text) && !/submit/i.test(text), `${kind}: no guarantees, no "Submit"`);

  // Brand styling stays inline + on-palette.
  assert(html.includes("#F9F6F0") && html.includes("#82D0FF") && html.includes("#343434"), `${kind}: Pennie palette inline`);
  assert(!/#000000|black/i.test(html), `${kind}: no hard black`);
}

// --- rendering robustness (bulletproof email markup) ---
// Font-family heuristic: Outlook resets any element missing font-family to
// Times New Roman. All visible text in these templates lives in <p>, <h1>,
// <h2>, <a>, and <span> elements, so every opening tag of those kinds must
// carry an inline style that declares font-family. (We do not inspect <td>
// directly: text-bearing tds delegate to their inner p/h1/a elements.)
for (const kind of KINDS) {
  const { html } = renderBookingEmail({ ...base, kind });

  const tableTags = html.match(/<table\b[^>]*>/g) ?? [];
  assert(
    tableTags.length >= 3 &&
      tableTags.every((t) => t.includes('role="presentation"')),
    `${kind}: every layout <table> has role="presentation" (${tableTags.length} tables)`,
  );

  assert(
    !/display\s*:\s*(flex|grid)/i.test(html) &&
      !/float\s*:/i.test(html) &&
      !/position\s*:/i.test(html),
    `${kind}: no flex, grid, float, or position CSS`,
  );

  const textTags = html.match(/<(?:p|h1|h2|a|span)\b[^>]*>/g) ?? [];
  assert(
    textTags.length > 0 &&
      textTags.every((t) => t.includes('style="') && t.includes("font-family")),
    `${kind}: every text element declares font-family inline (${textTags.length} checked)`,
  );

  // CTA href appears as a styled button AND as visible plain-text link copy.
  const hrefCount = html.split(`href="${base.manageUrl}"`).length - 1;
  assert(
    hrefCount >= 2,
    `${kind}: manage URL is an href at least twice (button + text fallback)`,
  );
  assert(
    html.includes(`>${base.manageUrl}</a>`),
    `${kind}: manage URL also visible as plain link text`,
  );

  const preheader =
    /<div style="display:none[^>]*mso-hide:all[^>]*>([^<]*)<\/div>/.exec(html);
  assert(
    preheader !== null && preheader[1].includes(EXPECTED_TIME),
    `${kind}: hidden preheader present and carries the time summary`,
  );

  const divTags = html.match(/<div\b[^>]*>/g) ?? [];
  assert(
    divTags.every((t) => t.includes("display:none")),
    `${kind}: no div-based layout (only the hidden preheader div)`,
  );

  assert(
    html.includes('name="color-scheme" content="light"') &&
      html.includes('name="supported-color-schemes" content="light"'),
    `${kind}: light color-scheme metas`,
  );

  assert(
    html.startsWith(
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"',
    ),
    `${kind}: XHTML 1.0 Transitional doctype`,
  );
  assert(
    html.includes("max-width:600px") && html.includes('width="600"'),
    `${kind}: 600px container (fluid max-width + mso fixed width)`,
  );
  assert(html.includes("<!--[if mso]>"), `${kind}: mso conditional present`);

  const bodyTag = /<body\b[^>]*>/.exec(html)?.[0] ?? "";
  assert(bodyTag.includes('bgcolor="#F9F6F0"'), `${kind}: bgcolor on <body>`);
  assert(
    html.includes('bgcolor="#82D0FF"'),
    `${kind}: bgcolor on the button cell`,
  );
  assert(html.includes('bgcolor="#FFFFFF"'), `${kind}: bgcolor on the card`);

  assert(!/<img/i.test(html), `${kind}: imageless`);
  assert(
    !/@font-face|fonts\.googleapis|<link/i.test(html),
    `${kind}: no webfont loading`,
  );
  assert(
    html.includes("mso-line-height-rule:exactly"),
    `${kind}: mso line-height rule applied`,
  );
}

// --- subjects ---
{
  assert(
    renderBookingEmail({ ...base, kind: "created" }).subject ===
      "Your call with Avery is confirmed",
    "created subject",
  );
  assert(
    renderBookingEmail({ ...base, kind: "rescheduled" }).subject ===
      "Your call has a new time",
    "rescheduled subject",
  );
  assert(
    renderBookingEmail({ ...base, kind: "cancelled" }).subject ===
      "Your call has been cancelled",
    "cancelled subject",
  );
}

// --- missing names degrade gracefully ---
{
  const { subject, html, text } = renderBookingEmail({
    ...base,
    kind: "created",
    agentName: null,
    attendeeName: null,
  });
  assert(subject === "Your call is confirmed", "no agent: subject drops the name");
  assert(text.startsWith("Hi,"), "no attendee: plain greeting");
  assert(html.includes("Pennie advisor") && text.includes("Pennie advisor"), "no agent: advisor fallback copy");
}

// --- html safety ---
{
  const { html } = renderBookingEmail({
    ...base,
    kind: "created",
    attendeeName: "<script>alert(1)</script>",
    agentName: "A&B Agent",
  });
  assert(!html.includes("<script>"), "html: attendee name is escaped");
  assert(html.includes("A&amp;B"), "html: ampersands escaped");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
