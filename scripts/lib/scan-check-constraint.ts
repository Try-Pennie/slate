/**
 * Read the allowed values of a named `check (col in (...))` constraint out of the
 * migrations, so a test can hold a TypeScript vocabulary and the database
 * constraint to the same list (#2072).
 *
 * The LATEST definition wins: a later migration that drops and re-adds the
 * constraint to widen it is what the database holds. Null means no migration
 * defines it, which is never read as an empty list, since an empty list would
 * agree with nothing and a caller could mistake that for a parse (L90).
 */
export function latestCheckValues(
  migrations: { file: string; sql: string }[],
  constraint: string,
): string[] | null {
  const re = new RegExp(
    `constraint\\s+${constraint}\\s+check\\s*\\(([\\s\\S]*?)\\)\\s*\\)?\\s*;`,
    "gi",
  );
  let latest: string[] | null = null;
  for (const m of migrations) {
    for (const match of m.sql.matchAll(re)) {
      const inList = /\bin\s*\(([^)]*)/i.exec(match[1] + ")");
      if (!inList) continue;
      latest = [...inList[1].matchAll(/'([^']*)'/g)].map((v) => v[1]);
    }
  }
  return latest;
}
