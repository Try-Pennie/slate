/**
 * The Coordinator booking design's fixture as the page renders it (#4264).
 *
 * The settled design (docs/design/coordinator-admin.html) draws seven frames from one set of
 * data, committed as docs/design/fixtures/coordinator-admin.json, and the page's `?frame=`
 * preview draws the real components from the same file, so the design match score compares
 * like with like. Only ever reached behind `designFixturesEnabled` (Team capacity's mechanism:
 * the e2e flag AND a request to this machine). scripts/test-coordinator-admin-design-fixture.ts
 * holds the file to the design and its copy to the page's.
 *
 * Pure: JSON in, the frame's state out.
 */
import type { COORDINATOR_BOOKING_COPY } from "./coordinator-booking-copy.ts";
import type { CoordinatorsRead } from "./coordinators.ts";
import { designFixtureFrame } from "./design-fixture-frame.ts";

type Copy = typeof COORDINATOR_BOOKING_COPY;

export interface CoordinatorDesignFixture {
  about?: string;
  adminSwitch: {
    page: { title: string; href: string; intro: string };
    section: Copy["section"];
    switch: Copy["switch"];
    list: Copy["list"];
    coordinators: { name: string; email: string; lastSignedIn: string }[];
  };
  frames: Record<
    string,
    { theme: string; switch: string; list: string; removing?: number }
  >;
}

export type SwitchFrameState = "off" | "confirm-on" | "on";

export interface CoordinatorFrame {
  theme: "light" | "dark";
  /** The switch as drawn: off, off with its question open, or on. */
  switchState: SwitchFrameState;
  read: CoordinatorsRead;
  /** The row whose Remove question is open, by id, or null. */
  removing: string | null;
}

const SWITCH_STATES: readonly string[] = ["off", "confirm-on", "on"];

/** One frame of the design, from the fixture. Refuses a frame or a state the fixture does not name. */
export function coordinatorFrame(fixture: CoordinatorDesignFixture, frameId: string): CoordinatorFrame {
  const frame = designFixtureFrame(fixture.frames, frameId);
  if (!SWITCH_STATES.includes(frame.switch)) throw new Error(`frame "${frameId}" has no switch state named ${frame.switch}`);
  // The design's coordinators carry no id; the frame gives each a stable one by position.
  const rows = fixture.adminSwitch.coordinators.map((c, i) => ({ id: `design-${i}`, ...c }));
  let read: CoordinatorsRead;
  let removing: string | null = null;
  if (frame.list === "failed") read = { ok: false };
  else if (frame.list === "empty") read = { ok: true, rows: [] };
  else if (frame.list === "rows" || frame.list === "remove") {
    read = { ok: true, rows };
    if (frame.list === "remove") {
      const row = rows[frame.removing ?? -1];
      if (!row) throw new Error(`frame "${frameId}" removes coordinator ${frame.removing}, who is not in the fixture`);
      removing = row.id;
    }
  } else throw new Error(`frame "${frameId}" has no list state named ${frame.list}`);
  return { theme: frame.theme, switchState: frame.switch as SwitchFrameState, read, removing };
}
