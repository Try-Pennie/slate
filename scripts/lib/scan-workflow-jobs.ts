// Reads the jobs out of a GitHub Actions workflow file (#1597).
//
// Line based rather than a YAML parse: this repo has no yaml package as a direct
// dependency, and every job key sits at the same two space indent as the lines
// inside its neighbours, so a regex block match runs to the end of the file and
// hands back every job at once. That bug is easy to write and passes, because a
// guard reading one giant block still finds whatever it is looking for SOMEWHERE
// in the file (L135).

export type WorkflowJob = {
  /** The job's key, as `needs:` and the checks API see it. */
  name: string;
  /** Every line inside the job, excluding its key line. */
  body: string;
  /** The job's `timeout-minutes`, or null when it does not set one. */
  timeoutMinutes: number | null;
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
