// Offline checks for the read only SQL an operator pastes out of a runbook (#3132,
// #3124), kept here so the runner's `scripts/test-*.ts` glob does not pick it up.
//
// Nothing in CI can run this SQL: there is no database in the offline suite, and
// the queries are for the production database during an incident or a capacity
// review. So the checks below are the things that can be known without one, and
// each is a way such a query has actually been wrong before: a statement that
// writes (pasted into a console holding the secret key, it would run), a column the
// table does not have (#1197 named one and was a silent no-op for weeks), and a
// filter literal that has drifted from the code that writes the rows.

/** The SQL with `--` comments and single-quoted literals blanked, for keyword checks. */
export function sqlCode(sql: string): string {
  return sql
    .split("\n")
    .map((l) => {
      const noStrings = l.replace(/'(?:[^']|'')*'/g, "''");
      const at = noStrings.indexOf("--");
      return at === -1 ? noStrings : noStrings.slice(0, at);
    })
    .join("\n");
}

const WRITES =
  /\b(insert|update|delete|merge|upsert|truncate|drop|alter|create|grant|revoke|copy|call|do|perform|vacuum|analyze|refresh|set|reset|lock|comment|listen|notify|execute)\b/i;

/**
 * Why this SQL is not provably read only, or an empty list when it is. Every
 * statement must open with SELECT or WITH and no write keyword may appear anywhere,
 * which also refuses a data modifying CTE (`with x as (delete ...)`). A function
 * call cannot be judged offline, so the SQL may call only the built ins listed.
 */
export function readOnlyProblems(sql: string, allowedFunctions: readonly string[] = []): string[] {
  const code = sqlCode(sql);
  const problems: string[] = [];
  const statements = code
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length === 0) problems.push("there is no statement at all");
  for (const s of statements) {
    if (!/^(select|with)\b/i.test(s)) {
      problems.push(`a statement does not open with SELECT or WITH: "${s.slice(0, 40)}"`);
    }
  }
  const w = WRITES.exec(code);
  if (w) problems.push(`it contains the write keyword "${w[1]}"`);

  const allowed = new Set(
    ["count", "max", "min", "now", "date_trunc", "round", "nullif", "coalesce", "jsonb_array_length", "interval"]
      .concat(allowedFunctions)
      .map((f) => f.toLowerCase()),
  );
  // `name(` that is not a keyword the grammar uses with a parenthesis.
  const grammar = new Set(["in", "as", "and", "or", "not", "exists", "from", "select", "on", "over", "filter"]);
  for (const m of code.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const name = m[1].toLowerCase();
    if (grammar.has(name) || allowed.has(name)) continue;
    problems.push(`it calls "${name}", which cannot be judged read only offline`);
  }
  return problems;
}

/** Whether `column` appears as a whole word in the SQL's code (not its comments). */
export function namesColumn(sql: string, column: string): boolean {
  return new RegExp(`\\b${column}\\b`).test(sqlCode(sql));
}
