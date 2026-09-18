// Reads the jobs out of a GitHub Actions workflow file (#1597).
//
// Line based rather than a YAML parse: this repo has no yaml package as a direct
// dependency, and every job key sits at the same two space indent as the lines
// inside its neighbours, so a regex block match runs to the end of the file and
// hands back every job at once. That bug is easy to write and passes, because a
// guard reading one giant block still finds whatever it is looking for SOMEWHERE
// in the file (L135).

import { readTextOptOut } from "./opt-out.ts";

export type WorkflowJob = {
  /** The job's key, as `needs:` and the checks API see it. */
  name: string;
  /** Every line inside the job, excluding its key line. */
  body: string;
  /** The job's `timeout-minutes`, or null when it does not set one. */
  timeoutMinutes: number | null;
  /** The job keys this job waits on, from its own `needs:`. */
  needs: string[];
  /** Every shell command the job's steps run, inline and block scalar alike. */
  runs: string[];
};

/** The job keys in a workflow, in file order. */
export function parseWorkflowJobs(source: string): WorkflowJob[] {
  const lines = source.split("\n");
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt < 0) return [];

  const isJobKey = (l: string) => /^ {2}[\w-]+:\s*$/.test(l);
  const starts: number[] = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    // A top-level key (no indent, not a comment or blank) ends the jobs block.
    if (/^[^\s#]/.test(lines[i])) break;
    if (isJobKey(lines[i])) starts.push(i);
  }

  return starts.map((start, idx) => {
    const nextStart = starts[idx + 1] ?? lines.length;
    const body = lines.slice(start + 1, nextStart).join("\n");
    return {
      name: lines[start].trim().replace(/:$/, ""),
      body,
      timeoutMinutes: readTimeoutMinutes(body),
      needs: readNeeds(body),
      runs: readRunCommands(body),
    };
  });
}

/**
 * A job's own `timeout-minutes`, at the job's four space indent. A STEP's
 * timeout-minutes sits deeper and must not answer for the job's: a job whose one
 * slow step is bounded still hangs for six hours on anything else it does.
 */
export function readTimeoutMinutes(jobBody: string): number | null {
  // A trailing `# ...` comment is allowed: each of these carries the measured
  // duration it was set from, and a parser that rejected that would report every
  // annotated job as having no timeout at all.
  const m = jobBody.match(/^ {4}timeout-minutes:\s*(\d+)\s*(?:#.*)?$/m);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * The job keys one job waits on, read from its own `needs:` at the job's four
 * space indent. Both spellings GitHub accepts are handled, the flow list
 * (`needs: [a, b]`) and the block list (`needs:` then `- a`), because a guard
 * that reads only one of them reports a job as depending on nothing, which is
 * the permissive answer to every question asked of a dependency graph.
 */
export function readNeeds(jobBody: string): string[] {
  const lines = jobBody.split("\n");
  const at = lines.findIndex((l) => /^ {4}needs:/.test(l));
  if (at < 0) return [];
  const inline = lines[at].replace(/^ {4}needs:\s*/, "").replace(/#.*$/, "").trim();
  if (inline.length > 0) {
    return [...inline.matchAll(/[\w-]+/g)].map((m) => m[0]);
  }
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || line.trim().length === 0) continue;
    const item = line.match(/^ {6}-\s*([\w-]+)\s*$/);
    if (!item) break;
    out.push(item[1] as string);
  }
  return out;
}

/**
 * Every shell command the job's steps run. An inline `run: pnpm x` gives one
 * entry; a block scalar (`run: |`) gives every line beneath it, so a command
 * buried on line four of a script block is still visible.
 *
 * Whole line comments are dropped first: a `#` line NAMING a command is not one
 * being run, and several jobs here explain in comments what they deliberately do
 * not do.
 */
export function readRunCommands(jobBody: string): string[] {
  const lines = jobBody.split("\n").filter((l) => !/^\s*#/.test(l));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-?\s*run:\s*(.*)$/);
    if (!m) continue;
    const indent = (m[1] as string).length;
    const inline = (m[2] as string).trim();
    if (inline.length > 0 && !/^[|>][-+\d]*$/.test(inline)) {
      out.push(inline);
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim().length === 0) continue;
      const lead = line.length - line.trimStart().length;
      if (lead <= indent) break;
      out.push(line.trim());
      i = j;
    }
  }
  return out;
}

/**
 * The transitive `needs` closure of one job, the job itself included. A cycle
 * cannot hang this (a key already seen is never expanded again), and a `needs`
 * naming a job that does not exist is simply absent from the result rather than
 * throwing: the guard that cares about that asserts it separately.
 */
export function transitiveNeeds(jobs: WorkflowJob[], start: string): Set<string> {
  const byName = new Map(jobs.map((j) => [j.name, j] as const));
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const dep of byName.get(name)?.needs ?? []) queue.push(dep);
  }
  return seen;
}

/**
 * A `# <marker>: <reason>` annotation inside a job, or null. Used for the
 * exemptions a guard has to allow: the reason is part of the match, so an
 * exemption with nothing written after it reads as absent rather than as a
 * decision somebody made (L233).
 */
