// The decisions behind the load run's teardown (#3310), kept apart from the live IO in
// keep-worker-idle.ts so every outcome is driven offline by
// scripts/test-loadtest-idle-worker.ts.
//
// The teardown used to DELETE the load test Worker, and every run's deploy then created
// a new one. Cloudflare has taken 27 to 105 minutes to deliver the first cron to a newly
// created Worker, so every run waited for its lanes to start and a slow delivery lost the
// run. A Worker that lives on keeps receiving its crons. So the teardown keeps it and
// takes its secrets instead: with none of them the entry answers nothing and runs no
// lane (`loadtestIdle`), and with the Supabase branch deleted beside it, there is nothing
// left for it to reach.
//
// **It deletes by Worker name, so which Worker is the first question.** A name that
// resolved to production's would take production's secrets away. The name is checked
// against the Worker `wrangler deploy --env loadtest` actually deploys, read from
// wrangler.jsonc, and production's own name is refused whatever else is true.
//
// **Idle is confirmed by reads, never by the deletes' answers.** After deleting, it
// lists the Worker's secrets again and reads its cron schedules. Only a POSITIVELY
// readable empty listing counts as holding nothing (L98), and a kept Worker with no
// schedules is a finding, because keeping it bought nothing.
import { stripJsonComments } from "../lib/gradual-deploy.ts";
import { LOADTEST_ALLOWED_SECRETS } from "../../src/lib/loadtest-secrets.ts";

/**
 * Every way the teardown can end, and the exit code it ends on. One code per cause,
 * because each sends somebody somewhere different. Codes are APPENDED, never renumbered.
 */
export const IDLE_EXIT = {
  /** Kept, holding no secrets, with its cron schedules. The only zero. */
  idle: 0,
  /** This runner has no token, no account id, or no Worker name, so nothing was touched. */
  misconfigured: 1,
  /** The configured name is not the load test Worker wrangler.jsonc deploys. Nothing was touched. */
  wrongTarget: 2,
  /** A request never got a reply at all: DNS, TLS, a timeout, no network. */
  noAnswer: 3,
  /** A 404: the Worker is not on this account, deleted or under another account id. */
  notFound: 4,
  /** Cloudflare answered with a status other than 200 or 404. */
  refused: 5,
  /** A 200 whose body is not one this can read. */
  unreadable: 6,
  /** A secret delete answered neither success nor already gone. */
  deleteFailed: 7,
  /** After the deletes, the Worker still lists a secret. */
  stillHoldsSecrets: 8,
  /** Kept with no cron schedules, so the next run waits for a first delivery anyway. */
  noSchedules: 9,
} as const;

export interface IdleVerdict {
  idle: boolean;
  exitCode: number;
  message: string;
}

/** A read that could not be trusted, and why. */
export interface ReadFailure {
  exitCode: number;
  why: string;
}

const API = "https://api.cloudflare.com/client/v4";
const script = (accountId: string, workerName: string) =>
  `${API}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`;

export const secretsUrl = (accountId: string, workerName: string): string => `${script(accountId, workerName)}/secrets`;
export const schedulesUrl = (accountId: string, workerName: string): string => `${script(accountId, workerName)}/schedules`;
export const secretUrl = (accountId: string, workerName: string, secret: string): string =>
  `${secretsUrl(accountId, workerName)}/${encodeURIComponent(secret)}`;

/**
 * The Worker `wrangler deploy --env loadtest` deploys, and production's beside it, read
 * from wrangler.jsonc: the environment's own `name`, or wrangler's default of the top
 * level name plus `-loadtest`. Null when the file cannot answer.
 */
export function loadtestWorkerName(jsonc: string): { loadtest: string; production: string } | null {
  let json: { name?: unknown; env?: { loadtest?: { name?: unknown } } };
  try {
    // Trailing commas are legal JSONC and not JSON.
    json = JSON.parse(stripJsonComments(jsonc).replace(/,(\s*[}\]])/g, "$1")) as typeof json;
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object" || typeof json.name !== "string" || json.name === "") return null;
  const env = json.env?.loadtest;
  if (env === undefined || env === null || typeof env !== "object") return null;
  const own = env.name;
  if (own !== undefined && (typeof own !== "string" || own === "")) return null;
  return { loadtest: typeof own === "string" ? own : `${json.name}-loadtest`, production: json.name };
}

