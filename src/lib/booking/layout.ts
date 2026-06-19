export type BookerLayout = "strip" | "month";
/** Safe coercion: only the exact string "month" selects the month grid; anything
 *  else (null/legacy/garbage) falls back to the strip default. */
export function normalizeBookerLayout(value: unknown): BookerLayout {
  return value === "month" ? "month" : "strip";
}