export function readJobMarker(jobBody: string, marker: string): string | null {
  // A marker with nothing written after it is NOT a decision, which is why this
  // goes through the shared reader rather than a pattern of its own (#2200): a
  // looser one reads the NEXT line as the reason and every empty marker passes.
  const found = readTextOptOut(jobBody, `${marker}:`, { syntax: ["hash"] });
  return found.present && found.reasoned ? found.reason : null;
}

export type WorkflowTriggers = {
  /** The event keys under `on:`, for example `push`, `pull_request`, `schedule`. */
  events: string[];
  /** Every `- cron: "..."` expression under `on: schedule:`. */
  crons: string[];
  /** The workflow NAMES a `workflow_run` trigger watches. */
  watches: string[];
};

/** The `on:` block of a workflow, as its events, crons and watched workflows. */
export function parseWorkflowTriggers(source: string): WorkflowTriggers {
  const lines = source.split("\n");
  const at = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (at < 0) return { events: [], crons: [], watches: [] };

  const block: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) break;
    block.push(lines[i]);
  }
  const code = block.filter((l) => !/^\s*#/.test(l));

  const events = code
    .map((l) => l.match(/^ {2}([\w-]+):/)?.[1])
    .filter((x): x is string => typeof x === "string");

  const crons = code
    .map((l) => l.match(/^\s*-\s*cron:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/)?.[1])
    .filter((x): x is string => typeof x === "string")
    .map((c) => c.trim());

  const watchLine = code.find((l) => /^\s*workflows:/.test(l));
  const watches: string[] = [];
  if (watchLine) {
    const inline = watchLine.replace(/^\s*workflows:\s*/, "").trim();
    if (inline.startsWith("[")) {
      for (const part of inline.replace(/^\[|\]$/g, "").split(",")) {
        const name = part.trim().replace(/^["']|["']$/g, "");
        if (name.length > 0) watches.push(name);
      }
    } else {
      const from = code.indexOf(watchLine);
      for (let i = from + 1; i < code.length; i++) {
        const item = code[i].match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/);
        if (!item) break;
        watches.push((item[1] as string).trim());
      }
    }
  }

  return { events, crons, watches };
}

/**
 * How many times a cron fires in an average month (30.44 days), rounded up.
 *
 * It REFUSES a shape it cannot price rather than guessing, because a guessed
 * number is what turns a budget guard into a reassuring sentence: a cadence this
 * cannot read has to fail the guard that reads it, never be waved through (L98).
 */
export function monthlyRunsFromCron(cron: string): number | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (month !== "*") return null;

  const count = (field: string, max: number): number | null => {
    if (field === "*") return max;
    const step = field.match(/^\*\/(\d+)$/);
    if (step) {
      const n = Number(step[1]);
      return n > 0 ? Math.ceil(max / n) : null;
    }
    if (!/^\d+(,\d+)*$/.test(field)) return null;
    return field.split(",").length;
  };

  const minutes = count(minute, 60);
  const hours = count(hour, 24);
  if (minutes === null || hours === null) return null;
  const perDay = minutes * hours;

  const DAYS_PER_MONTH = 30.44;
  const WEEKS_PER_MONTH = DAYS_PER_MONTH / 7;

  if (dom === "*" && dow === "*") return Math.ceil(perDay * DAYS_PER_MONTH);
  if (dom === "*") {
    const days = count(dow, 7);
    return days === null ? null : Math.ceil(perDay * days * WEEKS_PER_MONTH);
  }
  if (dow === "*") {
    const days = count(dom, 31);
    return days === null ? null : Math.ceil(perDay * days);
  }
  // Both fields set means "either day matches", which needs a calendar to price.
  return null;
}

export type CostPremise = {
  runsPerMonth: number;
  billedMinutesPerRun: number;
  ceilingBilledMinutesPerMonth: number;
};

/**
 * The `# cost-premise: runs-per-month=N billed-minutes-per-run=N
 * ceiling-billed-minutes-per-month=N` line a priced workflow carries.
 *
 * The premise is written as NUMBERS with a re-measure command beside them rather
 * than as a dated sentence, so the next drift is a diff instead of a rediscovery
 * (L316). A field missing or unreadable returns null, which the guard reads as no
 * premise at all rather than as a partly readable one.
 */
export function readCostPremise(source: string): CostPremise | null {
  const line = source.match(/^\s*#\s*cost-premise:\s*(.+)$/m)?.[1];
  if (!line) return null;
  const num = (key: string): number | null => {
    const m = line.match(new RegExp(`\\b${key}=(\\d+)\\b`));
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  const runsPerMonth = num("runs-per-month");
  const billedMinutesPerRun = num("billed-minutes-per-run");
  const ceiling = num("ceiling-billed-minutes-per-month");
  if (runsPerMonth === null || billedMinutesPerRun === null || ceiling === null) return null;
  return { runsPerMonth, billedMinutesPerRun, ceilingBilledMinutesPerMonth: ceiling };
}