/** Why this step must not touch the configured Worker, or null when it may. */
export function targetRefusal(args: {
  configured: string;
  names: { loadtest: string; production: string } | null;
}): string | null {
  const { configured, names } = args;
  if (names === null) {
    return "wrangler.jsonc could not be read for the load test Worker's name, so which Worker this would touch is unknown";
  }
  if (names.loadtest === names.production) {
    return `wrangler.jsonc deploys the load test as ${names.production}, which is production's Worker`;
  }
  if (configured === names.production) {
    return `LOADTEST_WORKER_NAME is ${configured}, which is production's Worker`;
  }
  if (configured !== names.loadtest) {
    return `LOADTEST_WORKER_NAME is ${configured}, but \`wrangler deploy --env loadtest\` deploys ${names.loadtest}`;
  }
  return null;
}

const excerpt = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 120) || "an empty body";

/** A Cloudflare envelope's result, trusted only when positively readable. */
function readEnvelope(status: number, bodyText: string): { result: unknown } | ReadFailure {
  if (status === 404) {
    return { exitCode: IDLE_EXIT.notFound, why: "answered 404, so the Worker is not on this account (deleted, or the account id is wrong)" };
  }
  if (status !== 200) return { exitCode: IDLE_EXIT.refused, why: `answered ${status} (${excerpt(bodyText)})` };
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { exitCode: IDLE_EXIT.unreadable, why: `answered 200 with a body that is not JSON (${excerpt(bodyText)})` };
  }
  if (typeof body !== "object" || body === null || (body as { success?: unknown }).success !== true) {
    return { exitCode: IDLE_EXIT.unreadable, why: "answered 200 without a Cloudflare envelope saying success" };
  }
  if (!("result" in body)) return { exitCode: IDLE_EXIT.unreadable, why: "answered 200 with no result" };
  return { result: (body as { result: unknown }).result };
}

/** The secret names a Worker lists, or why the listing cannot be trusted. */
export function readSecretNames(status: number, bodyText: string): { names: string[] } | ReadFailure {
  const read = readEnvelope(status, bodyText);
  if ("exitCode" in read) return read;
  if (!Array.isArray(read.result)) return { exitCode: IDLE_EXIT.unreadable, why: "answered 200 with a result that is not a list of secrets" };
  const names: string[] = [];
  for (const entry of read.result) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || name === "") {
      return { exitCode: IDLE_EXIT.unreadable, why: "answered 200 with a secret that has no name" };
    }
    names.push(name);
  }
  return { names };
}

/** The cron expressions a Worker is scheduled on, or why the read cannot be trusted. */
export function readSchedules(status: number, bodyText: string): { crons: string[] } | ReadFailure {
  const read = readEnvelope(status, bodyText);
  if ("exitCode" in read) return read;
  const schedules = (read.result as { schedules?: unknown } | null)?.schedules;
  if (!Array.isArray(schedules)) return { exitCode: IDLE_EXIT.unreadable, why: "answered 200 with no list of schedules" };
  const crons: string[] = [];
  for (const s of schedules) {
    const cron = (s as { cron?: unknown } | null)?.cron;
    if (typeof cron !== "string" || cron === "") return { exitCode: IDLE_EXIT.unreadable, why: "answered 200 with a schedule that has no cron" };
    crons.push(cron);
  }
  return { crons };
}

/**
 * One secret's delete. A 404 is a secret already gone, because the step may run twice
 * (a re-run of the job, a run whose teardown already ran), and that is done, not failed.
 */
export function readDeleteSecret(status: number, bodyText: string): "deleted" | "absent" | { why: string } {
  if (status === 404) return "absent";
  const read = readEnvelope(status, bodyText);
  if ("exitCode" in read) return { why: read.why };
  return "deleted";
}

type VerdictInput =
  | { misconfigured: string[] }
  | { wrongTarget: string }
  | { noAnswer: string }
  | { read: ReadFailure }
  | {
      workerName: string;
      remaining: string[];
      crons: string[];
      deleted: string[];
      failedDeletes: { name: string; why: string }[];
    };

const NOTHING = "Nothing was deleted.";

