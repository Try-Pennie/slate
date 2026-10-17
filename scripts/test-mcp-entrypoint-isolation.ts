// #3544 (plan phase 4.3): isolation between Slate's named entrypoints and the Workers
// that bind them (plan locked decision 9).
//
// A service binding to a named entrypoint exposes EVERY public method of its class,
// so isolation is a property of the classes and of who binds which:
//
//   - only `McpBookingGateway` has a `booking` method: every other entrypoint class in
//     worker/index.ts (the log shipping receipt today; the ops and Slack gateways, when
//     #3533 and #3546 add them, are covered by the same scan without being named);
//   - `McpBookingGateway` has `booking` and nothing else;
//   - the booking server's registry calls only methods its entrypoint really has, and
//     the two lists are equal (each Worker's registry export matches its entrypoint);
//   - exactly one Worker config binds `McpBookingGateway`: the booking server's.
//
// That `booking()` refuses an unsigned token and one signed with a foreign key is
// `scripts/test-mcp-booking-gateway.ts` (the route that verifies them) and
// `scripts/test-machine-token.ts` (the verifier, over the committed fixtures).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-mcp-entrypoint-isolation.ts
import { readFileSync, readdirSync } from "node:fs";
import { BOOKING_GATEWAY_METHODS, BOOKING_TOOLS } from "../worker/mcp-booking/registry.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** Each `export class X extends WorkerEntrypoint` in a source, with its method names. */
function entrypointMethods(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of source.matchAll(/export class (\w+) extends WorkerEntrypoint<\w+> \{/g)) {
    const start = m.index! + m[0].length;
    const body = source.slice(start, source.indexOf("\n}\n", start));
    // Class members sit at two spaces of indent; a nested call or a property access does not.
    const methods = [...body.matchAll(/^ {2}(?:async\s+)?(\w+)\s*\(/gm)].map((x) => x[1]!).filter((n) => n !== "constructor");
    out.set(m[1]!, methods);
  }
  return out;
}

const entry = readFileSync("worker/index.ts", "utf8");
const classes = entrypointMethods(entry);
assert(classes.size >= 2, `the scan found the named entrypoints (${[...classes.keys()].join(", ")})`);

const bookingHolders = [...classes].filter(([, methods]) => methods.includes("booking")).map(([name]) => name);
eq(bookingHolders, ["McpBookingGateway"], "only McpBookingGateway has a booking method: no other entrypoint can book");
eq(classes.get("McpBookingGateway"), [...BOOKING_GATEWAY_METHODS], "McpBookingGateway has booking and nothing else");
eq(classes.get("LogShippingReceipt"), ["shipped"], "the log shipping receipt still has only shipped");
assert(BOOKING_TOOLS.every((t) => (classes.get("McpBookingGateway") ?? []).includes(t.gatewayMethod)), "every booking tool calls a method its entrypoint has");

// Positive control: a booking method planted on another entrypoint is caught.
const planted = entry.replace("  async shipped(): Promise<{ stamped: boolean }> {", "  async booking(): Promise<void> {}\n  async shipped(): Promise<{ stamped: boolean }> {");
assert(planted !== entry, "positive control: the method was planted in a copy of the real source");
eq(
  [...entrypointMethods(planted)].filter(([, m]) => m.includes("booking")).map(([n]) => n).sort(),
  ["LogShippingReceipt", "McpBookingGateway"],
  "positive control: a second class with a booking method is named by the scan",
);

// Who binds McpBookingGateway: the booking server, and nobody else.
const configs = readdirSync(".").filter((f) => /^wrangler(\..+)?\.jsonc$/.test(f));
const binders = configs.filter((f) => /"entrypoint"\s*:\s*"McpBookingGateway"/.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")));
eq(binders, ["wrangler.mcp-booking.jsonc"], "exactly one Worker binds McpBookingGateway, the booking MCP server");

finish();
