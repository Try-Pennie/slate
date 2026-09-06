// #1994: the build identity that lets Next recognise a stale page.
//
// A browser submitting a server action names it by an id minted at BUILD time.
// When a deploy lands under a page somebody already has open, that name is gone,
// Next replies 404 with `x-nextjs-action-not-found`, and the save dies in the
// error boundary saying it cannot tell what happened.
//
// Nothing was set at all, so Next could not tell a stale page from a current one
// and had no way to say so. Two things have to hold for the setting to mean
// anything, and neither fails loudly on its own:
//
//   1. the id has to CHANGE between deploys, or every page looks current;
//   2. the deploy has to stamp the commit BEFORE it builds, or every deploy
//      shares one id while the setting reads as perfectly present (L98).
//
// Run: node --experimental-strip-types scripts/test-deployment-id.ts
import { readFileSync } from "node:fs";
import { buildCommitFrom, deploymentIdFor, UNSTAMPED_COMMIT } from "../src/lib/deployment-id.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

// ---------------------------------------------------------------------------
// It changes when the commit does, and only then.
// ---------------------------------------------------------------------------
{
  const a = deploymentIdFor("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const b = deploymentIdFor("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert(a !== b, "two commits give two ids, which is the whole property");
  eq(deploymentIdFor("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), a, "and one commit gives one id");
  // A single character apart is the realistic case for consecutive deploys of a
  // rebased branch, and it must still separate them.
  assert(
    deploymentIdFor("abc0000") !== deploymentIdFor("abc0001"),
    "a one character difference separates two builds",
  );
  assert(/^[0-9a-f]{16}$/.test(a), `the id is a short hex digest (${a})`);
}

// It must not BE the commit. `deploymentId` rides on every request to the
// browser, and `src/lib/build-info.ts` records that the commit is deliberately
// not public: a NEXT_PUBLIC_ var was rejected for exactly this reason and
// /api/smoke/version sits behind the booking key.
{
  const commit = "9f2c1d4e8b7a6035fedcba9876543210deadbeef";
  const id = deploymentIdFor(commit);
  assert(!commit.includes(id), "the id is not a slice of the commit");
  assert(!id.includes(commit.slice(0, 8)), "and does not carry its prefix");
  eq(id.length, 16, "it is a digest, not the forty character sha");
}

// ---------------------------------------------------------------------------
// It is read out of the file the deploy job stamps.
// ---------------------------------------------------------------------------
{
  eq(
    buildCommitFrom('export const BUILD_COMMIT = "abc123";'),
    "abc123",
    "the stamped commit is read from the declaration",
  );
  // A rename or a reshape of that file must fail here rather than silently
  // giving every build the same id.
  let threw = false;
  try {
    buildCommitFrom("export const SOMETHING_ELSE = \"abc123\";");
  } catch (err) {
    threw = err instanceof Error && err.message.includes("BUILD_COMMIT");
  }
  assert(threw, "a build-info file with no BUILD_COMMIT refuses by name");

  // And the real file still has the shape, so this is not passing on fixtures
  // alone while the thing it reads has moved (L52).
  const real = buildCommitFrom(readFileSync("src/lib/build-info.ts", "utf8"));
  assert(real.length > 0, `the real build-info file still parses (${real})`);
  eq(real, UNSTAMPED_COMMIT, "and in git it holds the placeholder, as its own docstring says");
}

// ---------------------------------------------------------------------------
// The deploy stamps BEFORE it builds.
// ---------------------------------------------------------------------------
//
// This is the assertion that keeps the whole thing from being decorative. An
// unstamped deploy would give every build the id of the string "dev", so nothing
// could tell a stale page from a current one, and every part would read as
// correctly wired.
//
// It is checked here rather than refused inside `next.config.ts`, and the first
// version did refuse it there. The signal available in the config for "this is a
// real deploy" was a production build pointing at a non-localhost URL, which is
// also every local `pnpm cf:build`, because `.env.local` points at production.
// It broke on its first run.
{
  // COMMENTS STRIPPED FIRST. The workflow explains both steps in prose above
  // them, so a plain search finds the sentence describing `pnpm cf:deploy`
  // thirty lines before the step that runs it, and reports the ordering
  // backwards. That is a check failing on its own documentation, and it caught
  // this file on its first run.
  const ci = readFileSync(".github/workflows/ci.yml", "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const stampAt = ci.indexOf("scripts/stamp-build-info.ts");
  const deployAt = ci.indexOf("pnpm cf:deploy");
  if (stampAt < 0) fail("the deploy job no longer stamps the commit at all");
  else if (deployAt < 0) fail("the deploy job no longer runs cf:deploy");
  else {
    assert(
      stampAt < deployAt,
      "the deploy job stamps the commit before it builds and deploys",
    );
  }

  // And the config really consumes it, so the two halves are joined rather than
  // each being individually true about nothing.
  const config = readFileSync("next.config.ts", "utf8");
  assert(/deploymentId:/.test(config), "next.config.ts sets deploymentId");
  assert(
    /build-info\.ts/.test(config),
    "and derives it from the file the deploy job stamps, not from a second source",
  );
  assert(
    /deploymentIdFor\(/.test(config),
    "through the hashing helper, so the commit does not reach the browser",
  );
}

finish();
