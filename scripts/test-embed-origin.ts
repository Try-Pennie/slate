// Embed postMessage origin derivation (#593). The Booker must target a KNOWN
// parent origin for its outbound postMessages (never "*"), so lead PII in the
// slate:bookingSuccessful payload can't be delivered to a hostile co-embedding
// page. This covers the pure origin-resolution; the DOM wiring is verified in
// the Booker + widget vitest suites.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-embed-origin.ts
import { embedParentOrigin } from "@/lib/embed/parent-origin";
import { assert, finish } from "./lib/harness.ts";

// The widget passes its own origin explicitly — use it verbatim.
assert(
  embedParentOrigin("https://trypennie.com", null) === "https://trypennie.com",
  "explicit parentOrigin is used as-is",
);
assert(
  embedParentOrigin("https://trypennie.com", "https://evil.example/x") ===
    "https://trypennie.com",
  "explicit parentOrigin wins over the referrer",
);

// Fallback: the referrer is the browser's authoritative framer; reduce to origin.
assert(
  embedParentOrigin(null, "https://trypennie.com/landing?a=1") ===
    "https://trypennie.com",
  "falls back to the referrer's origin (path/query stripped)",
);
assert(
  embedParentOrigin("", "https://host.test:8443/p") === "https://host.test:8443",
  "empty parentOrigin falls through to the referrer, keeping the port",
);

// No trustworthy origin → null, so callers skip the post rather than broadcast.
assert(
  embedParentOrigin(null, null) === null,
  "no parentOrigin and no referrer yields null (caller must not post to '*')",
);
assert(
  embedParentOrigin("", "") === null,
  "empty strings yield null",
);
assert(
  embedParentOrigin("not a url", "also not a url") === null,
  "unparseable candidates yield null",
);
// file:// hosts (opened, not served) surface a "null" opaque origin — reject it.
assert(
  embedParentOrigin("null", null) === null,
  "the opaque 'null' origin is rejected, not echoed back",
);

finish();
