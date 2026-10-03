// A throwaway Postgres in Docker, for the verify commands that prove a migration in
// a real database (#3026, #3027). One copy of the start, the readiness wait, the
// psql call and the clean up, so each command is only its own schema and checks.
//
// No Docker, or a container that cannot start, exits 2 UNMEASURED: it proved
// nothing about the migration, so it is never a pass and never the failed check
// exit either (L98, L411).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A migration file's SQL, verbatim, by file name, for applying to the throwaway database. */
export function readMigration(file: string): string {
  return readFileSync(join(import.meta.dirname, "..", "..", "supabase", "migrations", file), "utf8");
}

export interface ThrowawayPostgres {
  /** The container name, for a caller that drives psql itself. */
  name: string;
  /**
   * One statement batch through psql, ON_ERROR_STOP, tuples only. Throws on an error.
   * `singleTransaction` runs the whole batch as one transaction, as `db push` runs a file.
   */
  sql(text: string, role?: string, opts?: { singleTransaction?: boolean }): string;
  /** Run a statement expected to FAIL, returning the error text (or null if it succeeded). */
  sqlError(text: string, role?: string): string | null;
  /**
   * One psql session run CONCURRENTLY with the caller, for proving what two
   * transactions do to each other. Resolves with its exit code and stderr; never rejects.
   */
  session(text: string): Promise<{ code: number; stderr: string }>;
  /** Remove the container. */
  stop(): void;
}

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

/** The `docker exec ... psql` argument list for one batch read from stdin. */
export function psqlArgs(name: string, role?: string, opts?: { singleTransaction?: boolean }): string[] {
  return [
    "exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtAX",
    ...(opts?.singleTransaction ? ["--single-transaction"] : []),
    ...(role ? ["-c", `set role ${role};`] : []),
    "-f", "-",
  ];
}

/**
 * Whether the container's logs say initialisation is over. An image initialising a
 * fresh data directory answers on its socket WHILE its init scripts run, then stops
 * that server and starts the real one, so a `select 1` in the first phase reads as
 * ready and the next statement meets "the database system is shutting down". The
 * supabase/postgres image runs init scripts long enough to hit that every time
 * (#3099), so readiness waits for the entrypoint's own line first.
 */
export function initFinished(logs: string): boolean {
  return /PostgreSQL init process complete/.test(logs);
}

export interface ContainerProbe {
  /** `docker logs` exit status. */
  logsStatus: number | null;
  /** What `docker logs` itself said on failure. */
  logsError: string;
  /** The container's log, stdout and stderr together. */
  logs: string;
  /** `.State.Running`, or null when it could not be read. */
  running: boolean | null;
  exitCode: number | null;
}

export type Readiness = { state: "initialising" } | { state: "initialised" } | { state: "dead"; reason: string };

const lastLines = (text: string, n: number): string => text.trim().split("\n").slice(-n).join("\n  ");

/**
 * Where a starting container is. A container that exited, or one `docker logs` can no
 * longer find, is DEAD, never still initialising: reading it as initialising would
 * spin the whole readiness wait and then throw a message that names nothing. The
 * reason carries the container's own last log lines, which is where the cause is.
 */
export function readiness(p: ContainerProbe): Readiness {
  if (p.logsStatus !== 0) {
    return { state: "dead", reason: `docker logs failed: ${p.logsError.trim() || `exit ${String(p.logsStatus)}`}` };
  }
  if (p.running === false) {
    return { state: "dead", reason: `the container exited with code ${String(p.exitCode)}:\n  ${lastLines(p.logs, 5)}` };
  }
  return initFinished(p.logs) ? { state: "initialised" } : { state: "initialising" };
}

function probeContainer(name: string): ContainerProbe {
  const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
  const inspect = spawnSync("docker", ["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name], { encoding: "utf8" });
  const [running, exitCode] = (inspect.status === 0 ? inspect.stdout.trim() : "").split(" ");
  return {
    logsStatus: logs.status,
    logsError: logs.status === 0 ? "" : String(logs.stderr ?? logs.error ?? ""),
    logs: `${logs.stdout ?? ""}${logs.stderr ?? ""}`,
    running: running === "true" ? true : running === "false" ? false : null,
    exitCode: exitCode !== undefined && /^\d+$/.test(exitCode) ? Number(exitCode) : null,
  };
}

export function startThrowawayPostgres(name: string, image: string): ThrowawayPostgres {
  try {
    docker(["version", "--format", "{{.Server.Version}}"]);
  } catch {
    console.error("UNMEASURED: Docker is not available here, so nothing was proved.");
    process.exit(2);
  }
  try {
    // No --rm: a container that dies during init must keep its logs for readiness()
    // to read. stop() removes it on every path out.
    docker(["run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=x", image]);
  } catch (err) {
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.error(`UNMEASURED: the ${image} container could not start (${why}), so nothing was proved.`);
    process.exit(2);
  }
  const sql = (text: string, role?: string, opts?: { singleTransaction?: boolean }): string =>
    docker(psqlArgs(name, role, opts), text).trim();
  const pg: ThrowawayPostgres = {
    name,
    sql,
    sqlError(text, role) {
      try {
        sql(text, role);
        return null;
      } catch (err) {
        return String((err as { stderr?: string }).stderr ?? err);
      }
    },
    session(text) {
      return new Promise((resolve) => {
        const p = spawn("docker", ["exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtAX", "-f", "-"]);
        let stderr = "";
        p.stderr.on("data", (d) => (stderr += String(d)));
        p.on("error", (err) => resolve({ code: 1, stderr: String(err) }));
        p.on("close", (code) => resolve({ code: code ?? 1, stderr }));
        p.stdin.end(text);
      });
    },
    stop() {
      try {
        docker(["rm", "-f", name]);
      } catch {
        // Already gone.
      }
    },
  };
  let last: ContainerProbe | null = null;
  for (let i = 0; i < 90; i++) {
    last = probeContainer(name);
    const r = readiness(last);
    if (r.state === "dead") {
      // Not a finding about any migration: the database never came up, so nothing
      // was proved (exit 2), and the container's own words say why.
      console.error(`UNMEASURED: the ${image} container died during startup, so nothing was proved. ${r.reason}`);
      pg.stop();
      process.exit(2);
    }
    if (r.state === "initialised") {
      try {
        sql("select 1;");
        return pg;
      } catch {
        // Not accepting connections yet.
      }
    }
    execFileSync("sleep", ["1"]);
  }
  pg.stop();
  throw new Error(
    `the throwaway Postgres never accepted a connection in 90s; its last log lines:\n  ${lastLines(last?.logs ?? "", 5)}`,
  );
}
