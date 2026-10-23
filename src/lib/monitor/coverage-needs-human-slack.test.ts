import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3528 review finding: the coverage page's advisor link (#3485) escaped the name's
// `&`, `<` and `>` itself, and the send point now escapes everything again, so a name
// with `&` reached Slack as `&amp;amp;` and showed as `&amp;`. Builders write plain text
// and the send point escapes it once. This drives the real builder through the real
// send path (`postSlack`), with Slack replaced by a fetch fake: nothing leaves the test.
const APP = "https://slate.trypennie.app";
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  slackBotToken: () => "xoxb-test",
  appUrl: () => APP,
}));

import { formatCoverageNeedsHumanAlert, type StrandedHolder } from "./coverage-needs-human";
import { postSlack } from "@/lib/notify/slack";

let sentText = "";

beforeEach(() => {
  sentText = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sentText = (JSON.parse(String(init.body)) as { text: string }).text;
      return new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const holder = (name: string): StrandedHolder => ({
  userId: "u1",
  name,
  email: "sam@trypennie.com",
  unplaceable: 1,
  failed: 0,
});

async function send(name: string): Promise<string> {
  await postSlack({ channel: "C1", text: formatCoverageNeedsHumanAlert([holder(name)], APP) });
  return sentText;
}

describe("the coverage page's advisor link reaches Slack escaped exactly once", () => {
  it("a name with & and < is single escaped inside a working link", async () => {
    const text = await send("Sam & Co <Ops");
    expect(text).toContain(`<${APP}/admin/agents/u1|Sam &amp; Co &lt;Ops (sam@trypennie.com)>`);
    expect(text).not.toContain("&amp;amp;");
    expect(text).not.toContain("&amp;lt;");
  });

  it("a name with > or | cannot end or split the link", async () => {
    const text = await send("A>B|C");
    // `>` has no form the send point can tell from the link's own end, and `|` splits
    // url from label, so the label swaps them for look-alikes rather than entities.
    expect(text).toContain(`<${APP}/admin/agents/u1|A›B/C (sam@trypennie.com)>`);
    expect(text).not.toContain("&amp;gt;");
  });
});
