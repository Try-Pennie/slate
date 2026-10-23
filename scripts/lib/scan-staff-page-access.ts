/**
 * Does every staff page refuse a signed out request before it reads anything? (#3692)
 *
 * Lesson L1026: an access check in a shared layout does not protect the pages under
 * it, because the framework renders a layout and its page at the same time and may
 * not re-run the layout on navigation. Slate's two staff layouts make no access
 * decision on purpose, so each page carries its own. This finds the page that does
 * not, read by the TypeScript compiler rather than by pattern, so a gate is judged
 * by WHERE it sits in the page's own body and not by whether the words appear in
 * the file.
 *
 * A page passes when, walking its default export's statements in order, it reaches
 * one of these before any other `await` and before any `return`:
 *
 *   * `await requireRole(...)`, `requireAdmin`, `requireManager`, `requireSuperAdmin`,
 *     awaited on their own (each throws or redirects for a signed out request);
 *   * `const me = await currentUser()` IMMEDIATELY followed by `if (!me)` that
 *     redirects or calls `notFound()`;
 *   * an unconditional `redirect(...)`, `notFound()` or `throw`: a page that renders
 *     nothing has nothing to protect.
 *
 * Awaiting `params` or `searchParams` before the gate is allowed: those are the
 * request's own address, not a read of anybody's data.
 */
import ts from "typescript";

/** The route trees whose layouts deliberately make no access decision. */
export const STAFF_PAGE_ROOTS = ["src/app/admin", "src/app/me"] as const;

/** Guards that refuse a signed out request themselves. */
export const REQUIRE_GUARDS = ["requireRole", "requireAdmin", "requireManager", "requireSuperAdmin"] as const;

/** Reads of the signed in user that the page must then refuse null from. */
export const USER_READS = ["currentUser", "realCurrentUser"] as const;

/** Calls that end the render without drawing the page. */
const ENDS_RENDER = ["redirect", "notFound", "permanentRedirect"];

/** The request's own address, which a page may await before its gate. */
const ADDRESS_PROPS = ["params", "searchParams"];

export interface PageSource {
  /** Repo relative path, used in the failure message. */
  path: string;
  text: string;
}

export interface UnguardedPage {
  path: string;
  /** What is wrong, in a sentence that says where to look. */
  problem: string;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Every `await` inside `node`, not descending into nested functions. */
function awaitsIn(node: ts.Node): ts.AwaitExpression[] {
  const out: ts.AwaitExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n) && n !== node) return;
    if (ts.isAwaitExpression(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function isAddressRead(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return ADDRESS_PROPS.includes(expr.text);
  if (ts.isPropertyAccessExpression(expr)) return ADDRESS_PROPS.includes(expr.name.text);
  return false;
}

/** The single awaited call this statement makes, when it makes exactly one and nothing else is awaited. */
function soleAwaitedCall(stmt: ts.Statement): ts.CallExpression | null {
  const awaits = awaitsIn(stmt);
  if (awaits.length !== 1) return null;
  const operand = awaits[0]!.expression;
  return ts.isCallExpression(operand) ? operand : null;
}

/** `const <name> = await currentUser()`, returning the bound name. */
function userReadBinding(stmt: ts.Statement): string | null {
  if (!ts.isVariableStatement(stmt)) return null;
  const decls = stmt.declarationList.declarations;
  if (decls.length !== 1) return null;
  const decl = decls[0]!;
  if (!ts.isIdentifier(decl.name) || !decl.initializer) return null;
  const init = decl.initializer;
  if (!ts.isAwaitExpression(init) || !ts.isCallExpression(init.expression)) return null;
  const name = calleeName(init.expression);
  return name && (USER_READS as readonly string[]).includes(name) ? decl.name.text : null;
}

/** Whether `stmt` ends the render outright: `redirect(...)`, `notFound()` or `throw`. */
function endsRender(stmt: ts.Statement): boolean {
  if (ts.isThrowStatement(stmt)) return true;
  if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
    const name = calleeName(stmt.expression);
    return name !== null && ENDS_RENDER.includes(name);
  }
  if (ts.isBlock(stmt)) return stmt.statements.some(endsRender);
  if (ts.isReturnStatement(stmt) && stmt.expression && ts.isCallExpression(stmt.expression)) {
    const name = calleeName(stmt.expression);
    return name !== null && ENDS_RENDER.includes(name);
  }
  return false;
}

/** `if (!<name>) redirect(...)` (or `notFound()`, or a block doing either). */
function refusesNull(stmt: ts.Statement | undefined, name: string): boolean {
  if (!stmt || !ts.isIfStatement(stmt)) return false;
  const cond = stmt.expression;
  const negatesName =
    ts.isPrefixUnaryExpression(cond) &&
    cond.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(cond.operand) &&
    cond.operand.text === name;
  return negatesName && endsRender(stmt.thenStatement);
}

function defaultExportBody(file: ts.SourceFile): ts.Block | null {
  for (const stmt of file.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.body) continue;
    const mods = ts.getModifiers(stmt) ?? [];
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (exported && isDefault) return stmt.body;
  }
  return null;
}

/** Why one page is unguarded, or null when it refuses a signed out request in time. */
export function pageAccessProblem(page: PageSource): string | null {
  const file = ts.createSourceFile(page.path, page.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = defaultExportBody(file);
  if (!body) {
    return "its default export is not an `export default function`, so the scan cannot read where it checks access; write it as one";
  }
  const stmts = body.statements;
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]!;
    const text = stmt.getText(file).replace(/\s+/g, " ").slice(0, 80);

    const sole = soleAwaitedCall(stmt);
    const soleName = sole ? calleeName(sole) : null;
    if (soleName && (REQUIRE_GUARDS as readonly string[]).includes(soleName)) return null;

    const user = userReadBinding(stmt);
    if (user) {
      if (refusesNull(stmts[i + 1], user)) return null;
      return `it reads the signed in user (\`${text}\`) but the next line does not refuse a signed out one; add \`if (!${user}) redirect("/login");\``;
    }

    if (endsRender(stmt)) return null;
    if (ts.isReturnStatement(stmt)) {
      return `it renders (\`${text}\`) before checking access`;
    }
    const reads = awaitsIn(stmt).filter((a) => !isAddressRead(a.expression));
    if (reads.length > 0) {
      return `it reads (\`${text}\`) before checking access; check the user first`;
    }
  }
  return "it never checks access: the layout above it does not, by design, so this page must";
}

/** Every staff page that does not refuse a signed out request before reading. Empty means the rule holds. */
export function scanStaffPageAccess(pages: PageSource[]): UnguardedPage[] {
  const out: UnguardedPage[] = [];
  for (const page of pages) {
    const problem = pageAccessProblem(page);
    if (problem) out.push({ path: page.path, problem });
  }
  return out;
}
