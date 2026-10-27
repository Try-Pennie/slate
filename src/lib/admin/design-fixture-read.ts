import { headers } from "next/headers";
import { designFixturesEnabled } from "@/lib/admin/team-capacity-fixture";

/**
 * A settled design's committed fixture, for a page's `?frame=` preview, or null when the page
 * must draw from the database as usual.
 *
 * Answers only when a frame was asked for, the e2e run set `SLATE_DESIGN_FIXTURES`, and the
 * request is to this machine (`designFixturesEnabled`), so a deploy never serves invented
 * numbers. Call it only after the page's own access checks. The file is read from disk, never
 * imported, so no deployment's bundle carries it.
 *
 * `name` is the fixture's file name in docs/design/fixtures, without `.json`.
 */
export async function readDesignFixture<T>(frame: string | undefined, name: string): Promise<T | null> {
  if (!frame) return null;
  if (!designFixturesEnabled(process.env.SLATE_DESIGN_FIXTURES, (await headers()).get("host"))) return null;
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(`${process.cwd()}/docs/design/fixtures/${name}.json`, "utf8")) as T;
}
