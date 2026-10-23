/**
 * Slack's escaping rule, applied where a message is SENT (#3528, L757).
 *
 * A message is assembled from copy Slate writes and values a person typed: an agent's
 * time off reason and notes, a manager's decline note, a name. Slack reads `<...>` in
 * mrkdwn as markup, so a typed `<!channel>` pings everybody in the channel and a typed
 * `<https://anywhere|Review it here>` renders as a link. Escaping each value where it is
 * interpolated is skipped by the next sender written, so the escape lives at the send
 * point instead, in the two places Slack is posted to: `src/lib/notify/slack.ts` for
 * the app and `scripts/lib/slack-post.ts` for the workflows that run on bare node
 * (`scripts/test-slack-send-points.ts` holds every other file to those two).
 *
 * The send point cannot tell typed text from written text, so the rule is about what
 * Slate WRITES: it never writes a mention (no `<!`, `<@` or `<#` in any builder), and
 * every link it writes points at the app itself. So `&`, `<` and `>` are escaped
 * everywhere, which is Slack's own rule and reads identically once Slack decodes it,
 * and the only markup put back is a `<url|label>` link whose url is on an origin the
 * sender names. A person can still type a link to the app; nothing else becomes markup.
 *
 * `*bold*`, `_italic_` and emoji codes are left alone: Slack has no escape for them,
 * and they cannot ping anyone or point anywhere.
 *
 * No imports, so the bare node posters and the app share this one copy.
 */

function escapeAll(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A link, as it reads AFTER escaping: `&lt;url|label&gt;` or `&lt;url&gt;`. */
const ESCAPED_LINK = /&lt;(https?:\/\/[^\s|]+?)(\|[^\n]*?)?&gt;/g;

/** Whether `url` is on `origin` exactly: the host must end where the origin does. */
function onOrigin(url: string, origin: string): boolean {
  const o = origin.replace(/\/+$/, "");
  if (o === "" || !url.startsWith(o)) return false;
  const next = url.charAt(o.length);
  return next === "" || next === "/" || next === "?" || next === "#";
}

/**
 * The text Slack should receive for `text`, which mixes what Slate wrote with what a
 * person typed. `linkOrigins` are the origins whose links stay links: the app's own,
 * for the app; none, for a sender that writes no links.
 */
export function slackSafeMrkdwn(text: string, linkOrigins: readonly string[]): string {
  const escaped = escapeAll(text);
  if (linkOrigins.length === 0) return escaped;
  return escaped.replace(ESCAPED_LINK, (whole, url: string, label: string | undefined) => {
    // The url was escaped with everything else, so `&` in a query reads `&amp;`. Slack
    // decodes entities inside a link's url too, so it is put back as it stands.
    const raw = url.replace(/&amp;/g, "&");
    return linkOrigins.some((o) => onOrigin(raw, o)) ? `<${url}${label ?? ""}>` : whole;
  });
}

/**
 * Block Kit with every `mrkdwn` text object made safe the same way. `plain_text` is
 * shown by Slack exactly as written (no markup, no entity decoding), so it is left
 * alone, as are ids, values and urls. Returns a copy; the caller's blocks are unchanged.
 */
export function slackSafeBlocks(blocks: unknown, linkOrigins: readonly string[]): unknown {
  if (Array.isArray(blocks)) return blocks.map((b) => slackSafeBlocks(b, linkOrigins));
  if (blocks === null || typeof blocks !== "object") return blocks;
  const obj = blocks as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = slackSafeBlocks(v, linkOrigins);
  if (obj.type === "mrkdwn" && typeof obj.text === "string") {
    out.text = slackSafeMrkdwn(obj.text, linkOrigins);
  }
  return out;
}
