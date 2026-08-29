// The contract every one-shot Actions alerter shares (#1596).
//
// scripts/notify-deploy-failure.ts and scripts/notify-smoke-failure.ts are the
// same shape: a pure message builder plus a `run(post, env, ...)` that posts once
// through an injected poster and FAILS LOUD (ok:false) when the post errors or
// Slack is unconfigured. Their two suites carried seven byte-identical assertion
// blocks between them; this is that boilerplate, extracted once.
//
// It is boilerplate, NOT coverage: both alerters still assert their own copy,
// their own env reader and their own failure modes in their own files. What moves
// here is only the part that was word for word the same.
//
// A shared helper is also somewhere coverage can quietly disappear: a helper that
// stopped asserting anything is indistinguishable from one whose assertions all
// passed (L98). So each function returns how many checks it made, and its callers
// pin that count.

/** A message as the Slack poster receives it. */
export type PostedMessage = { text: string; channel?: string };

/** The injected poster both alerters take. */
export type Poster = (m: PostedMessage) => Promise<{ ok: boolean; error?: string }>;

/** What an alerter's `run` resolves to. */
export type AlerterResult = { ok: boolean; reason?: string };

/** How many checks {@link assertHouseStyle} makes. Pinned by its callers. */
export const HOUSE_STYLE_CHECKS = 3;

/** How many checks {@link assertAlerterFailsLoud} makes. Pinned by its callers. */
export const FAIL_LOUD_CHECKS = 8;

/**
 * House style on a message a person reads in Slack mid incident: no dashes as
 * punctuation, no emoji of either kind. `label` distinguishes the caller's cases
 * (the smoke alerter checks a full pass and a dry one).
 *
 * @returns the number of checks made.
 */
export function assertHouseStyle(
  assert: (cond: boolean, msg: string) => void,
  text: string,
  label: string,
): number {
  const prefix = label ? `${label}: ` : "";
  // The dashes are written as escapes deliberately: a file holding the literal
  // characters would be rejected by the repo's own style hook, which cannot tell
  // the line banning a character from a line using it.
  assert(!new RegExp("[\u2014\u2013]").test(text), `${prefix}no em or en dashes`);
  assert(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text), `${prefix}no unicode emoji`);
  assert(!/:[a-z0-9_]+:/.test(text), `${prefix}no slack emoji shortcodes`);
  return HOUSE_STYLE_CHECKS;
}

/**
 * The fail-loud contract: post exactly once to the configured channel, and go
 * visibly red rather than pretending anyone was warned when Slack refuses or was
 * never configured. A silent no-op here is the whole defect these alerters exist
 * to avoid, since the run that needed the alert is the run nobody is watching.
 *
 * The two alerters take different arguments (one carries a failure-log io, one
 * does not) and are unconfigured for different reasons (a missing bot token
 * against a missing channel), so the caller supplies the two invocations and this
 * owns the assertions.
 *
 * @returns the number of checks made.
 */
export async function assertAlerterFailsLoud(
  assert: (cond: boolean, msg: string) => void,
  opts: {
    /** Run the alerter with Slack configured to post to `channel`. */
    configured: (post: Poster) => Promise<AlerterResult>;
    /** Run the alerter with Slack NOT configured. */
    unconfigured: (post: Poster) => Promise<AlerterResult>;
    /** The channel `configured` is wired to post to. */
    channel: string;
  },
): Promise<number> {
  // Happy path: exactly one post, to the configured channel.
  {
    const calls: PostedMessage[] = [];
    const res = await opts.configured(async (m) => {
      calls.push(m);
      return { ok: true };
    });
    assert(res.ok, "run returns ok on a successful post");
    assert(calls.length === 1, "run posts exactly once");
    assert(calls[0]?.channel === opts.channel, "run posts to SLACK_ALERTS_CHANNEL");
  }

  // Slack answered with an error.
  {
    let called = 0;
    const res = await opts.configured(async () => {
      called++;
      return { ok: false, error: "channel_not_found" };
    });
    assert(!res.ok, "run FAILS LOUD when the Slack post errors");
    assert(/channel_not_found/.test(res.reason ?? ""), "run surfaces the Slack error");
    assert(called === 1, "run attempted the post once");
  }

  // Slack was never configured. This is the one that used to be a silent no-op.
  {
    const res = await opts.unconfigured(async () => ({
      ok: false,
      error: "slack-not-configured",
    }));
    assert(!res.ok, "run FAILS LOUD when Slack is unconfigured");
    assert(
      /slack-not-configured/.test(res.reason ?? ""),
      "run surfaces the unconfigured reason",
    );
  }

  return FAIL_LOUD_CHECKS;
}
