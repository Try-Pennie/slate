// The `rate_limits` table and its `rate_limit_hit` RPC, as a test holds them (#3323).
//
// Reproduces the SQL in supabase/migrations/0024_rate_limits.sql rather than a
// simplification of it, because the behaviour a counter test cares about lives in
// exactly the details a simple fake would drop: the window is FIXED from the first
// hit and resets in place once it has passed, the count goes on rising past the
// ceiling, and the answer is `count <= p_max` AFTER the increment. The clock is
// injected (L524), so a test moves time instead of waiting for it.
//
// Shaped as the slice of a supabase-js client the window counters use: `rpc` for
// the hit, and `from("rate_limits").select("count").eq("key", k).maybeSingle()` for
// the read back. Anything else throws, so a counter that starts asking for more is
// noticed rather than answered with nothing.

export interface FakeRateLimits {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, value: string): { maybeSingle(): Promise<{ data: { count: number } | null; error: null }> };
    };
  };
  /** Every row, for an assertion about what was written. */
  rows: Map<string, { windowStart: number; count: number }>;
  /** Move the injected clock forward. */
  advance(ms: number): void;
}

export function fakeRateLimits(startMs = Date.UTC(2026, 9, 21, 1, 57)): FakeRateLimits {
  let now = startMs;
  const rows = new Map<string, { windowStart: number; count: number }>();
  return {
    rows,
    advance(ms: number) {
      now += ms;
    },
    async rpc(name, args) {
      if (name !== "rate_limit_hit") throw new Error(`fakeRateLimits: unexpected rpc ${name}`);
      const key = String(args.p_key);
      const windowMs = Number(args.p_window_seconds) * 1000;
      const max = Number(args.p_max);
      const row = rows.get(key);
      // `window_start < now() - window` resets in place, exactly as the SQL does.
      if (!row || row.windowStart < now - windowMs) {
        rows.set(key, { windowStart: now, count: 1 });
        return { data: 1 <= max, error: null };
      }
      row.count += 1;
      return { data: row.count <= max, error: null };
    },
    from(table) {
      if (table !== "rate_limits") throw new Error(`fakeRateLimits: unexpected table ${table}`);
      return {
        select(cols) {
          if (cols !== "count") throw new Error(`fakeRateLimits: unexpected select ${cols}`);
          return {
            eq(col, value) {
              if (col !== "key") throw new Error(`fakeRateLimits: unexpected filter ${col}`);
              return {
                async maybeSingle() {
                  const row = rows.get(value);
                  return { data: row ? { count: row.count } : null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}
