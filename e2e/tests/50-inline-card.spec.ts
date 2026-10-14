/**
 * The inline card, drawn by a host page through cal.com's `Cal("inline")` (#3718).
 *
 * A host page on another origin loads the real widget.js from the local build and
 * asks for the card exactly as a landing page will, so this proves the whole path:
 * the inline command, `/book?layout=inline`, the card's own first screen and the
 * frame sizing itself from the booker's resize. Run in both themes at a desktop
 * column and a phone width, as the settled design (docs/design/inline-booker.html)
 * is drawn, with axe over each and a screenshot of each kept in e2e/.artifacts.
 */
import { createServer, type Server } from "node:http";
import { test, expect, seed, expectAccessible } from "../fixtures.ts";
import { E2E_APP_ORIGIN } from "../env.ts";

// Another origin on this machine, so the card is framed cross origin as it will be
// on a landing page. A real server rather than a faked response: Chrome treats a
// faked page as a public website, and its local network protection then refuses
// to let it load widget.js from this machine. On whatever port is free, so two
// runs never collide.
let HOST = "";
let host: Server;
let hostHtml = "";

test.beforeAll(async () => {
  host = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(hostHtml);
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const address = host.address();
  if (!address || typeof address === "string") throw new Error("the host page server has no port");
  HOST = `http://localhost:${address.port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => host.close(() => resolve()));
});

const WIDTHS = [
  { name: "desktop", viewport: { width: 1280, height: 900 }, column: 460, across: 3 },
  { name: "phone", viewport: { width: 390, height: 844 }, column: 358, across: 2 },
] as const;

function hostPage(theme: "light" | "dark", column: number): string {
  const call = JSON.stringify({ elementOrSelector: "#slot", calLink: `router?xbc=${seed.bucketCode}` });
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>A landing page</title></head>
<body style="margin:0;padding:16px;background:${theme === "dark" ? "#0c0b0e" : "#f9f6f0"}">
<div id="slot" style="width:${column}px;max-width:100%"></div>
<script src="${E2E_APP_ORIGIN}/widget.js"></script>
<script>
  Cal("init", "landing", { origin: ${JSON.stringify(E2E_APP_ORIGIN)} });
  Cal.ns.landing("ui", { theme: ${JSON.stringify(theme)} });
  Cal.ns.landing("inline", ${call});
</script></body></html>`;
}

for (const theme of ["light", "dark"] as const) {
  for (const w of WIDTHS) {
    test(`the inline card draws in place, ${theme}, ${w.name}`, async ({ page }) => {
      await page.setViewportSize(w.viewport);
      hostHtml = hostPage(theme, w.column);
      await page.goto(`${HOST}/landing`);

      const card = page.frameLocator("#slot iframe");
      await expect(card.getByText("Connect with your loan advisor:")).toBeVisible({ timeout: 20_000 });
      await expect(card.getByText("Choose a time for your call below:")).toBeVisible();

      // The first bookable day is chosen for the lead, so times show without a click.
      const times = card.getByRole("button", { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i });
      await expect(times.first()).toBeVisible({ timeout: 20_000 });
      const shown = await times.count();
      expect(shown).toBeLessThanOrEqual(6);

      // Three across at a desktop column, two on a phone.
      const tops = await Promise.all(
        Array.from({ length: Math.min(shown, w.across + 1) }, (_, i) => times.nth(i).boundingBox()),
      );
      const firstRow = tops.filter((b) => b && Math.abs(b.y - tops[0]!.y) < 2).length;
      expect(firstRow).toBe(Math.min(shown, w.across));

      // The frame took its height from the card (slate:resize), and the host never
      // scrolls sideways.
      const frameBox = await page.locator("#slot iframe").boundingBox();
      expect(frameBox!.height).toBeGreaterThan(300);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.locator("#slot").screenshot({ path: `e2e/.artifacts/inline-card-${theme}-${w.name}.png` });
      await expectAccessible(page, `the inline card, ${theme}, ${w.name}`);
    });
  }
}

test("picking a time in the card goes on to the details step inside it", async ({ page }) => {
  await page.setViewportSize(WIDTHS[0].viewport);
  hostHtml = hostPage("light", WIDTHS[0].column);
  await page.goto(`${HOST}/landing`);
  const card = page.frameLocator("#slot iframe");
  const times = card.getByRole("button", { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i });
  await times.first().click({ timeout: 20_000 });
  await expect(card.getByRole("textbox", { name: /email/i })).toBeVisible();
  await expect(card.getByRole("button", { name: /confirm/i })).toBeVisible();
  await page.locator("#slot").screenshot({ path: "e2e/.artifacts/inline-card-light-details.png" });

  // The strip is gone on the details step, so Back is the way to another time: it
  // must bring the card's day strip and times back.
  await card.getByRole("button", { name: /back/i }).click();
  await expect(card.getByText("Choose a time for your call below:")).toBeVisible();
  await expect(times.first()).toBeVisible();
});
