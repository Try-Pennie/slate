/**
 * What every browser spec shares: the local stack, a page that cannot leave this
 * machine, the accessibility judge, and a real sign in.
 */
import { test as base, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createServerClient } from "@supabase/ssr";
import { E2E_APP_ORIGIN, isLoopbackHost, type LocalStack } from "./env.ts";
import { localAdminClient, type Seeded } from "./seed.ts";
import pg from "pg";
import { attachGoogleIdentity } from "./google-identity.ts";

function readJsonEnv<T>(name: string): T {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(
      `${name} is not set. Run the browser checks through \`pnpm test:e2e\`, which starts the local stack and the server first.`,
    );
  }
  return JSON.parse(raw) as T;
}

export const stack = readJsonEnv<LocalStack>("E2E_STACK");
export const seed = readJsonEnv<Seeded>("E2E_SEED");
export const db = localAdminClient(stack);

/** Stops the keyframes that never settle (AGENTS.md, "Screenshotting the dev UI"). */
const FREEZE_MOTION = `
  (() => {
    const apply = () => {
      const s = document.createElement('style');
      s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';
      document.head.appendChild(s);
    };
    if (document.head) apply(); else document.addEventListener('DOMContentLoaded', apply);
  })();
`;

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, provide) => {
    // The browser half of "cannot reach a real system": anything that is not this
    // machine is aborted and recorded, and a recorded request fails the test.
    const leaked: string[] = [];
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "data:" || url.protocol === "blob:" || isLoopbackHost(url.hostname)) {
        return route.continue();
      }
      leaked.push(url.origin + url.pathname);
      return route.abort("blockedbyclient");
    });
    await page.addInitScript(FREEZE_MOTION);
    await provide(page);
    expect(leaked, `the page tried to reach another machine: ${leaked.join(", ")}`).toEqual([]);
  },
});

export { expect };

// --- accessibility -------------------------------------------------------------------

export type AxeFinding = { id: string; impact: string; help: string; targets: string[] };

/** Every serious or critical axe finding on the page as it stands. */
export async function seriousFindings(page: Page): Promise<AxeFinding[]> {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      id: v.id,
      impact: v.impact ?? "unknown",
      help: v.help,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
}

export function describeFindings(label: string, findings: AxeFinding[]): string {
  return [
    `${label}: ${findings.length} serious or critical accessibility finding(s)`,
    ...findings.map((f) => `  [${f.impact}] ${f.id}: ${f.help}\n    ${f.targets.join("\n    ")}`),
  ].join("\n");
}

/** A dark pass that silently rendered light would scan the same page twice. */
export async function expectTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await expect(page.locator(`[data-theme="${theme}"]`).first()).toBeAttached();
}

/** Fails the test on any serious or critical finding, naming each one. */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  const findings = await seriousFindings(page);
  expect(findings, describeFindings(label, findings)).toEqual([]);
}

// --- the booker's days -----------------------------------------------------------------

/** The day chips on the booker's strip, in order. */
export function dayButtons(page: Page) {
  return page.getByRole("group", { name: "Available days" }).getByRole("button");
}

/** The time buttons on the booker's open day ("9:30 am"). */
export function timeButtons(page: Page) {
  return page.getByRole("button", { name: /^\d{1,2}:\d{2}\s?(am|pm)/i });
}

/**
 * Opens the first day on the strip that actually offers a time, and returns it.
 *
 * The strip's FIRST day is not that day at every hour. The booker keeps a day on
 * the strip when every time left on it falls outside the lead's calling window
 * (#2310), so it can say why rather than the day vanishing. With the seeded two
 * hour notice and the window closing at 8 PM, from about 17:30 Eastern today's
 * remaining times are all outside it, and a spec that opened the first chip found
 * no times: the browser leg went red on every PR at 17:12 Eastern on 2026-10-03
 * and stayed red into the evening. The seed opens every day around the clock over
 * a seven day horizon, so a later day always has times and this always finds one.
 *
 * Each chip is judged once React has drawn it as chosen (`aria-pressed`), which is
 * the same commit that draws its times, so there is no fixed wait (L290). Finding
 * no day with times fails, naming each day tried.
 */
