// Refuse to deploy unless `ci` passed on this exact commit (#3088).
//
// Run by the CI deploy job before it builds anything. Reads the check runs GitHub
// holds for $HEAD_SHA and exits non-zero unless the newest `ci` run from GitHub
// Actions on that sha concluded success. The decision is in
// scripts/lib/deploy-ci-gate.ts; this file is the read and the exit code.
//
// Imports nothing outside scripts/ and node builtins, so it needs node and the
// checkout and nothing the install provides.
//
// Exit codes, each its own so a reader knows which fix applies (L11):
//   0  ci passed on this sha
//   1  REPO, HEAD_SHA or GH_TOKEN is missing; nothing was read
//   2  GitHub could not be read after every attempt; re-run the deploy job
//   3  GitHub answered and the commit has not passed ci: do not deploy it
//   4  this check itself crashed; nothing was deployed
//
// Run: GH_TOKEN=... REPO=Try-Pennie/slate HEAD_SHA=<sha> node --experimental-strip-types scripts/check-ci-before-deploy.ts
import { isEntryPoint } from "./lib/run-alerter.ts";
import {
  CI_CHECK_NAME,
  judgeCiForDeploy,
  parseCheckRuns,
  readWithRetry,
  type CheckRunsRead,
} from "./lib/deploy-ci-gate.ts";

export type GateFetch = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export async function runGate(
  env: Record<string, string | undefined>,
  deps: {
    fetchImpl: GateFetch;
    sleep: (ms: number) => Promise<void>;
    log: (line: string) => void;
  },
): Promise<number> {
  const repo = env.REPO?.trim() ?? "";
  const sha = env.HEAD_SHA?.trim() ?? "";
  const token = env.GH_TOKEN?.trim() ?? "";
  const missing = [!repo && "REPO", !sha && "HEAD_SHA", !token && "GH_TOKEN"].filter(Boolean);
  if (missing.length > 0) {
    deps.log(
      `::error title=Deploy refused::${missing.join(", ")} not set, so whether ci passed on this commit could not be checked. Nothing was deployed.`,
    );
    return 1;
  }

  const url = `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?check_name=${CI_CHECK_NAME}&per_page=100`;
  const read = async (): Promise<CheckRunsRead> => {
    try {
      const res = await deps.fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (res.status < 200 || res.status >= 300) return { ok: false, error: `GitHub answered ${res.status}` };
      return parseCheckRuns(await res.json());
    } catch (err) {
      return { ok: false, error: `the request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const got = await readWithRetry(read, { attempts: 3, delayMs: 5000, sleep: deps.sleep });
  if (!got.ok) {
    deps.log(
      `::error title=Deploy refused::Could not read the check runs for ${sha} after ${got.attemptsUsed} attempts (${got.error}), so nothing says ci passed on it. Nothing was deployed; re-run this job.`,
    );
    return 2;
  }

  const verdict = judgeCiForDeploy(sha, got.runs);
  if (!verdict.ok) {
    deps.log(
      `::error title=Deploy refused::${verdict.detail} (${verdict.reason}). Only a commit whose ci passed on that exact sha may deploy. Nothing was deployed.`,
    );
    return 3;
  }
  deps.log(`ci passed on ${sha} (check run ${verdict.runId}), so this commit may deploy.`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  runGate(process.env, {
    fetchImpl: (url, init) =>
      fetch(url, init).then((r) => ({ status: r.status, json: () => r.json() })),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
  }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.log(`::error title=Deploy refused::the ci check crashed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(4);
    },
  );
}
