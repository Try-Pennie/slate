// #2718: no form in the app lets the browser put back what somebody changed and
// did not save.
//
// On 2026-09-25 Dan ticked the Regal calls alarm on /admin/alerts, refreshed,
// saw it still ticked and reported it armed, while the stored value was null and
// no settings save had been recorded for a week. The page drew the box with
// `defaultChecked` from the stored value, and the browser restored the tick he
// had made on top of it, so an unsaved edit read as the stored truth on the very
// refresh he did to check (L732).
//
// The fix lives in `SaveForm`, which renders `autoComplete="off"` after the props
// it spreads, so no call site can omit it or pass its way back (L621). This is
// the other half: a form that does NOT go through the wrapper must carry the same
// attribute itself, or say why in a `form-restore-ok:` comment directly above it.
// A form nobody has seen yet is judged by construction, since the scan walks every
// `<form` in the app rather than a list of the ones known today (L96).
//
// Run: node --experimental-strip-types scripts/test-form-restoration.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";
import {
  formTags,
  formTagVerdict,
  restoreOffWinsOverSpread,
} from "./lib/scan-form-restoration.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const files = [...walk("src/components"), ...walk("src/app")];
assert(files.length > 40, `the scanner found the app to judge (${files.length} files)`);

// --- every form in the app ---------------------------------------------------
{
  const offenders: string[] = [];
  let seen = 0;
  let optedOut = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const t of formTags(src)) {
      seen++;
      const v = formTagVerdict(src, t);
      if (v === "opted-out") optedOut++;
      if (v === null) offenders.push(`${f}:${t.line}`);
    }
  }
  assert(
    offenders.length === 0,
    `a form lets the browser restore unsaved edits over the stored values on a reload. ` +
      `Use <SaveForm>, put autoComplete="off" on the <form>, or say why with a ` +
      `form-restore-ok: comment directly above it:\n    ${offenders.join("\n    ")}`,
  );
  // A scan that found no forms reads exactly like a clean tree (L98).
  assert(seen > 8, `the scan found forms to judge (${seen})`);
  // The escape hatch is for the lead facing forms that exist only after a click.
  // More than a handful means it has become the default rather than the exception.
  assert(optedOut <= 4, `the opt out stays rare (${optedOut} forms use it)`);
}

// --- the wrapper itself --------------------------------------------------------
{
  const src = readFileSync(join("src", "components", "ui", "SaveForm.tsx"), "utf8");
  const rendered = formTags(src).filter((t) => /ref=\{formRef\}/.test(t.tag));
  assert(rendered.length === 1, "SaveForm renders one <form> of its own");
  assert(
    rendered.length === 1 && restoreOffWinsOverSpread(rendered[0]!.tag),
    "and it turns restoration off AFTER the props it spreads, so no call site can turn it back on",
  );
  assert(
    /Omit<React\.FormHTMLAttributes<HTMLFormElement>,[^>]*"autoComplete"/.test(src),
    "and its props do not accept autoComplete at all, so tsc refuses a call site passing one",
  );
}

// --- positive controls on the detector -----------------------------------------
{
  const bare = `x\n      <form action={save} className="y">\n`;
  const [t] = formTags(bare);
  assert(t !== undefined && formTagVerdict(bare, t) === null, "a bare form is caught");

  const off = `<form\n  action={save}\n  autoComplete="off"\n  onSubmit={(e) => { e.preventDefault(); }}\n>`;
  assert(formTagVerdict(off, formTags(off)[0]!) === "restore-off", "a form carrying autoComplete off passes");

  // The arrow's `>` must not end the tag early, or an attribute after it is lost.
  const late = `<form onSubmit={(e) => go(e)} autoComplete="off">`;
  assert(formTagVerdict(late, formTags(late)[0]!) === "restore-off", "an attribute after an arrow is still read");

  const optedJsx = `{/* form-restore-ok: exists only after a click, so\n    nothing is on screen for a reload to restore. */}\n<form onSubmit={x}>`;
  assert(formTagVerdict(optedJsx, formTags(optedJsx)[0]!) === "opted-out", "a JSX comment opt out with a reason passes");

  const optedLine = `// form-restore-ok: renders nothing stored\n<form onSubmit={x}>`;
  assert(formTagVerdict(optedLine, formTags(optedLine)[0]!) === "opted-out", "a line comment opt out passes");

  const noReason = `{/* form-restore-ok: */}\n<form onSubmit={x}>`;
  assert(formTagVerdict(noReason, formTags(noReason)[0]!) === null, "an opt out with no reason is refused (L675)");

  const far = `// form-restore-ok: about something else\nconst a = 1;\n<form onSubmit={x}>`;
  assert(formTagVerdict(far, formTags(far)[0]!) === null, "an opt out that is not directly above does not count");

  const prose = ` * Must live inside the \`<form>\`; a plain \`<form action={x}>\` is not this.\n// see <form>\n`;
  assert(formTags(prose).length === 0, "a form named in a comment is not judged as a form");

  assert(!restoreOffWinsOverSpread(`<form autoComplete="off" {...rest}>`), "restoration off BEFORE the spread is caught");
  assert(restoreOffWinsOverSpread(`<form {...rest} autoComplete="off">`), "and after it passes");
}

finish();