export async function openDayWithTimes(page: Page): Promise<string> {
  const days = dayButtons(page);
  await expect(days.first()).toBeVisible();
  const tried: string[] = [];
  for (let i = 0; i < (await days.count()); i++) {
    const day = days.nth(i);
    const label = (await day.innerText()).replace(/\s+/g, " ").trim();
    await day.click();
    await expect(day).toHaveAttribute("aria-pressed", "true");
    if ((await timeButtons(page).count()) > 0) {
      await expect(timeButtons(page).first()).toBeVisible();
      return label;
    }
    tried.push(label);
  }
  throw new Error(`no day on the booker's strip offered a time; tried ${tried.join(", ")}`);
}

// --- signing in ------------------------------------------------------------------------

type Jar = { name: string; value: string }[];

async function latestMagicLink(email: string, notBefore: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${stack.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=5`,
    );
    if (res.ok) {
      const body = (await res.json()) as { messages?: { ID: string; Created: string }[] };
      const fresh = (body.messages ?? []).find((m) => Date.parse(m.Created) >= notBefore - 1000);
      if (fresh) {
        const msg = (await (await fetch(`${stack.mailpitUrl}/api/v1/message/${fresh.ID}`)).json()) as {
          Text?: string;
          HTML?: string;
        };
        const text = `${msg.Text ?? ""}\n${msg.HTML ?? ""}`.replace(/&amp;/g, "&");
        const link = text.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/)?.[0];
        if (link) return link;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no magic link reached Mailpit for ${email} within 20s`);
}

/**
 * Signs `email` in through the REAL callback, the way a person's browser does.
 *
 * Production signs in with Google, which a local run cannot reach, so the code the
 * callback exchanges is minted by the local auth server's magic link instead. Both
 * are PKCE: the verifier cookie is written by `@supabase/ssr` itself (here, into a
 * jar handed to the browser), and the code arrives on `/api/auth/callback?code=`,
 * so the exchange, the domain gate, provisioning and the role based landing all run
 * as they do for a real sign in. Returns where the callback sent the browser.
 */
export async function signIn(page: Page, email: string): Promise<URL> {
  const jar: Jar = [];
  const client = createServerClient(stack.apiUrl, stack.publishableKey, {
    cookies: {
      getAll: () => jar,
      setAll: (toSet) => {
        for (const c of toSet) {
          const i = jar.findIndex((j) => j.name === c.name);
          if (i >= 0) jar.splice(i, 1);
          if (c.value) jar.push({ name: c.name, value: c.value });
        }
      },
    },
  });
  // The auth server sends one link per address per second (`max_frequency`), and
  // consecutive tests sign the same admin in faster than that. Only THAT refusal is
  // waited out, a bounded number of times; any other refusal fails at once (L527).
  let asked = Date.now();
  for (let attempt = 1; ; attempt++) {
    asked = Date.now();
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${E2E_APP_ORIGIN}/api/auth/callback`, shouldCreateUser: true },
    });
    if (!error) break;
    const tooSoon = error.status === 429 && /only request this after/i.test(error.message);
    if (!tooSoon || attempt >= 5) {
      throw new Error(`the local auth server refused a magic link for ${email}: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
  const verifier = jar.filter((c) => c.name.includes("code-verifier"));
  if (verifier.length === 0) throw new Error("no PKCE verifier cookie was written, so the callback could not exchange");
  await page.context().addCookies(verifier.map((c) => ({ ...c, url: E2E_APP_ORIGIN })));

  // #3526: the link made an auth user with only an email identity, and Slate refuses
  // a session holding no Google identity. Give it the one Google identity a real
  // sign in would carry, before the callback reads it (`e2e/google-identity.ts`).
  // The outsider spec is refused by the domain gate before this matters.
  const pgClient = new pg.Client({ connectionString: stack.dbUrl });
  await pgClient.connect();
  try {
    await attachGoogleIdentity((sql, params) => pgClient.query(sql, params), email);
  } finally {
    await pgClient.end();
  }

  const link = await latestMagicLink(email, asked);
  await page.goto(link);
  await page.waitForLoadState("domcontentloaded");
  return new URL(page.url());
}

/** The staff theme comes from the account row; set it before a page loads. */
export async function setStaffTheme(userId: string, theme: "light" | "dark"): Promise<void> {
  const { error } = await db.from("users").update({ theme_preference: theme }).eq("id", userId);
  if (error) throw new Error(`could not set the theme: ${error.message}`);
}

/** The newest audit entry for an action, for asserting a save's trail. */
export async function latestAudit(action: string): Promise<{ details: unknown; actor_id: string } | null> {
  const { data, error } = await db
    .from("audit_log")
    .select("details, actor_id, created_at")
    .eq("action", action)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`audit read failed: ${error.message}`);
  return data as { details: unknown; actor_id: string } | null;
}
