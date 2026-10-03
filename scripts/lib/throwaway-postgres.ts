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

export function startThrowawayPostgres(name: string, image: string): ThrowawayPostgres {
  try {
    docker(["version", "--format", "{{.Server.Version}}"]);
  } catch {
    console.error("UNMEASURED: Docker is not available here, so nothing was proved.");
    process.exit(2);
  }
  try {
    docker(["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=x", image]);
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
  const initialised = (): boolean => {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    return initFinished(`${logs.stdout ?? ""}${logs.stderr ?? ""}`);
  };
  for (let i = 0; i < 90; i++) {
    try {
      if (!initialised()) throw new Error("still initialising");
      sql("select 1;");
      return pg;
    } catch {
      execFileSync("sleep", ["1"]);
    }
  }
  pg.stop();
  throw new Error("the throwaway Postgres never accepted a connection");
}
