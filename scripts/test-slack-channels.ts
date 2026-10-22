// #1957: refusing a broken Slack channel at save time, and showing where alerts
// really land.
//
// Two units, both pure, tested together because the panel draws both.
//
// The MAPPING is what is pinned, not Slack. A hand written double of Slack
// agrees with our assumption about its replies by construction (L52), so the
// fixtures below are shaped from the error strings Slack's own documentation
// names, and what is asserted is that each one reaches a DIFFERENT outcome with
// a DIFFERENT instruction. That distinction is the whole feature: a wrong id and
// an uninvited bot are different problems with different remedies (L11), and an
// answer Slate cannot get at all is neither.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-slack-channels.ts
// (the alias loader is needed since #2438: slack-channel-check.ts imports through `@/`)
import {
  channelCheckMessage,
  channelNames,
  checkedName,
  needsFollowUp,
  readChannelReply,
  refusesSave,
  type ChannelCheck,
} from "../src/lib/notify/slack-channel-check.ts";
import {
  effectiveChannelLine,
  effectiveChannels,
  type ChannelOrigin,
} from "../src/lib/notify/channel-effective.ts";
import { resolveChannels } from "../src/lib/notify/channels.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// ---------------------------------------------------------------- the mapping

{
  const ok = readChannelReply({ ok: true, data: { channel: { name: "alerts", is_member: true } } });
  eq(ok.state, "ok", "a channel the bot is in is ok");
  eq(ok.state === "ok" ? ok.name : null, "alerts", "and it carries the name Slack gave");
}

// THE 200 THAT IS NOT FINE. Slack answers success for a channel the bot is not a
// member of, and says so only in `is_member`. Reading the reply's `ok` alone
// accepts it, and the first alert then fails to post with nothing able to say so.
{
  const c = readChannelReply({ ok: true, data: { channel: { name: "ops", is_member: false } } });
  eq(c.state, "not-invited", "ok=true with is_member=false is not a usable channel");
  eq(c.state === "not-invited" ? c.name : null, "ops", "and the name survives, so the message can use it");
  assert(refusesSave(c), "an uninvited bot refuses the save");
}

// A reply with no membership field at all is NOT treated as uninvited: absence
// is not `false`, and refusing on it would refuse every correct channel the day
// Slack stopped sending the field.
{
  const c = readChannelReply({ ok: true, data: { channel: { name: "ops" } } });
  eq(c.state, "ok", "a missing is_member is not a refusal");
}

{
  const notFound = readChannelReply({ ok: false, error: "channel_not_found" });
  eq(notFound.state, "not-found", "channel_not_found is a typo in the id");
  assert(refusesSave(notFound), "a channel that does not exist refuses the save");

  const notIn = readChannelReply({ ok: false, error: "not_in_channel" });
  eq(notIn.state, "not-invited", "not_in_channel is an invite, not a typo");
  assert(refusesSave(notIn), "and it refuses too");

  assert(
    channelCheckMessage(notFound, "C123") !== channelCheckMessage(notIn, "C123"),
    "the two refusals say different things",
  );
  // #2438: one plain line of what went wrong and one short instruction, the same
  // shape as the field's own refusals (Dan's plain error copy rule).
  eq(
    channelCheckMessage(notFound, "C123"),
    "Slack has no channel C123. Pick one from the list or paste its channel ID.",
    "the typo case names the id and the way out, in two short sentences",
  );
  assert(
    /invite/i.test(channelCheckMessage(notIn, "C123")),
    "the uninvited case names the invite as the remedy",
  );
}

