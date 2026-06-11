import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setMyWorkingHours, useMyDefaultHours } from "@/app/admin/actions";
import { AppHeader } from "@/components/AppHeader";
import { labelCls, inputCls, btnCls, cardCls } from "@/components/ui/styles";
import { Pill } from "@/components/ui/Pill";
import { InfoIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

function minutesToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export default async function MePage() {
  const me = await currentUser();
  if (!me) redirect("/login");

  const db = supabaseAdmin();
  const { data: schedule } = await db
    .from("availability_schedules")
    .select("id, timezone")
    .eq("user_id", me.id)
    .maybeSingle();
  const sched = schedule as { id: string; timezone: string } | null;

  const { data: rulesData } = sched
    ? await db
        .from("availability_rules")
        .select("weekday, start_minute, end_minute")
        .eq("schedule_id", sched.id)
    : { data: [] };
  const rules = (rulesData ?? []) as {
    weekday: number;
    start_minute: number;
    end_minute: number;
  }[];
  const days = new Set(rules.map((r) => r.weekday));
  const start = rules[0]?.start_minute ?? 540;
  const end = rules[0]?.end_minute ?? 1020;

  return (
    <>
    <AppHeader email={me.email} active="me" />
    <main className="mx-auto w-full min-w-0 max-w-xl space-y-6 p-8">
      <div>
        <h1 className="pn-h3">Your availability</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <span>{me.name ?? me.email}</span>
          <Pill variant={me.bookable ? "status-ok" : "outline"}>
            {me.bookable ? "Bookable" : "Not bookable yet"}
          </Pill>
        </p>
      </div>

      {rules.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-pennie-sky-soft p-4 text-sm text-fg dark:bg-accent/15">
          <span className="flex items-center gap-2.5">
            <InfoIcon
              width={20}
              height={20}
              className="shrink-0 text-pennie-blue dark:text-pennie-sky"
            />
            You have no working hours set, so you won&apos;t get bookings.
          </span>
          <form action={useMyDefaultHours}>
            <button className={btnCls}>Use default hours</button>
          </form>
        </div>
      )}

      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">Working hours</h2>
        <p className="mb-4 text-xs text-fg-muted">
          Set your home timezone and weekly hours. Leads always see times in their
          own timezone.
        </p>
        <form action={setMyWorkingHours} className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>Your timezone</label>
            <input
              name="timezone"
              aria-label="Your timezone"
              defaultValue={sched?.timezone ?? "America/New_York"}
              className={`${inputCls} w-48`}
            />
          </div>
          <div className="flex gap-1">
            {[
              [1, "M"],
              [2, "T"],
              [3, "W"],
              [4, "T"],
              [5, "F"],
              [6, "S"],
              [7, "S"],
            ].map(([d, lbl]) => (
              <label
                key={d}
                className="flex flex-col items-center text-xs text-fg-muted"
              >
                {lbl}
                <input
                  type="checkbox"
                  name={`day_${d}`}
                  className="accent-pennie-sky"
                  defaultChecked={
                    rules.length ? days.has(Number(d)) : Number(d) <= 5
                  }
                />
              </label>
            ))}
          </div>
          <div>
            <label className={labelCls}>Start</label>
            <input
              name="start"
              type="time"
              aria-label="Start"
              defaultValue={minutesToTime(start)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>End</label>
            <input
              name="end"
              type="time"
              aria-label="End"
              defaultValue={minutesToTime(end)}
              className={inputCls}
            />
          </div>
          <button className={btnCls}>Save</button>
        </form>
        <form action={useMyDefaultHours} className="mt-3">
          <button className="text-xs text-pennie-blue underline dark:text-pennie-sky">
            Reset to company default hours
          </button>
        </form>
      </section>

      <p className="text-sm text-fg-muted">
        Your manager controls whether you&apos;re bookable and which teams you&apos;re on.
      </p>
    </main>
    </>
  );
}