/** The teardown's verdict, worst first. */
export function idleVerdict(input: VerdictInput): IdleVerdict {
  if ("misconfigured" in input) {
    return {
      idle: false,
      exitCode: IDLE_EXIT.misconfigured,
      message: `This runner has no ${input.misconfigured.join(", ")}, so the load test Worker was not touched. ${NOTHING}`,
    };
  }
  if ("wrongTarget" in input) {
    return { idle: false, exitCode: IDLE_EXIT.wrongTarget, message: `Refusing to touch any Worker: ${input.wrongTarget}. ${NOTHING}` };
  }
  if ("noAnswer" in input) {
    return {
      idle: false,
      exitCode: IDLE_EXIT.noAnswer,
      message: `Cloudflare never answered (${input.noAnswer}), so whether the load test Worker is idle is UNKNOWN.`,
    };
  }
  if ("read" in input) {
    return {
      idle: false,
      exitCode: input.read.exitCode,
      message: `The load test Worker's secrets or schedules ${input.read.why}, so whether it is idle is UNKNOWN.`,
    };
  }
  const { workerName, remaining, crons, deleted, failedDeletes } = input;
  if (failedDeletes.length > 0) {
    return {
      idle: false,
      exitCode: IDLE_EXIT.deleteFailed,
      message:
        `${workerName} could not have ${failedDeletes.map((f) => `${f.name} (${f.why})`).join(", ")} deleted` +
        (remaining.length > 0 ? `, and still holds ${remaining.join(", ")}` : "") +
        ". Delete them by hand with `wrangler secret delete <NAME> --env loadtest` and run this again.",
    };
  }
  if (remaining.length > 0) {
    return {
      idle: false,
      exitCode: IDLE_EXIT.stillHoldsSecrets,
      message:
        `${workerName} still holds ${remaining.join(", ")} after every delete answered, so it is NOT idle. ` +
        "Delete them by hand with `wrangler secret delete <NAME> --env loadtest` and run this again.",
    };
  }
  if (crons.length === 0) {
    return {
      idle: false,
      exitCode: IDLE_EXIT.noSchedules,
      message:
        `${workerName} holds no secrets but has no cron schedules, so keeping it bought nothing: the next run waits ` +
        "for a first delivery again. Redeploy it with `wrangler deploy --env loadtest` to put its schedules back.",
    };
  }
  return {
    idle: true,
    exitCode: IDLE_EXIT.idle,
    message:
      `${workerName} is kept idle: it holds no secrets (${deleted.length === 0 ? "none were left to delete" : `deleted ${deleted.join(", ")}`}) ` +
      `and keeps its ${crons.length} cron schedules, so the next run's lanes start within a minute of its secrets being put.`,
  };
}

/** One request's outcome: the status and body text, or the error that stopped it. */
export type CallResult = { status: number; bodyText: string } | { failed: string };

/**
 * The whole teardown, with the request injected so its ORDER is tested against a fake
 * Cloudflare, not only each judgement.
 *
 * The first listing only widens what is deleted: a secret nobody expected is deleted
 * too. It never gates the deletes. A first listing that cannot be read must not leave
 * the Worker holding a run's live secrets while its crons keep arriving, so the three a
 * run puts are always attempted, and the SECOND listing, after the deletes, is what
 * decides. A delete that fails does not stop the others.
 */
export async function keepWorkerIdle(args: {
  settings: { token: string; account: string; configured: string };
  wranglerJsonc: string | null;
  call: (method: "GET" | "DELETE", url: string) => Promise<CallResult>;
}): Promise<IdleVerdict> {
  const { token, account, configured } = args.settings;
  const missing: string[] = [];
  if (!token) missing.push("CLOUDFLARE_API_TOKEN");
  if (!account) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (!configured) missing.push("LOADTEST_WORKER_NAME");
  if (missing.length > 0) return idleVerdict({ misconfigured: missing });

  const names = args.wranglerJsonc === null ? null : loadtestWorkerName(args.wranglerJsonc);
  const refusal = targetRefusal({ configured, names });
  if (refusal !== null || names === null) return idleVerdict({ wrongTarget: refusal ?? "no load test Worker name" });
  const workerName = names.loadtest;

  const before = await args.call("GET", secretsUrl(account, workerName));
  const listed = "failed" in before ? null : readSecretNames(before.status, before.bodyText);
  const extra = listed !== null && "names" in listed ? listed.names : [];

  const deleted: string[] = [];
  const failedDeletes: { name: string; why: string }[] = [];
  for (const name of [...new Set([...extra, ...LOADTEST_ALLOWED_SECRETS])]) {
    const res = await args.call("DELETE", secretUrl(account, workerName, name));
    if ("failed" in res) {
      failedDeletes.push({ name, why: `no answer, ${res.failed}` });
      continue;
    }
    const outcome = readDeleteSecret(res.status, res.bodyText);
    if (outcome === "deleted") deleted.push(name);
    else if (outcome !== "absent") failedDeletes.push({ name, why: outcome.why });
  }

  // Idle is what the Worker LISTS afterwards, never what the deletes answered.
  const after = await args.call("GET", secretsUrl(account, workerName));
  if ("failed" in after) return idleVerdict({ noAnswer: after.failed });
  const remaining = readSecretNames(after.status, after.bodyText);
  if ("exitCode" in remaining) return idleVerdict({ read: remaining });

  const sched = await args.call("GET", schedulesUrl(account, workerName));
  if ("failed" in sched) return idleVerdict({ noAnswer: sched.failed });
  const schedules = readSchedules(sched.status, sched.bodyText);
  if ("exitCode" in schedules) return idleVerdict({ read: schedules });

  return idleVerdict({ workerName, remaining: remaining.names, crons: schedules.crons, deleted, failedDeletes });
}
