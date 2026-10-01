// Embed postMessage origin derivation (#593). The Booker must target a KNOWN
// parent origin for its outbound postMessages (never "*"), so lead PII in the
// slate:bookingSuccessful payload can't be delivered to a hostile co-embedding
// page. This covers the pure origin-resolution; the DOM wiring is verified in
// the Booker + widget vitest suites.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-embed-origin.ts
import {
  embedParentOrigin,
  parentOriginMismatch,
  originMismatchMessage,
  parseOriginMismatchMessage,
} from "@/lib/embed/parent-origin";
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

// --- #2641: a host whose declared origin is not the one that framed us -----------
//
// The Booker posts to the DECLARED origin, and the browser silently drops a post
// whose target is not the real parent, so a host passing the wrong address loses
// the resize and the success message with nothing logged on either side. The
// referrer is the browser's own statement of who framed us, so a disagreement
// between the two is what gets reported.
const SLATE = "https://slate.trypennie.app";
const mm = (declared: string | null, referrer: string) =>
  parentOriginMismatch({ declared, referrer, ownOrigin: SLATE });
{
  const m = mm("https://trypennie.com", "https://www.trypennie.com/booking/a04xx?email=k%40x.com");
  assert(
    m?.declared === "https://trypennie.com" && m.framedBy === "https://www.trypennie.com",
    "a www host declaring the bare domain is a mismatch, reported as two ORIGINS",
  );
  assert(
    !JSON.stringify(m).includes("a04xx") && !JSON.stringify(m).includes("email"),
    "and never carries the referrer's path or query, which can hold a lead's details",
  );
  assert(mm("https://trypennie.com", "https://trypennie.com/any/path") === null, "same origin, different path, is agreement");
  assert(mm("https://trypennie.com:443", "https://trypennie.com/") === null, "a default port is the same origin");
  assert(mm("https://host.test", "http://host.test/") !== null, "a scheme difference is a real mismatch");
  // Nothing to compare is not a finding: no report, rather than a guess.
  assert(mm(null, "https://trypennie.com/") === null, "no declared origin: nothing to compare");
  assert(mm("https://trypennie.com", "") === null, "a stripped referrer: nothing to compare");
  assert(mm("not a url", "https://trypennie.com/") === null, "an unreadable declared origin: nothing to compare");
  assert(mm("https://trypennie.com", "about:blank") === null, "an opaque referrer: nothing to compare");
}

// The referrer names Slate itself when the booking box reloaded or navigated
// inside its own frame: the browser reports the previous Slate page, not the host.
// That says nothing about who framed us, so it is never a mismatch. Measured
// 2026-10-01: a trypennie lead whose referrer was the booker's own origin paged
// "a page at https://slate.trypennie.app" while every message reached trypennie.
{
  assert(mm("https://trypennie.com", `${SLATE}/book/1?embed=1&parentOrigin=x`) === null, "a referrer naming Slate's own origin is not a host, so not a mismatch");
  assert(mm("https://trypennie.com", "https://www.trypennie.com/") !== null, "control: a real host disagreeing is still a mismatch beside it");
}

// The report travels as a message string. The server rebuilds the pair from it
// and REFUSES anything that is not exactly two origins, because the endpoint is
// public and whatever it accepts can reach Slack.
{
  const pair = { declared: "https://trypennie.com", framedBy: "https://www.trypennie.com" };
  const msg = originMismatchMessage(pair);
  const back = parseOriginMismatchMessage(msg);
  assert(back?.declared === pair.declared && back.framedBy === pair.framedBy, "the message round trips");
  assert(parseOriginMismatchMessage("declared https://a.test, framed by https://a.test") === null, "two equal origins are not a mismatch");
  assert(parseOriginMismatchMessage("declared https://a.test/path, framed by https://b.test") === null, "a value that is not a bare origin is refused");
  assert(parseOriginMismatchMessage("click https://evil.test now") === null, "free text is refused");
  assert(parseOriginMismatchMessage("declared javascript:alert(1), framed by https://b.test") === null, "a non http origin is refused");
}

finish();
