// #3251: how `pnpm verify:reroute-live` wires its offline-tested helpers in, read
// from its source. The command itself can only run against production, so its
// decisions live in `reroute-live-check.ts` (pinned by `test-reroute-live-check.ts`)
// and this checks the three places the command must use them:
//
//   1. every reroute confirm goes through ONE helper, `confirmAndNote`, which records
//      the calendar event the confirm left before anything else happens, so no step
//      can confirm and skip the check that it still holds an event;
//   2. `noteEventAfter` fails the step through `rerouteLostEvent`;
//   3. the public test bucket's buffers are checked with `publicBucketWindowProblem`
//      and a problem refuses the run as `testWorldDiffers`.
//
// Comments are stripped first, so a comment naming a call never satisfies the scan
// (L135), and a shape is judged by the structure it forms, never a fixed number of
// lines (L518).

/** The source with every line and block comment removed, strings left alone. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The body of the named function (between its first `{` and the matching `}`), or null. */
export function functionBody(code: string, name: string): string | null {
  const at = code.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at === -1) return null;
  const open = code.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return null;
}

const count = (code: string, needle: string) => code.split(needle).length - 1;

/** Every way the live command's source fails to wire the helpers in, empty when it does. */
export function rerouteLiveWiringProblems(source: string): string[] {
  const code = stripComments(source);
  const problems: string[] = [];

  const confirms = count(code, "adminConfirmReroute(");
  const confirmBody = functionBody(code, "confirmAndNote");
  if (!confirmBody) problems.push("there is no confirmAndNote helper for every confirm to go through");
  else {
    const call = confirmBody.indexOf("adminConfirmReroute(");
    const note = confirmBody.indexOf("noteEventAfter(");
    if (call === -1) problems.push("confirmAndNote does not confirm the reroute");
    if (note === -1 || note < call) problems.push("confirmAndNote does not record the calendar event after the confirm");
  }
  if (confirms !== 1) {
    problems.push(`adminConfirmReroute is called in ${confirms} places; every confirm must go through confirmAndNote alone`);
  }

  const noteBody = functionBody(code, "noteEventAfter");
  if (!noteBody || !/rerouteLostEvent\(/.test(noteBody) || !/differ\(/.test(noteBody)) {
    problems.push("noteEventAfter does not fail the step through rerouteLostEvent");
  }

  const windowCheck = /const\s+(\w+)\s*=\s*publicBucketWindowProblem\(\s*partner\.eventType\s*\)\s*;\s*if\s*\(\s*\1\s*\)\s*exit\(\s*"testWorldDiffers"\s*,\s*\1\s*\)/;
  if (!windowCheck.test(code)) {
    problems.push("the public test bucket's buffers are not checked with publicBucketWindowProblem, refusing as testWorldDiffers");
  }
  return problems;
}
