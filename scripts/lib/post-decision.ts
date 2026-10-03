// Post a scheduled check's decision, or say nothing (#3092, #3101).
//
// The daily dependency audit and the nightly coverage ratchet each decide a message
// (or none) in a pure module, then end the same way: post it to the channel the
// workflow names, and stay red whether or not the post landed. This is that ending,
// once. Imports nothing, like every alerter here (#1598).

export type PostFn = (msg: {
  text: string;
  channel?: string;
}) => Promise<{ ok: boolean; error?: string }>;

export async function postDecision(
  post: PostFn,
  env: Record<string, string | undefined>,
  decision: { alert: string | null; detail: string },
): Promise<{ code: number; reason: string; detail: string }> {
  if (decision.alert === null) return { code: 0, reason: "nothing to say", detail: decision.detail };
  // The channel comes from the workflow, never from a database lookup (#1598). An
  // empty value is refused by name by the poster rather than posted into nowhere.
  const channel = env.SLACK_ALERTS_CHANNEL?.trim() || undefined;
  const res = await post({ text: decision.alert, ...(channel ? { channel } : {}) });
  // Red either way: a posted alert does not fix what it reports, and an unsent one is
  // not evidence that there was nothing to report.
  return { code: 1, reason: res.ok ? "posted" : (res.error ?? "unknown-error"), detail: decision.detail };
}
