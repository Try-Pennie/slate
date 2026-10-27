// `pnpm send:reminder-example`: one reminder, the 24 hour one by default or the 1 hour
// one with REMINDER_EXAMPLE_KIND=hour (#4285), built by the real lane, sent to a Pennie
// inbox so somebody can see what a lead receives. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reminder-example.ts
//
// The command emails a real inbox from a real advisor's mailbox, so the properties
// under test are the ones that keep it from reaching anybody else: it refuses an
// outside recipient, it sends nothing without SEND=1, it never claims or writes a
// booking, and a reminder that went out without its contact card is not a pass.
import {
  EXAMPLE_EXIT,
  exampleBooking,
  exampleDeps,
  judgeExampleRun,
  readExampleConfig,
} from "./lib/reminder-example.ts";
import { runBookingReminders, type ReminderDeps } from "../src/lib/booking/reminder-send.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NOW = Date.UTC(2026, 9, 2, 14, 7, 0);
const LEAD = "00QUi000010889ZMAQ";

// --- config ---------------------------------------------------------------

{
  const ok = readExampleConfig({
    REMINDER_EXAMPLE_ADVISOR: " MArnold@trypennie.com ",
    REMINDER_EXAMPLE_TO: "tconway@trypennie.com",
  });
  assert(ok.ok, "an advisor and a Pennie recipient is a usable config");
  if (ok.ok) {
    eq(ok.config.advisorEmail, "marnold@trypennie.com", "the advisor address is trimmed and lowercased");
    eq(ok.config.send, false, "nothing is sent unless SEND=1 is set");
    eq(ok.config.timezone, "America/New_York", "the lead's zone defaults to Eastern");
    eq(ok.config.leadId, null, "no lead named means the advisor's own latest lead is used");
  }

  const sending = readExampleConfig({
    REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com",
    REMINDER_EXAMPLE_TO: "tconway@trypennie.com",
    REMINDER_EXAMPLE_LEAD: LEAD,
    REMINDER_EXAMPLE_TZ: "America/Phoenix",
    SEND: "1",
  });
  assert(sending.ok && sending.config.send, "SEND=1 sends");
  assert(sending.ok && sending.config.leadId === LEAD, "a named lead is used");
  assert(sending.ok && sending.config.timezone === "America/Phoenix", "a named zone is used");

  const refusals: [Record<string, string>, string][] = [
    [{ REMINDER_EXAMPLE_TO: "tconway@trypennie.com" }, "no advisor"],
    [{ REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com" }, "no recipient"],
    [
      { REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com", REMINDER_EXAMPLE_TO: "someone@gmail.com" },
      "a recipient outside Pennie",
    ],
    [
      { REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com", REMINDER_EXAMPLE_TO: "x@trypennie.com.evil.io" },
      "a recipient that only starts like a Pennie address",
    ],
    [
      { REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com", REMINDER_EXAMPLE_TO: "a@trypennie.com,b@gmail.com" },
      "a list of recipients",
    ],
    [
      {
        REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com",
        REMINDER_EXAMPLE_TO: "tconway@trypennie.com",
        REMINDER_EXAMPLE_LEAD: "not-a-lead",
      },
      "a lead id that is not a Salesforce lead",
    ],
    [
      {
        REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com",
        REMINDER_EXAMPLE_TO: "tconway@trypennie.com",
        REMINDER_EXAMPLE_TZ: "Mars/Olympus",
      },
      "a zone that does not exist",
    ],
    [
      {
        REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com",
        REMINDER_EXAMPLE_TO: "tconway@trypennie.com",
        SEND: "yes",
      },
      "a SEND value other than 1",
    ],
  ];
  const messages = new Set<string>();
  for (const [env, why] of refusals) {
    const r = readExampleConfig(env);
    assert(!r.ok, `refuses ${why}`);
    if (!r.ok) messages.add(r.reason);
  }
  // Both outside addresses are one reason (not a Pennie inbox); every other refusal
  // names its own.
  eq(messages.size, refusals.length - 1, "each distinct refusal says its own reason");
}

// --- the booking ----------------------------------------------------------

const cfg = (() => {
  const r = readExampleConfig({
    REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com",
    REMINDER_EXAMPLE_TO: "tconway@trypennie.com",
  });
  if (!r.ok) throw new Error("fixture config refused");
  return r.config;
})();
const advisor = { id: "user-miles", name: "Miles Arnold", email: "marnold@trypennie.com" };

{
  const b = exampleBooking(cfg, advisor, LEAD, NOW);
  const startMs = Date.parse(b.startsAtIso);
  assert(startMs > NOW && startMs - NOW <= 24 * 60 * 60_000, "the call is inside the reminder window");
  eq(startMs % (30 * 60_000), 0, "the call starts on a half hour, as a real slot does");
  eq(b.attendeeEmail, "tconway@trypennie.com", "the lead is the recipient");
  eq(b.agentEmail, "marnold@trypennie.com", "the sender is the advisor");
  eq(b.gcalEventId, null, "there is no invite, so no calendar is touched");
  eq(b.leadId, LEAD, "the calling number comes from the chosen lead");
}

// --- one run through the real lane -----------------------------------------

type Sent = Parameters<ReminderDeps["send"]>[0];

function harness(over: { numbers?: Map<string, string | null> | Error; sendFails?: boolean; send?: boolean } = {}) {
  const sent: Sent[] = [];
  const writes: string[] = [];
  const deps = exampleDeps({
    config: { ...cfg, send: over.send ?? true },
    booking: exampleBooking(cfg, advisor, LEAD, NOW),
    nowMs: NOW,
    readCallingNumbers: async () => {
      if (over.numbers instanceof Error) throw over.numbers;
      return over.numbers ?? new Map([[LEAD.slice(0, 15), "+15555550123"]]);
    },
    readAdvisorPhotos: async () => new Map(),
    sendEmail: async (msg) => {
      if (over.sendFails) throw new Error("400 invalid_grant");
      sent.push(msg);
      return "msg-1";
    },
    preview: () => {},
    warn: () => {},
  });
  return { deps, sent, writes };
}

{
  const h = harness();
  const run = await runBookingReminders(h.deps);
  eq(h.sent.length, 1, "SEND=1 sends exactly one email");
  eq(h.sent[0]?.to, ["tconway@trypennie.com"], "to the Pennie recipient only");
  eq(h.sent[0]?.from, "marnold@trypennie.com", "from the advisor's mailbox");
  eq(h.sent[0]?.fromName, "Miles Arnold", "under the advisor's name");
  eq(h.sent[0]?.attachments?.length, 1, "with the contact card");
  eq(judgeExampleRun(run, true).code, EXAMPLE_EXIT.ok, "a sent reminder with its card passes");
}

{
  const h = harness({ send: false });
  const run = await runBookingReminders(h.deps);
  eq(h.sent.length, 0, "without SEND=1 nothing is sent");
  const v = judgeExampleRun(run, false);
  eq(v.code, EXAMPLE_EXIT.ok, "a preview with its card passes");
  assert(/not sent/i.test(v.message), "and says it was not sent");
}

{
  const h = harness({ numbers: new Map() });
  const run = await runBookingReminders(h.deps);
  eq(judgeExampleRun(run, true).code, EXAMPLE_EXIT.noCard, "a lead with no calling number is not a pass: the card is the point");
}

{
  const h = harness({ numbers: new Error("salesforce down") });
  const run = await runBookingReminders(h.deps);
  const v = judgeExampleRun(run, true);
  eq(v.code, EXAMPLE_EXIT.noCard, "an unreadable calling number is not a pass");
  assert(/salesforce/i.test(v.message), "and names Salesforce as the reason, apart from a lead with none");
}

{
  const h = harness({ sendFails: true });
  const run = await runBookingReminders(h.deps);
  eq(judgeExampleRun(run, true).code, EXAMPLE_EXIT.sendFailed, "a refused send fails the command");
}

{
  // The lane would have claimed the booking; the example has no booking to claim,
  // and must never write a calendar or page Slack.
  const h = harness();
  eq(await h.deps.claim("example-reminder", "x"), true, "the claim is a no op that always wins");
  let threw = false;
  try {
    await h.deps.refreshInvite("a", "b", "c");
  } catch {
    threw = true;
  }
  assert(threw, "an invite write is refused rather than performed");
}

{
  const codes = Object.values(EXAMPLE_EXIT);
  eq(new Set(codes).size, codes.length, "no two outcomes share an exit code");
}

// --- the command reads .env.local itself -----------------------------------
//
// It is run by typing one line, and a shell `source` of .env.local cannot read the
// multi-line Google private key, so the first real send failed for want of it. The
// command therefore loads the file itself. Proven through the REAL entry point in a
// scratch directory, with nothing in the environment: the file puts a multi-line
// quoted key FIRST and the example settings after it, so the settings are only seen
// if the file was read, and read past that key. The outside recipient makes the
// command refuse at the config step, before it touches the network.

function runCommand(envFile: string | null): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "reminder-example-"));
  try {
    if (envFile !== null) writeFileSync(join(dir, ".env.local"), envFile);
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--import",
        resolve("scripts/register-paths.mjs"),
        resolve("scripts/send-reminder-example.ts"),
      ],
      { cwd: dir, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 30_000 },
    );
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const fromFile = runCommand(
    [
      // Shaped like the Google key (a quoted value over several lines) without its
      // header, which the secret scanner rightly refuses to see committed.
      'EXAMPLE_MULTILINE_VALUE="first line',
      "second line",
      'third line"',
      "REMINDER_EXAMPLE_ADVISOR=marnold@trypennie.com",
      "REMINDER_EXAMPLE_TO=someone@gmail.com",
      "",
    ].join("\n"),
  );
  eq(fromFile.status, EXAMPLE_EXIT.config, "the command refuses at the config step");
  assert(
    /must be one @trypennie\.com address/.test(fromFile.stderr),
    "it read both settings from .env.local, past a multi-line key, and judged the recipient",
  );

  // The control: no file, so the settings are missing rather than refused, which
  // proves the assertion above was answered by the file and not by the environment.
  const noFile = runCommand(null);
  eq(noFile.status, EXAMPLE_EXIT.config, "with no .env.local it also stops at the config step");
  assert(/Set REMINDER_EXAMPLE_ADVISOR/.test(noFile.stderr), "and says the advisor is missing");
}

// --- the 1 hour email (#4285) -------------------------------------------------
//
// Since #4282 a lead also gets a 1 hour email. REMINDER_EXAMPLE_KIND=hour sends that one
// instead, through the same lane, so it can be read in a real inbox before a lead does.
{
  eq(cfg.kind, "day", "the 24 hour email is the default, as before");
  const hour = readExampleConfig({
    REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com",
    REMINDER_EXAMPLE_TO: "tconway@trypennie.com",
    REMINDER_EXAMPLE_KIND: "hour",
  });
  assert(hour.ok && hour.config.kind === "hour", "REMINDER_EXAMPLE_KIND=hour picks the 1 hour email");
  const odd = readExampleConfig({
    REMINDER_EXAMPLE_ADVISOR: "marnold@trypennie.com",
    REMINDER_EXAMPLE_TO: "tconway@trypennie.com",
    REMINDER_EXAMPLE_KIND: "weekly",
  });
  assert(!odd.ok && /day or hour/.test(odd.reason), "any other kind is refused, naming the two");
}
{
  const hourCfg = { ...cfg, kind: "hour" as const };
  const b = exampleBooking(hourCfg, advisor, LEAD, NOW);
  const leadMs = Date.parse(b.startsAtIso) - NOW;
  assert(leadMs >= 30 * 60_000 && leadMs <= 60 * 60_000, `the call is inside the 1 hour email's window (${leadMs / 60_000} min)`);

  const sent: Sent[] = [];
  const warned: string[] = [];
  const deps = exampleDeps({
    config: { ...hourCfg, send: true },
    booking: b,
    nowMs: NOW,
    readCallingNumbers: async () => new Map([[LEAD.slice(0, 15), "+15555550123"]]),
    readAdvisorPhotos: async () => new Map(),
    sendEmail: async (msg) => {
      sent.push(msg);
      return "msg-1";
    },
    preview: () => {},
    warn: (msg) => warned.push(msg),
  });
  const run = await runBookingReminders(deps, hourCfg.kind);
  eq(sent.length, 1, "the 1 hour example sends exactly one email");
  assert(/in about an hour/.test(sent[0]?.subject ?? ""), `in the 1 hour words (${sent[0]?.subject})`);
  eq(judgeExampleRun(run, true).code, EXAMPLE_EXIT.ok, "and passes");

  // The 24 hour example records its send time through the lane's markSent, which the
  // example must answer without writing anything.
  const dayWarned: string[] = [];
  const dayDeps = exampleDeps({
    config: { ...cfg, send: true },
    booking: exampleBooking(cfg, advisor, LEAD, NOW),
    nowMs: NOW,
    readCallingNumbers: async () => new Map([[LEAD.slice(0, 15), "+15555550123"]]),
    readAdvisorPhotos: async () => new Map(),
    sendEmail: async () => "msg-2",
    preview: () => {},
    warn: (msg) => dayWarned.push(msg),
  });
  await runBookingReminders(dayDeps);
  eq(dayWarned, [], "the 24 hour example finishes with no warning about its send time");
}

finish();
