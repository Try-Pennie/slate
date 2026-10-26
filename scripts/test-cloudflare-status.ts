// What the stale lane page says about Cloudflare's status page (2026-10-26).
//
// On 2026-10-26 Cloudflare stopped firing Slate's every minute cron for 17 minutes
// ("Delayed, missed, and duplicated Workers Cron Triggers"), and six pages went out
// with nothing in any of them saying the cause was Cloudflare's. The combined page now
// quotes an open Workers incident, says when there is none, and claims nothing when
// the status page could not be read (L11), so every outcome here has its own answer.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-cloudflare-status.ts
import {
  CLOUDFLARE_STATUS_CACHE_MS,
  CLOUDFLARE_STATUS_URL,
  parseCloudflareIncidents,
  readCloudflareCronStatus,
  resetCloudflareStatusCache,
} from "../src/lib/monitor/cloudflare-status.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const incident = (name: string, components: string[] = []) => ({
  name,
  status: "investigating",
  components: components.map((c) => ({ name: c })),
});

// --- Parsing: only incidents that touch Workers or cron are ours to quote.
eq(
  parseCloudflareIncidents({ incidents: [incident("Delayed, missed, and duplicated Workers Cron Triggers")] }),
  { kind: "incident", names: ["Delayed, missed, and duplicated Workers Cron Triggers"] },
  "a Workers cron incident is quoted by name",
);
eq(
  parseCloudflareIncidents({ incidents: [incident("Elevated errors", ["Workers"])] }),
  { kind: "incident", names: ["Elevated errors"] },
  "an incident listing the Workers component counts, whatever its title",
);
eq(
  parseCloudflareIncidents({ incidents: [incident("Dashboard login issues", ["Dashboard"])] }),
  { kind: "clear" },
  "an incident elsewhere in Cloudflare is not a Workers incident",
);
eq(parseCloudflareIncidents({ incidents: [] }), { kind: "clear" }, "no open incident is a measured clear");
eq(parseCloudflareIncidents({}), { kind: "unknown" }, "a body without an incidents list is unread, not clear");
eq(parseCloudflareIncidents(null), { kind: "unknown" }, "no body is unread");
eq(
  parseCloudflareIncidents({ incidents: [{ status: "investigating" }] }),
  { kind: "unknown" },
  "an incident with no name cannot be quoted or ruled out",
);

// --- Reading: the network seam is injected, so nothing here reaches Cloudflare (L291).
const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

let calls = 0;
const seen: string[] = [];
const fetchOk = async (url: string | URL | Request) => {
  calls++;
  seen.push(String(url));
  return okResponse({ incidents: [incident("Workers Cron Triggers delayed")] });
};

resetCloudflareStatusCache();
eq(await readCloudflareCronStatus(fetchOk, 1_000), { kind: "incident", names: ["Workers Cron Triggers delayed"] }, "a read returns the parsed status");
eq(seen[0], CLOUDFLARE_STATUS_URL, "it reads the public unresolved incidents feed");
await readCloudflareCronStatus(fetchOk, 1_000 + CLOUDFLARE_STATUS_CACHE_MS - 1);
eq(calls, 1, "a second read inside the cache window does not fetch again: the page is evaluated every minute");
await readCloudflareCronStatus(fetchOk, 1_000 + CLOUDFLARE_STATUS_CACHE_MS);
eq(calls, 2, "once the window has passed it reads again");

resetCloudflareStatusCache();
const failing = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
eq(await readCloudflareCronStatus(failing, 1_000), { kind: "unknown" }, "a refused read is unknown, never clear");

resetCloudflareStatusCache();
const throwing = async (): Promise<Response> => {
  throw new Error("network down");
};
eq(await readCloudflareCronStatus(throwing, 1_000), { kind: "unknown" }, "a read that throws is unknown and does not throw");

resetCloudflareStatusCache();
let aborted = false;
const hanging = (_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    });
  });
eq(await readCloudflareCronStatus(hanging, 1_000, 5), { kind: "unknown" }, "a read that hangs gives up as unknown");
assert(aborted, "and the hanging request is aborted rather than left running in the lane");

// A failed read is not cached: the next tick tries again rather than staying blind for the window.
resetCloudflareStatusCache();
await readCloudflareCronStatus(throwing, 1_000);
calls = 0;
await readCloudflareCronStatus(fetchOk, 1_001);
eq(calls, 1, "after a failed read the next one fetches");

finish();
