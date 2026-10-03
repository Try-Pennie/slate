import { describe, it, expect } from "vitest";

describe("/login renders per request (#2575)", () => {
  it("opts the segment out of prerendering, so Next can nonce its scripts", async () => {
    // Next applies the content security policy's nonce while it SERVES a request.
    // A prerendered /login was built before any request existed, so its scripts
    // carry no nonce, and under the enforced policy every one of them is refused:
    // a sign in page that never runs. The page itself is a client component and
    // cannot carry route segment config, so the segment's layout does.
    const layout = await import("./layout");
    expect(layout.dynamic).toBe("force-dynamic");
  });
});
