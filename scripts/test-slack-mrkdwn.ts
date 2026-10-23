// #3528 (L757): text a person can edit is escaped for Slack at the point every message
// is SENT, never at each call site.
//
// Before this, an agent's time off reason and notes went into the manager's Slack
// notice as typed (`managerNotice`, src/lib/ooo/orchestration.ts), and the notice is
// posted to the fallback channel when the DM fails. A reason reading `<!channel>`
// pinged that whole channel, and `<https://anywhere|Review it here>` rendered as a link
// beside the real one. The one place that guarded against it was the smoke canary's
// own `withoutBroadcastMentions`, a per-call-site escape the next sender did not use.
//
// The rule, in `slackSafeMrkdwn` (scripts/lib/slack-mrkdwn.ts): `&`, `<` and `>` are
// escaped everywhere, which is Slack's own escaping rule, and the only markup put back
// is a link to one of the origins the sender names. No Slate sender writes a mention on
// purpose (measured: no `<!`, `<@` or `<#` in any message builder), and every link
// Slate writes points at the app itself, so nothing intended is lost.
//
// Run: node --experimental-strip-types scripts/test-slack-mrkdwn.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { slackLinkLabel, slackSafeBlocks, slackSafeMrkdwn } from "./lib/slack-mrkdwn.ts";

const APP = "https://slate.trypennie.app";

// --- every mention form is inert ----------------------------------------------
for (const mention of ["<!channel>", "<!here>", "<!everyone>", "<!subteam^S0123|@leads>", "<@U0123>", "<#C0123>"]) {
  const out = slackSafeMrkdwn(`Reason: ${mention} please`, [APP]);
  assert(!out.includes("<"), `${mention} reaches Slack with no live angle bracket (got ${out})`);
  assert(out.includes("&lt;"), `${mention} is escaped, so it reads as the text that was typed`);
}

// --- a link a person typed is text, not a link --------------------------------
{
  const out = slackSafeMrkdwn("Notes: <https://evil.example/x|Review it here>", [APP]);
  eq(out, "Notes: &lt;https://evil.example/x|Review it here&gt;", "a typed link to another site is escaped");
}
{
  // The origin must END where the allowed one ends: a lookalike host is not the app.
  const out = slackSafeMrkdwn("<https://slate.trypennie.app.evil.example/x|Review>", [APP]);
  eq(out, "&lt;https://slate.trypennie.app.evil.example/x|Review&gt;", "a host that merely starts with the app's is escaped");
}

// --- the links Slate writes survive ------------------------------------------
{
  const text = `*Time off request* from Sam\n<${APP}/admin/ooo?request=r1|Review it here>`;
  eq(slackSafeMrkdwn(text, [APP]), text, "a link to the app itself is kept as a link, and plain text is unchanged");
}
{
  const out = slackSafeMrkdwn(`<${APP}/me/time-off|My time off> & more`, [APP]);
  eq(out, `<${APP}/me/time-off|My time off> &amp; more`, "the kept link sits beside escaped text");
}
{
  const out = slackSafeMrkdwn(`<${APP}/x|Open>`, []);
  eq(out, `&lt;${APP}/x|Open&gt;`, "with no allowed origin, no link survives");
}

// --- ordinary text reads the same after Slack decodes it ----------------------
eq(slackSafeMrkdwn("Q&A < 5 > 3", [APP]), "Q&amp;A &lt; 5 &gt; 3", "Slack's three characters are escaped and nothing else");
eq(slackSafeMrkdwn("Plain *bold* _it_ :warning:", [APP]), "Plain *bold* _it_ :warning:", "formatting Slate writes on purpose is untouched");

// --- a typed link label: no entities, only what no escape can carry ------------
{
  const label = slackLinkLabel("Sam & Co <A>|B");
  eq(label, "Sam & Co <A›/B", "the label writes no entity; | and > become look-alikes");
  const sent = slackSafeMrkdwn(`<${APP}/admin/agents/u1|${label}>`, [APP]);
  eq(sent, `<${APP}/admin/agents/u1|Sam &amp; Co &lt;A›/B>`, "and the send point escapes it once inside a whole link");
}

// --- Block Kit: mrkdwn text is escaped, plain_text and ids are not ------------
{
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: "Reason: <!channel>" } },
    {
      type: "actions",
      block_id: "ooo_actions:r1",
      elements: [{ type: "button", action_id: "ooo_approve", value: "r1", text: { type: "plain_text", text: "Approve & go" } }],
    },
  ];
  const out = slackSafeBlocks(blocks, [APP]) as typeof blocks;
  eq(out[0].text?.text, "Reason: &lt;!channel&gt;", "a mrkdwn section is escaped");
  eq(
    (out[1] as { elements: { text: { text: string } }[] }).elements[0].text.text,
    "Approve & go",
    "plain_text is shown as written by Slack, so it is left alone",
  );
  eq((out[1] as { block_id: string }).block_id, "ooo_actions:r1", "ids are never touched");
  eq(blocks[0].text?.text, "Reason: <!channel>", "the caller's blocks are not mutated");
}

finish();
