// `pnpm verify:agent-link-names` exits 2 ("nothing was proved") whenever it never
// reached the migration, and 1 only for a check that ran and failed (#3026). A
// container that cannot start (an image that cannot be pulled) is the former.
//
// Driven with a fake `docker` first on PATH, so no real Docker is needed: the
// fake answers `version` and refuses `run`, which is the state under test. The
// positive control is a fake that refuses `version` too, which must also exit 2,
// so the assertion is about the exit the script chooses rather than about the
// fake being found at all.

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, eq, finish } from "./lib/harness.ts";

const SCRIPT = fileURLToPath(new URL("./verify-agent-link-names-sql.ts", import.meta.url));

function runWithFakeDocker(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
  try {
    const bin = join(dir, "docker");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    return spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
      timeout: 30_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const r = runWithFakeDocker(
    'case "$1" in version) echo 27.0.0; exit 0;; run) echo "pull access denied" >&2; exit 125;; *) exit 0;; esac',
  );
  eq(r.status, 2, "a container that cannot start exits 2, not the failed check exit");
  assert(/UNMEASURED/.test(r.stderr ?? ""), "and says nothing was proved");
  assert(/could not start/.test(r.stderr ?? ""), "naming the container start as the reason");
}

{
  const r = runWithFakeDocker("exit 1");
  eq(r.status, 2, "control: no Docker at all also exits 2");
  assert(/Docker is not available/.test(r.stderr ?? ""), "with its own reason");
}

finish();
