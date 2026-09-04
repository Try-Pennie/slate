/**
 * A form's values as one comparable string (#1966).
 *
 * The rule this applies is the one the hours forms already got right (#1923,
 * #1873): decide whether there is unsaved work by COMPARING what is on screen
 * against what was saved, never by setting a flag in each change handler. Their
 * own comment says why, and it is the whole reason this is not a flag: "the
 * handler that gets forgotten reads as nothing unsaved precisely when something
 * is."
 *
 * What is shared here is the code that APPLIES that rule, not a projection each
 * form hands in. Sharing the data while copying the logic is not consolidation
 * (L370), and a third hand written projection for this sweep would have been
 * worse than the two that exist.
 *
 * Reading the FORM's own values rather than React state is what makes one
 * mechanism cover every form. Half of them hold their edits in React
 * (`WorkingHoursWeek`, `ReasonOptionsEditor`) and half leave them in the DOM as
 * uncontrolled inputs (`OooForm`, the exceptions editor), and a mechanism built
 * on state would silently cover only the first half while reading as a sweep.
 */

/** Every value in the form, in a stable order, as one string. */
export function formSnapshot(form: HTMLFormElement): string {
  const entries: [string, string][] = [];
  for (const [key, value] of new FormData(form).entries()) {
    // A file cannot be compared by value, so it is compared by what identifies
    // it. Two different files never share all three.
    entries.push([
      key,
      typeof value === "string" ? value : `file:${value.name}:${value.size}:${value.lastModified}`,
    ]);
  }
  // Sorted, because a form whose fields are reordered or conditionally rendered
  // would otherwise read as edited when nothing was typed. Sorted by key AND
  // then by value, so two fields sharing a name (a checkbox group, a repeated
  // `members`) cannot swap places and read as a change.
  entries.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return JSON.stringify(entries);
}
