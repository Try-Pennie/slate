// Which scripts a workflow runs on BARE node, with no module alias hook (#1598).
//
// A workflow step written as
//
//   node --experimental-strip-types scripts/check-main-push.ts
//
// has no `--import ./scripts/register-paths.mjs` and, in the workflows that matter
// here, no `pnpm install` either: it runs against a plain checkout. Such a script
// must resolve every import from local files and node builtins alone, or it throws
// on load in the one situation it exists for.
//
// This enumerates those invocations FROM the workflow files rather than from a hand
// written list, so a newly added dependency free script is covered by construction
// instead of being exempt from the guard meant to catch it (L96).
//
// Comment lines are dropped first: a `#` line describing an invocation is not one.

export interface WorkflowNodeScript {
  /** Repo relative path, e.g. `scripts/check-main-push.ts`. */
  script: string;
  /** Whether the invocation carries the `@/` alias hook (register-paths). */
  aliasHook: boolean;
}

/** Strip whole line YAML/shell comments, keeping the rest byte for byte. */
export function stripYamlComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * Every `node ... scripts/<name>.ts` invocation in one workflow file.
 *
 * The invocation is read from `node` up to the script path, so the flags in between
 * are what decides `aliasHook`. A line continuation is handled because the match is
 * not anchored to a single line; a match may not cross a `node` of its own.
 */
export function workflowNodeScripts(yaml: string): WorkflowNodeScript[] {
  const code = stripYamlComments(yaml);
  const out: WorkflowNodeScript[] = [];
  const re = /\bnode\s+((?:(?!\bnode\b)[^\n])*?)(scripts\/[\w./-]+\.ts)/g;
  for (const m of code.matchAll(re)) {
    const flags = m[1] ?? "";
    const script = m[2] as string;
    out.push({ script, aliasHook: /register-paths/.test(flags) });
  }
  return out;
}

/**
 * The scripts run on bare node across a set of workflow files, deduplicated and
 * sorted. A script run BOTH ways (with the hook somewhere, without it elsewhere)
 * still counts as bare: the bare invocation is the one that has to work.
 */
export function bareNodeScripts(files: { name: string; yaml: string }[]): string[] {
  const bare = new Set<string>();
  for (const f of files) {
    for (const inv of workflowNodeScripts(f.yaml)) {
      if (!inv.aliasHook) bare.add(inv.script);
    }
  }
  return [...bare].sort();
}
