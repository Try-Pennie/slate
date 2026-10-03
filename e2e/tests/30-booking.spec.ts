/**
 * The booking flow, clicked through before merge (#3100).
 *
 * Until this suite the only end to end proof that a lead can book ran against
 * PRODUCTION after the merge (the canary), which is where a broken booker is
 * found by leads first. This drives the same flow on the local build: open the
 * booker on a routing code, pick a day and a time, give contact details, confirm,
 * and land on the success screen; then open the manage page the booking's own
 * token addresses. Google answers from the load test stub, so verify on book and
 * the invite run their real code paths against synthetic calendars.
 */
import {
  test,
  expect,
  seed,
  db,
  expectAccessible,
  expectTheme,
  openDayWithTimes,
  timeButtons,
} from "../fixtures.ts";

const LEAD = {
  name: "Jordan Lead",
  email: "jordan.lead@example.com",
  phone: "(212) 555-0142",
};

test.describe.configure({ mode: "serial" });

let manageToken = "";

test("a lead books a call from the booker", async ({ page }) => {
  await page.goto(`/book?xbc=${seed.bucketCode}`);
  await openDayWithTimes(page);
  await timeButtons(page).first().click();

  await page.getByRole("textbox", { name: /name/i }).first().fill(LEAD.name);
  await page.getByRole("textbox", { name: /email/i }).fill(LEAD.email);
  await page.getByRole("textbox", { name: /phone/i }).fill(LEAD.phone);
  await page.getByRole("button", { name: /confirm|book/i }).last().click();

  await expect(page.getByRole("heading", { name: /booked|confirmed|all set|see you/i })).toBeVisible({
    timeout: 20_000,
  });

  const { data, error } = await db
    .from("bookings")
    .select("id, status, assigned_user_id, bucket_id, attendee_email, manage_token")
    .eq("attendee_email", LEAD.email)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  expect(error).toBeNull();
  expect(data).toMatchObject({
    assigned_user_id: seed.users.agent.id,
    bucket_id: seed.bucketId,
  });
  expect(data?.manage_token).toBeTruthy();
  manageToken = data!.manage_token as string;
});

test("the manage page opens the booking the lead holds", async ({ page }) => {
  expect(manageToken, "the booking above produced a manage token").toBeTruthy();
  await page.goto(`/booking/manage/${manageToken}`);
  await expect(page.getByText(seed.users.agent.name.split(" ")[0]).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /reschedule/i }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /cancel/i }).first()).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`the manage page has no serious accessibility findings (${theme})`, async ({ page }) => {
    expect(manageToken).toBeTruthy();
    await page.goto(`/booking/manage/${manageToken}${theme === "dark" ? "?theme=dark" : ""}`);
    await page.waitForLoadState("load");
    await expectTheme(page, theme);
    await expectAccessible(page, `manage page, ${theme}`);
  });
}
