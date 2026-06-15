"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { normalizeTzLabel } from "@/lib/ooo/core";
import { roundDownToQuarterHour } from "@/lib/date/parse";
import { cancelOoo, modifyOoo, submitOoo } from "@/lib/ooo/service";
import type { SubmitOooInput } from "@/lib/ooo/service";

/**
 * Agent self-service time off actions. Void server actions have no return
 * channel, so outcomes travel back as /me?ooo=<ok message>&ooo_error=<error>
 * and the page renders the banner.
 */

function done(message: string): never {
  revalidatePath("/me");
  redirect(`/me?ooo=${encodeURIComponent(message)}#time-off`);
}

function failed(error: string): never {
  redirect(`/me?ooo_error=${encodeURIComponent(error)}#time-off`);
}

/** Builds the UTC window + display tz from the form's local date/time fields. */
function windowFrom(form: FormData): SubmitOooInput | { error: string } {
  const tz = String(form.get("timezone") ?? "America/New_York");
  const allDay = form.get("all_day") === "on";
  const startDate = String(form.get("start_date") ?? "");
  const endDate = String(form.get("end_date") ?? "");
  if (!startDate || !endDate) {
    return { error: "Pick a start and end date for your time off." };
  }
  // Times snap down to a quarter hour (matches the picker; safety net if the
  // client value slips through off-grid). All-day uses the full day as-is.
  const startTime = allDay
    ? "00:00"
    : roundDownToQuarterHour(String(form.get("start_time") ?? ""));
  const endTime = allDay
    ? "23:59"
    : roundDownToQuarterHour(String(form.get("end_time") ?? ""));
  if (!startTime || !endTime) {
    return { error: "Pick start and end times, or choose all day." };
  }
  const start = DateTime.fromISO(`${startDate}T${startTime}`, { zone: tz });
  const end = DateTime.fromISO(`${endDate}T${endTime}`, { zone: tz });
  if (!start.isValid || !end.isValid) {
    return { error: "Those dates could not be read. Please pick them again." };
  }
  return {
    startIso: start.toUTC().toISO()!,
    endIso: end.toUTC().toISO()!,
    displayTzId: tz,
    displayTzLabel: normalizeTzLabel(tz),
    reason: String(form.get("reason") ?? ""),
    notes: String(form.get("notes") ?? "") || undefined,
  };
}

export async function submitMyOoo(form: FormData): Promise<void> {
  const me = await currentUser();
  if (!me) redirect("/login");
  const input = windowFrom(form);
  if ("error" in input) failed(input.error);
  const result = await submitOoo(me, input);
  if (!result.ok) failed(result.error);
  done("Your time off request was sent to your manager.");
}

export async function modifyMyOoo(form: FormData): Promise<void> {
  const me = await currentUser();
  if (!me) redirect("/login");
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) failed("That request could not be found.");
  const input = windowFrom(form);
  if ("error" in input) failed(input.error);
  const result = await modifyOoo(requestId, me, input);
  if (!result.ok) failed(result.error);
  done("Your changes were sent to your manager.");
}

export async function cancelMyOoo(form: FormData): Promise<void> {
  const me = await currentUser();
  if (!me) redirect("/login");
  const requestId = String(form.get("request_id") ?? "");
  if (!requestId) failed("That request could not be found.");
  const result = await cancelOoo(requestId, me);
  if (!result.ok) failed(result.error);
  done("Your time off request was cancelled.");
}
