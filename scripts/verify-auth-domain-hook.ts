// #3082: the before_user_created domain gate, proved against the REAL auth server.
//
// The offline suite (scripts/test-auth-domain-hook.ts) proves the migration, the
// local config and the app's domain agree as TEXT. It cannot prove that GoTrue
// calls the function, reads its reply as a refusal, and creates no account, and a
// mocked auth server would agree with whatever it was told (L52). So this starts
// Supabase's own Postgres image and Supabase's own auth server in Docker, applies
// migration 0158 VERBATIM, registers the hook exactly as config.toml does, and
// signs up through the auth API:
//
//   - an outside address, a subdomain and a suffix lookalike are each refused
//     with 403 and leave no auth.users row;
//   - a trypennie.com address (in mixed case) is created;
//   - the CONTROL: the same outside address signs up fine with the hook switched
//     off, so the refusals above are the hook's and not something else refusing
//     every signup (L1, L159);
//   - anon and authenticated cannot execute the function; supabase_auth_admin can.
//
// It signs up through the email route because that is the one an auth API call
// can drive without a browser. The hook runs for EVERY way an account is created
// (Google included), which is what makes one function the gate for all of them.
//
// It writes nothing outside its own containers, which it removes on the way out.
// Deliberately not named test-*.ts: that glob is the offline unit suite, and this
// needs Docker. No Docker, or a container that will not start, is exit 2, never a
// pass (L98, L411).
//
// Run: pnpm verify:auth-domain-hook
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = readFileSync(join(ROOT, "supabase", "migrations", "0158_auth_domain_gate_hook.sql"), "utf8");
const PG_IMAGE = process.env.AUTH_HOOK_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const AUTH_IMAGE = process.env.AUTH_HOOK_GOTRUE_IMAGE ?? "public.ecr.aws/supabase/gotrue:v2.196.0";
const HOOK_URI = "pg-functions://postgres/public/before_user_created_domain_gate";
const TAG = `slate-auth-hook-${process.pid}`;
const NET = TAG;
const DB = `${TAG}-db`;
const AUTH = `${TAG}-auth`;
const PORT = 40000 + (process.pid % 20000);

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function sql(text: string, user = "postgres"): string {
  return docker(["exec", "-i", DB, "psql", "-h", "localhost", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtAX", "-f", "-"], text);
}

function sqlError(text: string, user = "postgres"): string | null {
  try {
    sql(text, user);
    return null;
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

function sleep(seconds: number): void {
  execFileSync("sleep", [String(seconds)]);
}

function unmeasured(why: string): never {
  cleanup();
  console.error(`UNMEASURED: ${why}, so nothing was proved.`);
  process.exit(2);
}

function cleanup(): void {
  for (const args of [["rm", "-f", AUTH], ["rm", "-f", DB], ["network", "rm", NET]]) {
    try {
      docker(args);
    } catch {
      // Already gone.
    }
  }
}

/** Start the auth server with the hook on or off, and wait until it answers. */
async function startAuth(hook: boolean): Promise<void> {
  try {
    docker(["rm", "-f", AUTH]);
  } catch {
    // Not running yet.
  }
  docker([
    "run", "-d", "--name", AUTH, "--network", NET, "-p", `127.0.0.1:${PORT}:9999`,
    "-e", "GOTRUE_API_HOST=0.0.0.0",
    "-e", "PORT=9999",
    "-e", `API_EXTERNAL_URL=http://localhost:${PORT}`,
    "-e", "GOTRUE_SITE_URL=http://localhost:3000",
    "-e", "GOTRUE_DB_DRIVER=postgres",
    "-e", `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:postgres@${DB}:5432/postgres`,
    "-e", "GOTRUE_JWT_SECRET=a-throwaway-jwt-secret-of-at-least-32-characters",
    "-e", "GOTRUE_JWT_AUD=authenticated",
    "-e", "GOTRUE_EXTERNAL_EMAIL_ENABLED=true",
    "-e", "GOTRUE_MAILER_AUTOCONFIRM=true",
    "-e", "GOTRUE_DISABLE_SIGNUP=false",
    "-e", `GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED=${hook}`,
    "-e", `GOTRUE_HOOK_BEFORE_USER_CREATED_URI=${HOOK_URI}`,
    AUTH_IMAGE,
  ]);
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {
      // Not listening yet.
    }
    sleep(1);
  }
  unmeasured(`the auth server never answered (${docker(["logs", "--tail", "3", AUTH]).split("\n").pop()})`);
}

async function signup(email: string): Promise<{ status: number; body: string }> {
  const r = await fetch(`http://127.0.0.1:${PORT}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "a-throwaway-password-1" }),
  });
  return { status: r.status, body: await r.text() };
}

const usersWith = (email: string) =>
  sql(`select count(*) from auth.users where lower(email) = lower('${email.replace(/'/g, "''")}');`);

try {
  docker(["version", "--format", "{{.Server.Version}}"]);
} catch {
  console.error("UNMEASURED: Docker is not available here, so nothing was proved.");
  process.exit(2);
}

try {
  try {
    docker(["network", "create", NET]);
    docker(["run", "-d", "--name", DB, "--network", NET, "-e", "POSTGRES_PASSWORD=postgres", PG_IMAGE]);
  } catch (err) {
    unmeasured(`the ${PG_IMAGE} container could not start (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
  }
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      sql("select 1;");
      ready = true;
    } catch {
      sleep(1);
    }
  }
  if (!ready) unmeasured("the Postgres container never accepted a connection");

  // The image creates supabase_auth_admin with no usable password; the hosted
  // project and the CLI's local stack both set one, which is all this does.
  sql("alter role supabase_auth_admin with password 'postgres';", "supabase_admin");
  sql(MIGRATION);

  // --- who can execute it ---------------------------------------------------
  const call = `select public.before_user_created_domain_gate('{"user":{"email":"a@trypennie.com"}}'::jsonb);`;
  // As the superuser, so SET ROLE itself can never be what refuses; the message is
  // matched so a refusal for any other reason does not read as the revoke (L140).
  for (const role of ["anon", "authenticated"]) {
    const refused = sqlError(`set role ${role}; ${call}`, "supabase_admin") ?? "";
    assert(/permission denied for function before_user_created_domain_gate/.test(refused), `${role} cannot execute the hook`);
  }
  eq(sql(`set role supabase_auth_admin; ${call}`, "supabase_admin"), "{}", "supabase_auth_admin can, and a Workspace address is allowed");

  // --- the hook on ----------------------------------------------------------
  await startAuth(true);
  for (const email of ["outsider@example.com", "someone@evil.trypennie.com", "someone@trypennie.com.evil.com"]) {
    const r = await signup(email);
    eq(r.status, 403, `${email} is refused by the auth server`);
    assert(/trypennie\.com Google accounts only/.test(r.body), `${email} is refused with the hook's own message`);
    eq(usersWith(email), "0", `${email} leaves no auth.users row`);
  }
  const staff = await signup("Verify.Probe@TryPennie.com");
  eq(staff.status, 200, "a trypennie.com address in mixed case is created");
  eq(usersWith("verify.probe@trypennie.com"), "1", "and its auth.users row exists");

  // --- the control: the same outsider with the hook off ----------------------
  await startAuth(false);
  const control = await signup("outsider@example.com");
  eq(control.status, 200, "control: with the hook off the same outside address signs up, so the refusals were the hook's");
} catch (err) {
  assert(false, `the run threw: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  cleanup();
}

finish();
