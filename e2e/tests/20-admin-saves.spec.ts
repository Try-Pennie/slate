/**
 * The eleven admin saves #2379 found had never been pressed, pressed (#3100).
 *
 * Each one is driven the way an admin drives it: open the page, change the
 * field, press the button, and confirm where the page asks. Each asserts BOTH
 * halves of the outcome, because either alone has shipped wrong before: the row
 * the database now holds (a refused write once still drew the saved notice), and
 * the sentence the page shows (taken from `SAVE_OUTCOME_COPY`, the one place that
 * wording lives, so the check cannot drift from what ships). Where the save
 * writes an audit entry, that is asserted too, with the value it records.
 */
import type { Page } from "@playwright/test";
import { test, expect, signIn, seed, db, latestAudit } from "../fixtures.ts";
import { SAVE_OUTCOME_COPY } from "@/lib/admin/save-outcomes";
import { LAST_RESORT_REACH, SAVE_LAST_RESORT_REACH } from "@/lib/admin/days-offered-copy";

const REACH_BOX = `${LAST_RESORT_REACH} (1 to 7)`;

/** Picks an option from one of the design system's selects, by pointer, as a person does. */
async function choose(page: Page, combobox: string, option: RegExp): Promise<void> {
  const box = page.getByRole("combobox", { name: combobox });
  const current = (await box.innerText()).trim();
  if (option.test(current)) return;
  await box.click();
  await page.getByRole("option", { name: option }).click();
  await expect(box).toContainText(option);
}

/** Presses a save that goes straight through. */
async function pressAndConfirm(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole("button", { name }).click();
}

/**
 * Presses a control that confirms in place: the first press opens a panel naming
 * the consequence beside a Cancel, and the same verb a second time goes ahead.
 */
async function pressConfirmingInline(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name: "Cancel" }).first()).toBeVisible();
  await page.getByRole("button", { name }).last().click();
}

async function row<T>(table: string, column: string, value: string | number, select = "*"): Promise<T> {
  const { data, error } = await db.from(table).select(select).eq(column, value).maybeSingle();
  if (error) throw new Error(`${table} read failed: ${error.message}`);
  return data as T;
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await signIn(page, seed.users.admin.email);
});

test("stop and start online booking (the kill switch)", async ({ page }) => {
  await page.goto("/admin/business-hours");
  await pressConfirmingInline(page, "Stop online booking");
  await expect(page.getByText(SAVE_OUTCOME_COPY["booking-paused"])).toBeVisible();
  expect((await row<{ public_booking_paused: boolean }>("booking_settings", "id", 1)).public_booking_paused).toBe(true);
  expect((await latestAudit("booking.settings"))?.details).toMatchObject({ public_booking_paused: true });

  // The lever is only worth having if it can be put back.
  await pressAndConfirm(page, "Start online booking");
  await expect(page.getByText(SAVE_OUTCOME_COPY["booking-resumed"])).toBeVisible();
  expect((await row<{ public_booking_paused: boolean }>("booking_settings", "id", 1)).public_booking_paused).toBe(false);
  expect((await latestAudit("booking.settings"))?.details).toMatchObject({ public_booking_paused: false });
});

test("save the last resort reach", async ({ page }) => {
  await page.goto("/admin/business-hours");
  await page.getByRole("spinbutton", { name: REACH_BOX }).fill("5");
  await pressAndConfirm(page, SAVE_LAST_RESORT_REACH);
  await expect(page.getByText(SAVE_OUTCOME_COPY["booking-horizon"])).toBeVisible();
  expect((await row<{ horizon_days: number }>("booking_settings", "id", 1)).horizon_days).toBe(5);
  expect((await latestAudit("booking.settings"))?.details).toMatchObject({ horizon_days: 5 });
  await expect(page.getByRole("spinbutton", { name: REACH_BOX })).toHaveValue("5");

  // Put it back, so the booking spec below sees the seeded week. The notice reads
  // the same for this second save, so it is the stored value that says it landed.
  await page.getByRole("spinbutton", { name: REACH_BOX }).fill("7");
  await pressAndConfirm(page, SAVE_LAST_RESORT_REACH);
  await expect
    .poll(async () => (await row<{ horizon_days: number }>("booking_settings", "id", 1)).horizon_days)
    .toBe(7);
  await page.reload();
  await expect(page.getByRole("spinbutton", { name: REACH_BOX })).toHaveValue("7");
});

