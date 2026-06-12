/**
 * Mon..Sun day picker as round sky-fill toggle chips (replacing cramped native
 * checkboxes). Real checkboxes are kept (sr-only) so it still posts as
 * `${namePrefix}1..7` to the form. Weekday convention is Luxon's (1=Mon..7=Sun).
 */
const DAYS: [number, string][] = [
  [1, "M"],
  [2, "T"],
  [3, "W"],
  [4, "T"],
  [5, "F"],
  [6, "S"],
  [7, "S"],
];

export function DayToggles({
  namePrefix,
  isOn,
}: {
  namePrefix: string;
  isOn: (weekday: number) => boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {DAYS.map(([d, lbl], i) => (
        <label key={i} className="cursor-pointer">
          <input
            type="checkbox"
            name={`${namePrefix}${d}`}
            defaultChecked={isOn(d)}
            className="peer sr-only"
          />
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-border text-sm font-semibold text-fg-muted transition-colors peer-checked:border-transparent peer-checked:bg-pennie-sky peer-checked:text-pennie-graphite peer-hover:border-fg/40 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus-ring)]">
            {lbl}
          </span>
        </label>
      ))}
    </div>
  );
}