// THE UNVERIFIABLE ANSWER. This is the one the feature ships into: the Slack app
// has no `channels:read` scope until somebody changes it, and Slate must neither
// accept the channel (which ships the typo) nor refuse it (which refuses a
// correct channel and blocks every save).
{
  for (const err of ["missing_scope", "not_allowed_token_type", "slack-not-configured", "ratelimited", undefined]) {
    const c = readChannelReply({ ok: false, error: err });
    eq(c.state, "cannot-check", `${err ?? "no error at all"} is neither a good channel nor a bad one`);
    assert(!refusesSave(c), `${err ?? "no error at all"} does not refuse the save`);
    const msg = channelCheckMessage(c, "C123");
    assert(/could not check/i.test(msg), `${err ?? "no error at all"} says plainly that it did not check`);
    assert(!/undefined|null|\[object/.test(msg), `${err ?? "no error at all"} renders no leaked value`);
  }
  const scope = readChannelReply({ ok: false, error: "missing_scope" });
  const silent = readChannelReply({ ok: false, error: undefined });
  assert(
    channelCheckMessage(scope, "C1") !== channelCheckMessage(silent, "C1"),
    "a missing permission and a silent Slack are not the same sentence",
  );
}

// Every outcome the type declares renders a real sentence (L151, L113).
{
  const all: ChannelCheck[] = [
    { state: "ok", name: "alerts" },
    { state: "ok", name: null },
    { state: "not-found" },
    { state: "not-invited", name: "ops" },
    { state: "not-invited", name: null },
    { state: "cannot-check", why: "a reason" },
  ];
  for (const c of all) {
    const msg = channelCheckMessage(c, "C123");
    assert(msg.length > 0 && !/undefined|\[object/.test(msg), `${c.state} renders a sentence`);
  }
}

// A NAME IS NEVER INVENTED. An id cannot be turned into a name locally, so the
// panel may show one only where Slack supplied it. The two outcomes that carry
// one are the two where Slack really answered about that channel.
{
  eq(checkedName({ state: "ok", name: "alerts" }), "alerts", "a confirmed channel gives its name");
  eq(checkedName({ state: "not-invited", name: "ops" }), "ops", "so does one the bot is outside");
  eq(checkedName({ state: "ok", name: null }), null, "an answer with no name yields none");
  eq(checkedName({ state: "not-found" }), null, "a channel that does not exist has no name");
  eq(checkedName({ state: "cannot-check", why: "x" }), null, "nor does one nobody could ask about");
}

// #2438: THE NAMES THE CHANNEL FIELDS SHOW for stored ids, taken from the same
// checks the panel already made. Only an answer that carried a name contributes,
// so a field never shows a name Slack did not give.
{
  const names = channelNames(
    new Map<string, ChannelCheck>([
      ["C09F4L6PLQP", { state: "ok", name: "dan-systems-test" }],
      ["C0OPS00001", { state: "not-invited", name: "ops" }],
      ["C0GONE0001", { state: "not-found" }],
      ["C0SCOPE001", { state: "cannot-check", why: "x" }],
      ["C0NONAME01", { state: "ok", name: null }],
    ]),
  );
  eq(
    names,
    { C09F4L6PLQP: "dan-systems-test", C0OPS00001: "ops" },
    "only checks Slack answered with a name give one",
  );
  eq(channelNames(new Map()), {}, "no checks, no names");
  // The fields resolve typed names against STORED channels only, the same set the
  // save can name, so the field never accepts a name the save would refuse (L99).
  // The panel's checks also cover the deployment's default channels, which are not.
  eq(
    channelNames(
      new Map<string, ChannelCheck>([
        ["C09F4L6PLQP", { state: "ok", name: "dan-systems-test" }],
        ["C0ENVDEF01", { state: "ok", name: "env-default" }],
      ]),
      ["C09F4L6PLQP", "", "C0NOTCHKD1"],
    ),
    { C09F4L6PLQP: "dan-systems-test" },
    "limited to the ids asked for",
  );
}

// THE FOLLOW UP SENTENCE. A named, confirmed channel needs none: naming it is
// itself proof Slack answered, because the name cannot be derived from the id.
// Every other outcome needs one, and a check with no name is NOT silently
// treated as confirmed, which would be a blind check reading as a healthy one.
{
  assert(!needsFollowUp({ state: "ok", name: "alerts" }), "a named confirmation says everything already");
  assert(needsFollowUp({ state: "ok", name: null }), "a confirmation with no name still has to speak");
  assert(needsFollowUp({ state: "not-found" }), "a missing channel speaks");
  assert(needsFollowUp({ state: "not-invited", name: "ops" }), "so does an uninvited bot, despite having a name");
  assert(needsFollowUp({ state: "cannot-check", why: "x" }), "and so does an answer nobody could get");
}

// The name reaches the line, and the id stays with it: the id is what is stored
// and what anybody comparing this against the field below is looking at.
{
  const named = effectiveChannelLine("Urgent alerts", { channel: "C123", origin: "form" }, "alerts");
  assert(/#alerts/.test(named), "the line names the channel");
  assert(/C123/.test(named), "and still carries the id it stores");
  const unnamed = effectiveChannelLine("Urgent alerts", { channel: "C123", origin: "form" }, null);
  assert(!/#/.test(unnamed), "with no name from Slack it invents none");
  assert(/C123/.test(unnamed), "and falls back to the id alone");
}

// ------------------------------------------------------- the effective channel

const cfg = (a: string | null, i: string | null) => ({ alerts_channel: a, info_channel: i });

// THE VALUE IS NEVER RECOMPUTED. The panel may only name the channel the
// notifier would really use, so `effectiveChannels` takes its value from
// `resolveChannels` and this drives every combination through both (L70).
{
  const blanks = [null, "", "  ", "C-set"];
  let cases = 0;
  for (const a of blanks)
    for (const i of blanks)
      for (const ae of ["", "C-env-alerts"])
        for (const ie of ["", "C-env-info"]) {
          const config = cfg(a, i);
          const env = { alertsEnv: ae, infoEnv: ie };
          const want = resolveChannels(config, env);
          const got = effectiveChannels(config, env);
          eq(got.alerts.channel, want.alerts, `alerts value matches the notifier for ${JSON.stringify([a, i, ae, ie])}`);
          eq(got.info.channel, want.info, `info value matches the notifier for ${JSON.stringify([a, i, ae, ie])}`);
          cases++;
        }
  eq(cases, 64, "every combination of the four inputs was driven");
}

{
  const e = effectiveChannels(cfg("C-form", null), { alertsEnv: "C-env", infoEnv: "" });
  eq(e.alerts.origin, "form", "a stored channel is reported as set here");
  eq(e.info.origin, "alerts-fallback", "an unnamed info channel rides along with the alerts channel");
  eq(e.info.channel, "C-form", "and it is the RESOLVED alerts channel, not the env one");
}

// The fallback is to the RESOLVED alerts channel, which is the whole reason
// `resolveChannels` reads the raw env rather than a collapsed helper. With
// nothing in the environment and a channel stored here, the info notices must
// still ride along with it, and a fallback written against the env value alone
// would report them going nowhere.
{
  const e = effectiveChannels(cfg("C-form", null), { alertsEnv: "", infoEnv: "" });
  eq(e.info.origin, "alerts-fallback", "a stored alerts channel is enough for the info fallback");
  eq(e.info.channel, "C-form", "and the info notices land there");
  const line = effectiveChannelLine("Quiet notices", e.info);
  assert(!/nowhere/i.test(line), "so the line does not say they reach Slack nowhere");
}

{
  const e = effectiveChannels(null, { alertsEnv: "C-env", infoEnv: "C-env-info" });
  eq(e.alerts.origin, "server", "with nothing stored the deployment supplies it");
  eq(e.info.origin, "server", "for both destinations");
}

// NOTHING CONFIGURED ANYWHERE. The state that must be loud: no alert of that
// kind reaches Slack at all, and the only other record is a log line nobody
// reads (L67).
{
  const e = effectiveChannels(null, { alertsEnv: "", infoEnv: "" });
  eq(e.alerts.origin, "none", "no channel anywhere is its own origin");
  eq(e.info.origin, "none", "and the info channel cannot fall back to nothing");
  eq(e.alerts.channel, "", "with an empty value");
  const line = effectiveChannelLine("Urgent alerts", e.alerts);
  assert(/nowhere/i.test(line), "and the line says the alerts reach Slack nowhere");
  assert(!/^Urgent alerts post to/.test(line), "rather than naming a destination it does not have");
}

// Each origin says something DIFFERENT, so the line carries information rather
// than confirming that a channel exists (L11).
{
  const origins: ChannelOrigin[] = ["form", "server", "alerts-fallback", "none"];
  const lines = origins.map((origin) => effectiveChannelLine("Quiet notices", { channel: "C1", origin }));
  eq(new Set(lines).size, origins.length, "no two origins render the same sentence");
  for (const l of lines) assert(!/undefined|\[object/.test(l), "no origin leaks a value");
}

finish();
