// Static detector for the #600 guard: a webhook credential rendered back into a
// page. See scripts/test-no-rendered-secrets.ts for the why, the fixtures and
// the positive control that proves this catches the real regression.
//
// #2093 is why the surface list is DERIVED here rather than typed by hand. The
// guard used to scan one hand typed path, `src/app/admin/page.tsx`, which holds
// none of the fields it looks for: every regex matched nothing, the loop passed,
// and the page that really renders the key form
// (`src/app/admin/webhooks/page.tsx`) was never read at all. A hand kept
// registry checks only what the registry lists (L96), and a scan that never read
// its subject and a clean tree produce the same empty result (L98).
//
// So a SURFACE is derived: a non test `.tsx` file under the scanned roots that
// renders a form control AND reads the `webhook_endpoints` table, which is the
// shape of "a form bound to the stored endpoint". The DECLARED surfaces are then
// a floor under the derivation: each one must exist, must be selected by the
// derivation, and must contain at least one of the fields this guard checks, so
// a page that moves, is renamed, or loses the key field fails loudly instead of
// passing silently (L320).
//
// This is a deliberate text scan, not a parser, in keeping with its siblings in
// this directory.

/** The webhook credential fields that must never reach the rendered page. */
export const SECRET_FIELDS = ["auth_header", "secret"] as const;

export type SecretField = (typeof SECRET_FIELDS)[number];

/** One way a secret can reach the page, and where. */
export interface RenderedSecretFinding {
  /** Path relative to the repo root, so a failure names the file to open. */
  file: string;
  line: number;
  field: SecretField;
  /**
   * `bound`: the field feeds an input's `value` / `defaultValue`, so it lands in
   * the server rendered HTML and in the box on screen.
   * `rendered`: the field is interpolated into the markup as text.
   */
  kind: "bound" | "rendered";
  snippet: string;
}

/** File access, injectable so the guard can drive this over an in memory overlay. */
export interface SurfaceIo {
  /** Every file under `root`, as paths relative to the repo root, in any order. */
  listFiles(root: string): string[];
  readFile(path: string): string;
  exists(path: string): boolean;
}

export interface AuditOptions {
  /** Directories to derive surfaces from, relative to the repo root. */
  roots: string[];
  /** Surfaces named out loud: the floor the derivation has to keep clearing. */
  declared: string[];
}

export interface SurfaceAudit {
  /** Every surface scanned: the derived set plus any declared one. */
  surfaces: string[];
  findings: RenderedSecretFinding[];
  /**
   * Reasons the guard cannot vouch for what it just did. A refusal is not a leak;
   * it is the guard saying it could not find its subject, which must never read
   * as success.
   */
  refusals: string[];
}

/** A file this guard could ever have something to say about. */
export function isSurfaceCandidate(path: string): boolean {
  if (!path.endsWith(".tsx")) return false;
  if (path.includes(".test.")) return false;
  return true;
}

/** Does the file render a form control a value could be bound to? */
export function rendersFormControl(src: string): boolean {
  return /<(?:input|textarea|select|Input|Textarea|Select)\b/.test(src);
}

/** Does the file read the stored webhook endpoint? */
export function readsWebhookEndpoints(src: string): boolean {
  return src.includes("webhook_endpoints");
}

/** Which of the guarded fields the file mentions at all. */
export function secretFieldsMentioned(src: string): SecretField[] {
  return SECRET_FIELDS.filter((field) => new RegExp(`\\b${field}\\b`).test(src));
}

