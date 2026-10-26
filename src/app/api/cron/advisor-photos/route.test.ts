import { describe, it, expect, vi, beforeEach } from "vitest";

// One failure, one message (Dan, 2026-10-03), and never zero. The dispatcher's
// generic lane page stands down only for alerts raised ABOUT this failure. An
// alert the run raised for some other reason earlier (a held photo, say) must not
// silence the page about a run that then failed.
const cron = vi.hoisted(() => ({ isAuthorizedCron: vi.fn(() => true) }));
const lane = vi.hoisted(() => ({ runAdvisorPhotoLane: vi.fn() }));
vi.mock("@/lib/cron", () => cron);
vi.mock("@/lib/advisor-photos/lane", () => lane);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";
import { noteAlertKey } from "@/lib/notify/alert-recording";

const req = () => ({ headers: new Headers() }) as unknown as Parameters<typeof GET>[0];
const HEADER = "x-slate-lane-alerted";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cron/advisor-photos failure messages", () => {
  it("names the alert the lane raised about its own failure", async () => {
    lane.runAdvisorPhotoLane.mockResolvedValueOnce({
      status: "failed",
      detail: "write failed",
      alerted: ["advisor_photos_unread"],
    });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(res.headers.get(HEADER)).toBe("advisor_photos_unread");
  });

  it("does not let an UNRELATED alert earlier in the run silence the failure", async () => {
    lane.runAdvisorPhotoLane.mockImplementationOnce(async () => {
      // Raised by the same run, about something else, before the failure.
      noteAlertKey("advisor_photos_held");
      return { status: "failed", detail: "write failed", alerted: [] };
    });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(res.headers.get(HEADER)).toBeNull();
  });

  it("leaves a run that threw to the generic page, whatever it raised first", async () => {
    lane.runAdvisorPhotoLane.mockImplementationOnce(async () => {
      noteAlertKey("advisor_photos_held");
      throw new Error("lock table unreadable");
    });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(res.headers.get(HEADER)).toBeNull();
  });

  it("answers 200 for a skipped run", async () => {
    lane.runAdvisorPhotoLane.mockResolvedValueOnce({ status: "skipped", why: "overlapping-run" });
    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});
