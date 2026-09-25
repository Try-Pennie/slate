import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The console gate runs BEFORE every role check, on every console route (#2699).
 *
 * With `AGENT_SCHEDULING_LIVE` off, everybody below super admin is sent to
 * `/admin/ooo` from any console route. Eight routes checked the role first, so a
 * manager opening `/admin/buckets` was told "You need an admin account to open
 * this page" instead: a refusal naming a rule that is not the one holding them
 * out, on a page every other route would have moved them away from.
 *
 * The routes are ENUMERATED from the route tree (`import.meta.glob`), never from a
 * list, so a route added tomorrow is walked by construction rather than exempt
 * from the check written to catch it (L96). Each is rendered for real, with the
 * REAL `consoleHiddenFor` and the real role predicates; only who is signed in, the
 * navigation calls and the database are faked. The database fake throws on any
 * read, so a route that reaches its data before its gate fails here by name.
 */

const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const nav = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({
  redirect: nav.redirect,
  notFound: nav.notFound,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      throw new Error(`read "${table}" before the console gate`);
    },
    rpc: (fn: string) => {
      throw new Error(`called "${fn}" before the console gate`);
    },
  }),
}));

type PageModule = { default: (props: unknown) => unknown };

// Vite's glob, typed locally: the app's tsconfig does not load `vite/client`, and
// pulling it in for one file would put Vite's globals into every program.
const pages = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<PageModule>>;
  }
).glob("./**/page.tsx");

/**
 * Routes that are not console screens gated by the flag, each with the REASON.
 * Every entry is asserted to still exist, so a stale one fails rather than
 * silently exempting whatever takes its name next.
 */
const NOT_GATED: Record<string, string> = {
  "./ooo/page.tsx": "the destination of the gate: it is the one page the held out roles keep",
  "./settings/page.tsx": "only redirects, to /admin, which carries the gate",
  "./default-hours/page.tsx": "only redirects, to /admin/business-hours, which carries the gate",
  "./boundary-probe/page.tsx": "throws on purpose so the error boundary can be seen; 404s outside development",
};

const HELD_OUT = ["agent", "manager", "team_lead", "admin"] as const;

const props = {
  params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
  searchParams: Promise.resolve({}),
};

function viewer(role: string) {
  return {
    id: "u1",
    role,
    org_id: "o1",
    email: `${role}@x.co`,
    name: role,
    theme_preference: null,
    bookable: false,
    avatar_url: null,
  };
}

/** What the route did: the redirect target, or "rendered" when it returned markup. */
async function outcome(path: string, role: string): Promise<string> {
  auth.currentUser.mockResolvedValue(viewer(role));
  const mod = await pages[path]!();
  try {
    await mod.default(props);
    return "rendered";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = /^NEXT_REDIRECT:(.*)$/.exec(msg);
    return m ? `redirect:${m[1]}` : `threw:${msg}`;
  }
}

const saved = process.env.AGENT_SCHEDULING_LIVE;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_SCHEDULING_LIVE;
  else process.env.AGENT_SCHEDULING_LIVE = saved;
});

const gated = Object.keys(pages)
  .filter((p) => !(p in NOT_GATED))
  .sort();

describe("console gate ordering (#2699)", () => {
  it("found the console routes in the route tree", () => {
    // An empty walk passes every assertion below, so the count is asserted first
    // (L98). There were 20 gated console routes when this was written.
    expect(gated.length).toBeGreaterThanOrEqual(20);
    expect(gated).toContain("./buckets/page.tsx");
    expect(gated).toContain("./page.tsx");
  });

  it("names only exemptions that still exist", () => {
    for (const path of Object.keys(NOT_GATED)) expect(Object.keys(pages)).toContain(path);
  });

  describe.each(gated)("%s", (path) => {
    it.each(HELD_OUT)(
      "sends %s to /admin/ooo while the console is hidden",
      async (role) => {
        delete process.env.AGENT_SCHEDULING_LIVE;
        expect(await outcome(path, role)).toBe("redirect:/admin/ooo");
      },
    );
  });

  // CONTROL: the walk above must be able to see a route that does NOT redirect,
  // or it would pass on a harness where every route threw the same thing. With the
  // console open, a manager on an admin only route is refused on the page, and a
  // super admin is let through the gate (and then stopped by the database fake,
  // which proves the gate did not answer for them).
  it("CONTROL: with the console open, a manager is refused on the page rather than redirected", async () => {
    process.env.AGENT_SCHEDULING_LIVE = "true";
    expect(await outcome("./buckets/page.tsx", "manager")).toBe("rendered");
  });

  it("CONTROL: a super admin passes the gate with the console hidden", async () => {
    delete process.env.AGENT_SCHEDULING_LIVE;
    expect(await outcome("./buckets/page.tsx", "super_admin")).toMatch(
      /^threw:read "users" before the console gate$/,
    );
  });
});