test("save a new agent's starting hours", async ({ page }) => {
  await page.goto("/admin/business-hours");
  const section = page.locator("section", {
    has: page.getByRole("heading", { name: "New agent starting hours" }),
  });
  await section.getByRole("textbox", { name: "Timezone" }).fill("America/Chicago");
  // The day toggles are visually hidden checkboxes inside their round labels, so
  // a person presses the label: the first "S" is Saturday.
  const saturday = section.getByRole("checkbox", { name: "S" }).first();
  await expect(saturday).not.toBeChecked();
  await section.locator("label").filter({ has: page.locator('input[name="dday_6"]') }).click();
  await expect(saturday).toBeChecked();
  await pressAndConfirm(page, "Save starting hours");
  await expect(page.getByText(SAVE_OUTCOME_COPY["org-default-hours"])).toBeVisible();
  const org = await row<{ default_timezone: string; default_weekdays: number[] }>("organizations", "id", seed.orgId);
  expect(org.default_timezone).toBe("America/Chicago");
  expect(org.default_weekdays).toContain(6);
});

test("save the alert settings (cooldowns and floors, two writes)", async ({ page }) => {
  await page.goto("/admin/alerts");
  await page.getByRole("spinbutton", { name: "Last 30 minutes" }).fill("4");
  await page.getByRole("spinbutton", { name: "Last 2 hours" }).fill("9");
  await pressAndConfirm(page, "Save alert settings");
  await expect(page.getByText(SAVE_OUTCOME_COPY.alerts)).toBeVisible();
  const config = await row<{ floor_30: number; floor_120: number }>("monitor_alert_config", "id", 1);
  expect(config.floor_30).toBe(4);
  expect(config.floor_120).toBe(9);
  const { count, error } = await db.from("monitor_settings").select("key", { count: "exact", head: true });
  expect(error).toBeNull();
  expect(count, "the cooldown rows were written by the same save").toBeGreaterThan(0);
  expect(await latestAudit("monitor.settings")).not.toBeNull();
});

test("save the direct booking default bucket", async ({ page }) => {
  await page.goto("/admin/buckets");
  await choose(page, "Default bucket", new RegExp(seed.bucketCode));
  await pressAndConfirm(page, "Save default bucket");
  await expect(page.getByText(SAVE_OUTCOME_COPY["bucket-routing"])).toBeVisible();
  expect((await row<{ default_bucket_code: string }>("booking_settings", "id", 1)).default_bucket_code).toBe(
    seed.bucketCode,
  );
  expect((await latestAudit("booking.settings"))?.details).toMatchObject({ default_bucket_code: seed.bucketCode });
});

test("rename a booking reason", async ({ page }) => {
  await page.goto("/admin/booking-reasons");
  await page.getByRole("textbox", { name: "Label" }).first().fill("Schedule clash");
  await pressAndConfirm(page, "Save reasons");
  await expect(page.getByText(SAVE_OUTCOME_COPY["booking-reasons"])).toBeVisible();
  const { data, error } = await db.from("reason_options").select("label").eq("label", "Schedule clash");
  expect(error).toBeNull();
  expect(data?.length).toBe(1);
  expect(await latestAudit("reason.options")).not.toBeNull();
});

