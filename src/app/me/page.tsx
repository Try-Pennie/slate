import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { setMyWorkingHours, useMyDefaultHours } from "@/app/admin/actions";

export const dynamic = "force-dynamic";

const labelCls = "block text-xs font-medium text-neutral-500";
const inputCls =
  "mt-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm";
const btnCls =
  "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800";

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
    <main className="mx-auto max-w-xl space-y-6 p-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Your availability</h1>
        <p className="text-sm text-neutral-500">
          {me.name ?? me.email} ·{" "}
          <span className={me.bookable ? "text-green-600" : "text-neutral-400"}>
            {me.bookable ? "Bookable" : "Not bookable yet"}
          </span>
        </p>
      </header>

      {rules.length === 0 && (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          <span>You have no working hours set — you won&apos;t get bookings.</span>
          <form action={useMyDefaultHours}>
            <button className={btnCls}>Use default hours</button>
          </form>
        </div>
      )}

      <section className="rounded-lg border border-neutral-200 p-5">
        <h2 className="mb-1 text-sm font-semibold">Working hours</h2>
        <p className="mb-4 text-xs text-neutral-500">
          Set your home timezone and weekly hours. Leads always see times in their
          own timezone.
        </p>
        <form action={setMyWorkingHours} className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>Your timezone</label>
            <input
              name="timezone"
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
                className="flex flex-col items-center text-[10px] text-neutral-500"
              >
                {lbl}
                <input
                  type="checkbox"
                  name={`day_${d}`}
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
              defaultValue={minutesToTime(start)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>End</label>
            <input
              name="end"
              type="time"
              defaultValue={minutesToTime(end)}
              className={inputCls}
            />
          </div>
          <button className={btnCls}>Save</button>
        </form>
        <form action={useMyDefaultHours} className="mt-3">
          <button className="text-xs text-neutral-500 underline">
            Reset to company default hours
          </button>
        </form>
      </section>

      <p className="text-xs text-neutral-400">
        Your manager controls whether you&apos;re bookable and which teams you&apos;re on.
      </p>
    </main>
  );
}
