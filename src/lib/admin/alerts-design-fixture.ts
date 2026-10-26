/**
 * The /admin/alerts switch design's fixture, as the page reads it (docs/design/fixtures/admin-alerts-help-text.json).
 *
 * The settled design (docs/design/admin-alerts-help-text.html) draws each frame from this file, and
 * the page's `?frame=<id>` preview ticks the same boxes from it, so the design match score compares
 * like with like. Only ever reached behind `designFixturesEnabled` (the flag on this machine), the
 * mechanism Team capacity uses. Pure: JSON in, the frame's switch states out.
 */
import type { AlertSwitchName } from "../monitor/alert-switch-copy";

export interface AlertsDesignFixture {
  about: string;
  /** The page's copy before cal.com cutover, held to alertSwitchCopy by scripts/test-alerts-design-fixture.ts. */
  switches: { name: AlertSwitchName; label: string; on: string; off: string }[];
  frames: Record<string, { title: string; armed: Record<AlertSwitchName, boolean> }>;
}

/** One frame's ticked boxes. Refuses a frame the fixture does not name, or one missing a switch. */
export function alertsFixtureFrame(
  fixture: AlertsDesignFixture,
  frameId: string,
): { armed: Record<AlertSwitchName, boolean> } {
  const frame = fixture.frames[frameId];
  if (!frame) throw new Error(`the fixture names no frame "${frameId}"`);
  const armed = {} as Record<AlertSwitchName, boolean>;
  for (const s of fixture.switches) {
    const v = (frame.armed as Record<string, unknown>)[s.name];
    if (typeof v !== "boolean") throw new Error(`frame "${frameId}" gives no on or off for ${s.name}`);
    armed[s.name] = v;
  }
  return { armed };
}
