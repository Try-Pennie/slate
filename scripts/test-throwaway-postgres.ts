// #3099: the throwaway Postgres helper's two offline decisions.
//
// The helper itself needs Docker and is exercised by every scripts/verify-*-sql.ts
// in .github/workflows/db-replay.yml. What can be pinned here without Docker is how
// it decides the container is ready (a premature "ready" makes the next statement
// meet a server that is shutting down) and the psql call a batch is sent through.
//
// Run: node --experimental-strip-types scripts/test-throwaway-postgres.ts
import { initFinished, psqlArgs, readiness } from "./lib/throwaway-postgres.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- readiness: only after the entrypoint says initialisation is over ----------------
{
  // The first phase, as the supabase/postgres image logs it: a server that already
  // accepts connections, which is the false ready this guards against.
  const firstPhase = "LOG:  database system is ready to accept connections\nrunning /docker-entrypoint-initdb.d/init-scripts/00-schema.sql";
  assert(!initFinished(firstPhase), "a server answering during the init scripts is not ready");
  const shuttingDown = `${firstPhase}\nLOG:  pg_cron scheduler shutting down\nFATAL:  the database system is shutting down`;
  assert(!initFinished(shuttingDown), "nor while the temporary server shuts down");
  assert(initFinished(`${shuttingDown}\n\nPostgreSQL init process complete; ready for start up.\n\nLOG:  database system is ready to accept connections`),
    "it is ready once the entrypoint has said init is complete");
  assert(!initFinished(""), "empty logs (a container that has not started logging) are not ready");
}

// --- a container that died during init is named as dead, with its own words -------------
{
  const alive = { logsStatus: 0, logsError: "", running: true, exitCode: 0 };
  eq(readiness({ ...alive, logs: "running init scripts" }).state, "initialising", "a live container still in its init scripts is initialising");
  eq(readiness({ ...alive, logs: "PostgreSQL init process complete; ready for start up." }).state, "initialised",
    "a live container past init is ready to be asked");

  const crashed = readiness({
    logsStatus: 0,
    logsError: "",
    logs: "line one\nFATAL:  could not create shared memory segment: No space left on device\n",
    running: false,
    exitCode: 1,
  });
  assert(crashed.state === "dead", "a container that exited during init is dead, not still initialising");
  if (crashed.state === "dead") {
    assert(/exited with code 1/.test(crashed.reason), `the reason gives the exit code (${crashed.reason})`);
    assert(/No space left on device/.test(crashed.reason), "and the container's own last log line, so the cause is named");
  }
  // Even a container that says init completed and then exited is dead, not ready.
  eq(readiness({ logsStatus: 0, logsError: "", logs: "PostgreSQL init process complete", running: false, exitCode: 137 }).state, "dead",
    "a container that finished init and then died is dead");

  const gone = readiness({ logsStatus: 1, logsError: "Error response from daemon: No such container: c1", logs: "", running: null, exitCode: null });
  assert(gone.state === "dead" && /No such container/.test(gone.reason),
    "a docker logs call that fails is not read as still initialising, and its error is passed on");
}

// --- the psql call ----------------------------------------------------------------------
{
  const plain = psqlArgs("c1");
  eq(plain.slice(0, 5), ["exec", "-i", "c1", "psql", "-U"], "a batch goes to psql inside the named container");
  assert(plain.includes("ON_ERROR_STOP=1"), "and stops at the first error, so a failed statement cannot pass for a run");
  assert(!plain.includes("--single-transaction"), "no transaction wrapper unless asked for");
  eq(plain.slice(-2), ["-f", "-"], "the batch is read from stdin");

  const replay = psqlArgs("c1", "anon", { singleTransaction: true });
  assert(replay.includes("--single-transaction"), "a migration runs as one transaction, as db push runs a file");
  const role = replay.indexOf("-c");
  assert(role > 0 && replay[role + 1] === "set role anon;" && role < replay.indexOf("-f"),
    "the role is set before the batch runs, so every statement in it runs as that role");
}

finish();