test("save a manager's team time off calendar", async ({ page }) => {
  await page.goto(`/admin/agents/${seed.users.manager.id}`);
  await page.getByRole("textbox", { name: "Team time off calendar" }).fill("team-ooo@group.calendar.google.com");
  await pressAndConfirm(page, "Save calendar");
  await expect(page.getByText(SAVE_OUTCOME_COPY["agent-ooo-calendar"])).toBeVisible();
  expect((await row<{ ooo_calendar_id: string }>("users", "id", seed.users.manager.id)).ooo_calendar_id).toBe(
    "team-ooo@group.calendar.google.com",
  );
  expect((await latestAudit("agent.ooo_calendar"))?.details).toMatchObject({
    ooo_calendar_id: "team-ooo@group.calendar.google.com",
  });
});

test("change an agent's role", async ({ page }) => {
  await page.goto(`/admin/agents/${seed.users.roleTarget.id}`);
  // A plain agent has no team, so the team time off calendar is not offered yet.
  await expect(page.getByRole("textbox", { name: "Team time off calendar" })).toHaveCount(0);
  await choose(page, "Role", /^manager$/i);
  await pressAndConfirm(page, "Set role");
  // The select already read "manager" before the press, so it proves nothing.
  // What the save changes on the page is the manager only field appearing.
  await expect(page.getByRole("textbox", { name: "Team time off calendar" })).toBeVisible();
  await expect
    .poll(async () => (await row<{ role: string }>("users", "id", seed.users.roleTarget.id)).role)
    .toBe("manager");
  expect((await latestAudit("role.set"))?.details).toMatchObject({ from: "agent", to: "manager" });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Role" })).toContainText(/manager/i);
});

test("save the webhook endpoint, first creating it and then changing it", async ({ page }) => {
  const endpoint = async () => {
    const { data, error } = await db.from("webhook_endpoints").select("url, format, auth_header").eq("org_id", seed.orgId);
    expect(error).toBeNull();
    return (data ?? []) as { url: string; format: string; auth_header: string | null }[];
  };
  expect(await endpoint(), "the seed has no endpoint, so the first save is the insert path").toEqual([]);

  await page.goto("/admin/webhooks");
  const url = page.getByRole("textbox", { name: "URL", exact: true });
  await url.fill("https://hooks.slate-e2e.invalid/first");
  await choose(page, "Format", /^regal$/i);
  // #3091: the Regal API key and the signing secret are Worker secrets, so the form
  // has no field for either. Changing one is a deploy step.
  await expect(page.getByRole("textbox", { name: "Regal API key" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Signing secret" })).toHaveCount(0);
  await pressAndConfirm(page, /^Save$/);
  await expect(page.getByText(SAVE_OUTCOME_COPY["webhook-endpoint"])).toBeVisible();
  let rows = await endpoint();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ url: "https://hooks.slate-e2e.invalid/first", format: "regal" });

  // What the page shows instead is whether each credential is set, as a marker, judged
  // on the SAVED format. The stack's environment is built from nothing (e2e/env.ts) and
  // the save writes no credential column, so the key the regal format sends is not set
  // anywhere, and the signing secret is one this format does not use.
  const marker = (label: string) =>
    page.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
  await expect(marker("Regal API key")).toHaveText("Not set, deliveries are refused");
  await expect(marker("Signing secret")).toHaveText("Not used by this format");
  expect(rows[0].auth_header ?? "", "the save stores no key").toBe("");

  // The second save is the update path: still one row, now pointing elsewhere.
  await page.getByRole("textbox", { name: "URL", exact: true }).fill(
    "https://hooks.slate-e2e.invalid/second",
  );
  await pressAndConfirm(page, /^Save$/);
  // The notice reads the same for the second save, so the stored row says it landed.
  await expect.poll(async () => (await endpoint()).map((r) => r.url)).toEqual([
    "https://hooks.slate-e2e.invalid/second",
  ]);
  await expect(page.getByText(SAVE_OUTCOME_COPY["webhook-endpoint"])).toBeVisible();
  rows = await endpoint();
  expect(rows[0].auth_header ?? "", "the update path writes no key either").toBe("");
});
