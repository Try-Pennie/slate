// #3099: the throwaway Postgres helper's two offline decisions.
//
// The helper itself needs Docker and is exercised by every scripts/verify-*-sql.ts
// in .github/workflows/db-replay.yml. What can be pinned here without Docker is how
// it decides the container is ready (a premature "ready" makes the next statement
// meet a server that is shutting down) and the psql call a batch is sent through.
//
// Run: node --experimental-strip-types scripts/test-throwaway-postgres.ts
import { initFinished, psqlArgs } from "./lib/throwaway-postgres.ts";
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
