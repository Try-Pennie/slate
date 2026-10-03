import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3086: /dev/preview lets a caller act as ANY user, super admins included, with
// no sign-in. It used to be gated on NODE_ENV !== "production" alone, while
// `next dev` reads the live Supabase and listened on every interface, so anyone
// on the same network could act as an admin against production data.
//
// It is now on only when ALL of these hold: NODE_ENV is exactly "development",
// SLATE_DEV_PREVIEW is exactly "1", and the request came to a loopback Host.
// Each is asserted to refuse on its own, and the one configuration that should
// work is asserted to work, so a gate that refused everything cannot pass (L1).

const cookieJar = vi.hoisted(() => new Map<string, string>());
const hostHeader = vi.hoisted(() => ({ value: "localhost:3000" as string | null }));
const lookups = vi.hoisted(() => ({ count: 0 }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined),
    set: (name: string, value: string) => cookieJar.set(name, value),
    delete: (name: string) => cookieJar.delete(name),
  }),
  headers: async () => new Headers(hostHeader.value ? { host: hostHeader.value } : {}),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, email: string) => ({
          maybeSingle: async () => {
            lookups.count += 1;
            return { data: { id: "u-admin", email, role: "super_admin" }, error: null };
          },
        }),
      }),
    }),
  }),
}));

import { DEV_PREVIEW_COOKIE, devPreviewEnabled, devPreviewUser, isLoopbackHost } from "./dev-preview";
import { GET } from "@/app/dev/preview/route";

function previewRequest(host: string) {
  const url = new URL(`http://${host}/dev/preview?email=admin@trypennie.com`);
  return {
    url: url.toString(),
    nextUrl: url,
    headers: new Headers({ host }),
  } as never;
}

beforeEach(() => {
  cookieJar.clear();
  hostHeader.value = "localhost:3000";
  lookups.count = 0;
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("SLATE_DEV_PREVIEW", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dev preview gate (#3086)", () => {
  it("works on localhost in development with the opt-in set", async () => {
    expect(devPreviewEnabled()).toBe(true);
    const res = await GET(previewRequest("localhost:3000"));
    expect(res.status).toBe(307);
    expect(cookieJar.get(DEV_PREVIEW_COOKIE)).toBe("admin@trypennie.com");
    expect(await devPreviewUser()).toMatchObject({ id: "u-admin" });
  });

  it("is a 404 and previews nobody under production conditions", async () => {
    vi.stubEnv("NODE_ENV", "production");
    cookieJar.set(DEV_PREVIEW_COOKIE, "admin@trypennie.com");

    expect(devPreviewEnabled()).toBe(false);
    expect((await GET(previewRequest("localhost:3000"))).status).toBe(404);
    expect(await devPreviewUser()).toBeNull();
    expect(lookups.count).toBe(0);
  });

  it("is off under any NODE_ENV other than development (test, unset)", async () => {
    for (const nodeEnv of ["test", ""]) {
      vi.stubEnv("NODE_ENV", nodeEnv);
      expect(devPreviewEnabled(), nodeEnv).toBe(false);
      expect((await GET(previewRequest("localhost:3000"))).status, nodeEnv).toBe(404);
    }
  });

  it("is off in development without the explicit opt-in", async () => {
    for (const flag of ["", "true", "0"]) {
      vi.stubEnv("SLATE_DEV_PREVIEW", flag);
      cookieJar.set(DEV_PREVIEW_COOKIE, "admin@trypennie.com");
      expect(devPreviewEnabled(), flag).toBe(false);
      expect((await GET(previewRequest("localhost:3000"))).status, flag).toBe(404);
      expect(await devPreviewUser(), flag).toBeNull();
    }
    expect(lookups.count).toBe(0);
  });

  it("refuses a request that did not come to a loopback host", async () => {
    for (const host of ["192.168.1.20:3000", "slate.trypennie.app", "localhost.evil.com"]) {
      expect((await GET(previewRequest(host))).status, host).toBe(404);
    }
    expect(cookieJar.has(DEV_PREVIEW_COOKIE)).toBe(false);

    // A cookie already present is not honoured from a non-loopback host either.
    cookieJar.set(DEV_PREVIEW_COOKIE, "admin@trypennie.com");
    hostHeader.value = "192.168.1.20:3000";
    expect(await devPreviewUser()).toBeNull();
    hostHeader.value = null;
    expect(await devPreviewUser()).toBeNull();
    expect(lookups.count).toBe(0);
  });

  it("recognises exactly the loopback hosts", () => {
    for (const host of ["localhost", "localhost:3000", "127.0.0.1", "127.0.0.1:3000", "[::1]", "[::1]:3000"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [null, "", "10.0.0.5:3000", "localhost.evil.com", "127.0.0.1.nip.io", "evil.com:127.0.0.1"]) {
      expect(isLoopbackHost(host), String(host)).toBe(false);
    }
  });
});
