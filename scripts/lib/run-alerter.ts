// The entry point every bare node alerter shares (#2572).
//
// `scripts/notify-*.ts` and `scripts/check-main-push.ts` each ended the same way: an
// `isMain` guard comparing argv[1] against the module's own path (so a test can import
// `run` without running it), a Slack poster built from SLACK_BOT_TOKEN, and a `.then`
// that printed a verdict and called `process.exit`. Eight copies, and the global
// duplication guard named the third. This is the one copy.
//
// It imports nothing outside `scripts/` and node builtins, and must not: these scripts
// run in workflows with NO dependency install (AGENTS.md, "An alerting workflow carries
// no dependency install"), and `scripts/test-dependency-free-scripts.ts` walks their
// import graph, this file included. `scripts/test-run-alerter.ts` drives it.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeSlackPoster } from "./slack-post.ts";

/** A poster bound to a token: what `makeSlackPoster` hands back. */
export type SlackPost = ReturnType<typeof makeSlackPoster>;

/**
 * Is this module the file node was asked to run, rather than an import? Both sides are
 * resolved through the filesystem so a symlinked checkout compares equal to itself. No
 * script argument at all (a REPL, `node -e`) is not the entry point; a script path that
 * cannot be resolved THROWS, as the idiom this replaces did, because answering "not the
 * entry point" there would make a real entry point silently do nothing (L11).
 */
export function isEntryPoint(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  const script = argv[1];
  if (!script) return false;
  return realpathSync(script) === realpathSync(fileURLToPath(moduleUrl));
}

export type AlerterMain = (post: SlackPost, env: NodeJS.ProcessEnv) => Promise<number>;

/**
 * Run `main` when `moduleUrl` is the entry point, with a poster built from
 * SLACK_BOT_TOKEN, and exit with the code it returns. A `main` that throws exits 1 with
 * the reason printed, so a broken alerter is red with its own words rather than dying
 * with no verdict. When the module was merely imported, nothing runs and nothing exits.
 *
 * The resolved promise is for tests; a script calls this at top level and ignores it.
 */
export async function runAlerter(
  moduleUrl: string,
  main: AlerterMain,
  io: {
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    exit?: (code: number) => void;
    error?: (line: string) => void;
  } = {},
): Promise<void> {
  if (!isEntryPoint(moduleUrl, io.argv ?? process.argv)) return;
  const env = io.env ?? process.env;
  const exit = io.exit ?? ((code: number) => process.exit(code));
  const error = io.error ?? ((line: string) => console.error(line));
  const post = makeSlackPoster({ token: env.SLACK_BOT_TOKEN ?? "" });
  let code: number;
  try {
    code = await main(post, env);
  } catch (err) {
    error(`::error title=Alerter failed::${err instanceof Error ? err.message : String(err)}`);
    code = 1;
  }
  exit(code);
}