/** The surfaces the repo itself says hold a form bound to the webhook endpoint. */
export function deriveSurfaces(io: SurfaceIo, roots: string[]): string[] {
  const found = new Set<string>();
  for (const root of roots) {
    for (const path of io.listFiles(root)) {
      if (!isSurfaceCandidate(path)) continue;
      let src: string;
      try {
        src = io.readFile(path);
      } catch {
        // An unreadable candidate is reported by the declared floor if it matters,
        // and is never silently counted as a clean surface.
        continue;
      }
      if (!rendersFormControl(src)) continue;
      if (!readsWebhookEndpoints(src)) continue;
      found.add(path);
    }
  }
  return [...found].sort();
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function collapse(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
}

/**
 * The two shapes #600 shipped and then removed.
 *
 * A boolean or ternary USE of the field is deliberately fine: that is how the
 * form says "a key is saved" without ever printing it, which is what the page
 * does today.
 */
export function scanRenderedSecrets(file: string, src: string): RenderedSecretFinding[] {
  const findings: RenderedSecretFinding[] = [];
  for (const field of SECRET_FIELDS) {
    // Bound into an input: value={...auth_header...} / defaultValue={...auth_header...}
    // The class spans newlines on purpose, because a formatter routinely breaks a
    // long binding across lines and a line at a time scan would miss exactly that.
    const bound = new RegExp(`(?:default)?[Vv]alue=\\{[^}]*\\b${field}\\b[^}]*\\}`, "g");
    for (const m of src.matchAll(bound)) {
      findings.push({
        file,
        line: lineOf(src, m.index ?? 0),
        field,
        kind: "bound",
        snippet: collapse(m[0]),
      });
    }

    // Interpolated into the markup: {webhook.auth_header} on its own prints it.
    const rendered = new RegExp(`\\{\\s*[A-Za-z_$][\\w$]*[?.]*\\.${field}\\s*\\}`, "g");
    for (const m of src.matchAll(rendered)) {
      findings.push({
        file,
        line: lineOf(src, m.index ?? 0),
        field,
        kind: "rendered",
        snippet: collapse(m[0]),
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** One line per finding, for a failure message somebody has to act on. */
export function describeFindings(findings: RenderedSecretFinding[]): string {
  return findings
    .map((f) => `  ${f.file}:${f.line} ${f.kind} \`${f.field}\`: ${f.snippet}`)
    .join("\n");
}

/**
 * Derive the surfaces, check the declared floor, and scan everything selected.
 *
 * Note which check lands where. "Contains one of the guarded fields" is demanded
 * of the DECLARED surfaces only. A derived surface that reads the endpoint table
 * and renders some unrelated control (a filter box over the delivery log, say) is
 * legitimate and has nothing for this guard to find, and failing it would leave a
 * permanently red check nobody reads by the second week (L36). The declared floor
 * is where the demand belongs, because that is the page whose whole job is the
 * key field.
 */
export function auditRenderedSecrets(io: SurfaceIo, opts: AuditOptions): SurfaceAudit {
  const refusals: string[] = [];
  const derived = deriveSurfaces(io, opts.roots);

  if (derived.length === 0) {
    refusals.push(
      `the derivation selected no surface at all under ${opts.roots.join(", ")}: ` +
        "nothing renders a form bound to webhook_endpoints, so this guard read nothing",
    );
  }

  for (const path of opts.declared) {
    if (!io.exists(path)) {
      refusals.push(`declared surface ${path} does not exist: it moved, and nothing is being scanned in its place`);
      continue;
    }
    if (!derived.includes(path)) {
      refusals.push(
        `declared surface ${path} is not selected by the derivation: it no longer renders a form control, ` +
          "no longer reads webhook_endpoints, or the derivation stopped matching",
      );
    }
    const mentioned = secretFieldsMentioned(io.readFile(path));
    if (mentioned.length === 0) {
      refusals.push(
        `declared surface ${path} contains none of ${SECRET_FIELDS.join(", ")}: ` +
          "every check against it would pass by matching nothing",
      );
    }
  }

  const surfaces = [...new Set([...derived, ...opts.declared])].filter((p) => io.exists(p)).sort();

  const findings: RenderedSecretFinding[] = [];
  for (const path of surfaces) findings.push(...scanRenderedSecrets(path, io.readFile(path)));

  return { surfaces, findings, refusals };
}
