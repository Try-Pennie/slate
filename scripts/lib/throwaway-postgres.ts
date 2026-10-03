// A throwaway Postgres in Docker, for the verify commands that prove a migration in
// a real database (#3026, #3027). One copy of the start, the readiness wait, the
// psql call and the clean up, so each command is only its own schema and checks.
//
// No Docker, or a container that cannot start, exits 2 UNMEASURED: it proved
// nothing about the migration, so it is never a pass and never the failed check
// exit either (L98, L411).
import { execFileSync } from "node:child_process";

export interface ThrowawayPostgres {
  /** The container name, for a caller that drives psql itself. */
  name: string;
  /** One statement batch through psql, ON_ERROR_STOP, tuples only. Throws on an error. */
  sql(text: string, role?: string): string;
  /** Run a statement expected to FAIL, returning the error text (or null if it succeeded). */
  sqlError(text: string, role?: string): string | null;
  /** Remove the container. */
  stop(): void;
}

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
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
  const sql = (text: string, role?: string): string =>
    docker(
      ["exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qtAX", ...(role ? ["-c", `set role ${role};`] : []), "-f", "-"],
      text,
    ).trim();
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
    stop() {
      try {
        docker(["rm", "-f", name]);
      } catch {
        // Already gone.
      }
    },
  };
  for (let i = 0; i < 60; i++) {
    try {
      sql("select 1;");
      return pg;
    } catch {
      execFileSync("sleep", ["1"]);
    }
  }
  pg.stop();
  throw new Error("the throwaway Postgres never accepted a connection");
}
