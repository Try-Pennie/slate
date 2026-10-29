// #3082, #4379: the before_user_created gate, proved against the REAL auth server and the
// REAL users table.
//
// The offline suite (scripts/test-auth-domain-hook.ts) proves the migration, the local
// config and the app's domain agree as TEXT. It cannot prove that GoTrue calls the
// function, reads its reply as a refusal, and creates no account, and a mocked auth server
// would agree with whatever it was told (L52). Since #4379 the hook also READS
// public.users (an invited coordinator may be created through Microsoft), so it is proved
// on the schema production has: Supabase's own Postgres image, which carries the
// platform's default grants to anon and authenticated (L714), with EVERY migration
// replayed into it the way `supabase db push` applies them, row level security and all.
// Then Supabase's own auth server runs against it with the hook registered exactly as
// config.toml does.
//
// What is proved:
//
//   - THE EVENT GoTrue really sends. A capture hook records the payload of a real signup,
//     so the azure cases below are that same payload with the provider changed, never a
//     shape somebody remembered (L620): the provider is read where GoTrue puts it.
//   - THE RULE, asked of the function as GoTrue's own role, against seeded rows: an
//     invited coordinator through azure is allowed (in any letter case); an uninvited
//     address, a deactivated coordinator, an already linked one, the invited address
//     through the email provider, trypennie.com through azure and through email are all
//     refused; trypennie.com through google is allowed.
//   - THROUGH THE AUTH SERVER: with the hook on, the invited coordinator's address, a
//     trypennie.com address and an outsider each sign up through email and are refused
//     with 403 and no auth.users row. The CONTROL: the same outsider signs up with the
//     hook off, so the refusals were the hook's (L1, L159).
//   - users_outside_email_is_coordinator refuses an outside address on any other role.
//   - auth_logins_by_provider reads the sign in GoTrue really writes: a password sign in
//     made here comes back as provider `email` with its address, through service_role.
//   - Who may execute: anon and authenticated may run neither function;
//     supabase_auth_admin runs the hook and service_role the audit read.
//
// It writes nothing outside its own containers, which it removes on the way out. Not
// named test-*.ts: that glob is the offline unit suite, and this needs Docker. No Docker,
// a container that will not start, or an image without the platform's default grants is
// exit 2, never a pass (L98, L411).
//
// Run: pnpm verify:auth-domain-hook
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { findAuthHookMigration } from "./lib/auth-domain-hook-wiring.ts";
import { startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import {
  CLI_HISTORY_TABLE_SQL,
  judgeDefaultGrants,
  migrationPlan,
  replayMigrations,
} from "./lib/migration-replay.ts";

const ROOT = join(import.meta.dirname, "..");
// Overridable only so the run can be pointed at a scratch copy, which is how this suite
// was seen to FAIL on the tree before #4379 (the azure cases refused by 0159's hook).
const MIGRATIONS = process.env.AUTH_HOOK_MIGRATIONS_DIR || join(ROOT, "supabase", "migrations");
// Found by what it defines, the same way the offline test finds it. None is a refusal,
// exit 1, before any container starts: it is a fault in the tree, not a missing Docker.
const names = readdirSync(MIGRATIONS);
const found = findAuthHookMigration(
  names.filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") })),
);
if ("refusal" in found) {
  console.error(`REFUSED: ${found.refusal}. There is no hook to prove, so nothing was run.`);
  process.exit(1);
}
const plan = migrationPlan(names);
if (!plan.ok) {
  console.error(`REFUSED: ${plan.error}`);
  process.exit(1);
}
const PG_IMAGE = process.env.AUTH_HOOK_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const AUTH_IMAGE = process.env.AUTH_HOOK_GOTRUE_IMAGE ?? "public.ecr.aws/supabase/gotrue:v2.196.0";
const HOOK_URI = "pg-functions://postgres/public/before_user_created_domain_gate";
const CAPTURE_URI = "pg-functions://postgres/public/verify_capture_before_user_created";
const TAG = `slate-auth-hook-${process.pid}`;
const NET = TAG;
const DB = `${TAG}-db`;
const AUTH = `${TAG}-auth`;
const PORT = 40000 + (process.pid % 20000);

function docker(args: string[], input?: string): string {
  return execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function sleep(seconds: number): void {
  execFileSync("sleep", [String(seconds)]);
}

const pg = startThrowawayPostgres(DB, PG_IMAGE);
const { sql, sqlError } = pg;

function cleanup(): void {
  for (const args of [["rm", "-f", AUTH], ["network", "rm", NET]]) {
    try {
      docker(args);
    } catch {
      // Already gone.
    }
  }
  pg.stop();
}

function unmeasured(why: string): never {
  cleanup();
  console.error(`UNMEASURED: ${why}, so nothing was proved.`);
  process.exit(2);
}

/** Start the auth server with a hook (or none), and wait until it answers. */
async function startAuth(hookUri: string | null): Promise<void> {
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
    "-e", `GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED=${hookUri !== null}`,
    "-e", `GOTRUE_HOOK_BEFORE_USER_CREATED_URI=${hookUri ?? HOOK_URI}`,
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

async function passwordSignIn(email: string): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${PORT}/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "a-throwaway-password-1" }),
  });
  await r.text();
  return r.status;
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const usersWith = (email: string) => sql(`select count(*) from auth.users where lower(email) = lower(${q(email)});`);

/** One batch as the image's true superuser, the only role that may become GoTrue's. */
const superSql = (text: string): string =>
  docker(["exec", "-i", DB, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtAX", "-f", "-"], text);

/** The hook's answer to one event, asked as the role GoTrue runs it as. */
const ask = (event: unknown) =>
  superSql(`set role supabase_auth_admin; select public.before_user_created_domain_gate(${q(JSON.stringify(event))}::jsonb)::text;`);
const allowed = (reply: string) => reply === "{}";
const refused = (reply: string) => /"http_code": 403/.test(reply);

const ORG = "00000000-0000-4000-8000-000000000001";
const INVITED = "Dana.Coordinator@Partner.example";
const LINKED_AUTH = "00000000-0000-4000-8000-0000000000aa";

try {
  // --- the precondition: the platform's default grants are really here ------------
  const acl = sql(`select pg_get_userbyid(defaclrole), defaclnamespace::regnamespace::text, defaclobjtype::text, defaclacl::text from pg_default_acl;`)
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("|"))
    .map(([owner, schema, type, a]) => ({ owner: owner ?? "", schema: schema ?? "", type: type ?? "", acl: a ?? "" }));
  const missingGrants = judgeDefaultGrants(acl);
  if (missingGrants.length > 0) unmeasured(`${PG_IMAGE} lacks the platform's default grants (${missingGrants.join("; ")})`);

  // --- every migration, as db push applies them ------------------------------------
  sql(CLI_HISTORY_TABLE_SQL);
  const applied = replayMigrations(
    plan.files,
    (file) => readFileSync(join(MIGRATIONS, file), "utf8"),
    (batch) => void sql(batch, undefined, { singleTransaction: true }),
  );
  eq(applied, plan.files.length, `every migration applied to an empty database, the hook from ${found.file}`);
  eq(sql("select relrowsecurity from pg_class where oid = 'public.users'::regclass;"), "t", "the users table the hook reads has row level security on");

  // The image creates supabase_auth_admin with no usable password; the hosted project and
  // the CLI's local stack both set one, which is all this does.
  // As the image's true superuser, since `postgres` may not alter that role.
  superSql("alter role supabase_auth_admin with password 'postgres';");
  try {
    docker(["network", "create", NET]);
    docker(["network", "connect", "--alias", DB, NET, DB]);
  } catch (err) {
    unmeasured(`the Docker network could not be made (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
  }

  // --- the seeded roster the rule reads ---------------------------------------------
  sql(`
    insert into organizations (id, name, is_default) values ('${ORG}', 'Pennie', true);
    insert into auth.users (id, email) values ('${LINKED_AUTH}', 'already.linked@partner.example');
    insert into users (org_id, email, role, bookable) values
      ('${ORG}', ${q(INVITED.toLowerCase())}, 'coordinator', false),
      ('${ORG}', 'left.already@partner.example', 'coordinator', false),
      ('${ORG}', 'staff.person@trypennie.com', 'agent', false);
    update users set deactivated_at = now() where email = 'left.already@partner.example';
    insert into users (org_id, email, role, bookable, auth_user_id)
      values ('${ORG}', 'already.linked@partner.example', 'coordinator', false, '${LINKED_AUTH}');
  `);

  // --- users_outside_email_is_coordinator --------------------------------------------
  for (const role of ["agent", "manager", "admin"]) {
    const why = sqlError(`insert into users (org_id, email, role, bookable) values ('${ORG}', 'outside.${role}@partner.example', '${role}', false);`) ?? "";
    assert(/users_outside_email_is_coordinator/.test(why), `an outside address as ${role} is refused by users_outside_email_is_coordinator`);
  }
  eq(
    sqlError(`insert into users (org_id, email, role, bookable) values ('${ORG}', 'second.coordinator@partner.example', 'coordinator', false);`),
    null,
    "control: an outside address as a coordinator is accepted",
  );

  // --- who can execute -----------------------------------------------------------------
  const probe = `select public.before_user_created_domain_gate('{"user":{"email":"a@trypennie.com","app_metadata":{"provider":"google"}}}'::jsonb);`;
  const audit = `select public.auth_logins_by_provider(now() - interval '1 hour');`;
  for (const role of ["anon", "authenticated"]) {
    assert(/permission denied for function before_user_created_domain_gate/.test(sqlError(probe, role) ?? ""), `${role} cannot execute the hook`);
    assert(/permission denied for function auth_logins_by_provider/.test(sqlError(audit, role) ?? ""), `${role} cannot execute the audit read`);
  }
  eq(sqlError(audit, "service_role"), null, "service_role can execute the audit read, as the Worker's secret key client");

  // --- the event GoTrue really sends -------------------------------------------------
  sql(`
    create table public.verify_captured_events (event jsonb not null);
    alter table public.verify_captured_events enable row level security;
    create function public.verify_capture_before_user_created(event jsonb) returns jsonb
      language plpgsql security definer set search_path = pg_catalog as $$
      begin insert into public.verify_captured_events values (event); return '{}'::jsonb; end; $$;
    grant execute on function public.verify_capture_before_user_created(jsonb) to supabase_auth_admin;
  `);
  await startAuth(CAPTURE_URI);
  const captureSignup = await signup("capture.probe@trypennie.com");
  eq(captureSignup.status, 200, "the capture hook's empty reply lets the signup through, as the gate's allowed reply does");
  const captured = JSON.parse(sql("select event::text from public.verify_captured_events limit 1;") || "null") as {
    user?: { email?: string; app_metadata?: { provider?: string } };
  } | null;
  eq(captured?.user?.app_metadata?.provider, "email", "GoTrue sends the provider at user.app_metadata.provider, where the gate reads it");
  eq(captured?.user?.email, "capture.probe@trypennie.com", "and the address at user.email");
  const as = (email: string, provider: string) => ({
    ...captured,
    user: { ...captured?.user, email, app_metadata: { ...captured?.user?.app_metadata, provider, providers: [provider] } },
  });

  // --- the rule, asked as GoTrue's own role --------------------------------------------
  assert(allowed(ask(as(INVITED.toLowerCase(), "azure"))), "an invited coordinator through azure is allowed");
  assert(allowed(ask(as(INVITED, "azure"))), "and in any letter case, since the address is compared lowercased");
  assert(refused(ask(as("nobody.invited@partner.example", "azure"))), "an uninvited address through azure is refused");
  assert(refused(ask(as("left.already@partner.example", "azure"))), "a deactivated coordinator through azure is refused");
  assert(refused(ask(as("already.linked@partner.example", "azure"))), "a coordinator already linked to a sign in is refused");
  assert(refused(ask(as(INVITED.toLowerCase(), "email"))), "the invited address through the email provider is refused");
  assert(refused(ask(as(INVITED.toLowerCase(), "google"))), "the invited address through google is refused");
  assert(refused(ask(as("staff.person@trypennie.com", "azure"))), "a trypennie.com address through azure is refused");
  assert(refused(ask(as("staff.person@trypennie.com", "email"))), "a trypennie.com address through email is refused");
  assert(allowed(ask(as("staff.person@trypennie.com", "google"))), "a trypennie.com address through google is allowed");
  assert(allowed(ask(as("Someone.New@TryPennie.com", "google"))), "and so is a new staff address in mixed case");
  assert(refused(ask(as("someone@evil.trypennie.com", "google"))), "a subdomain lookalike through google is refused");
  assert(refused(ask(as("someone@trypennie.com.evil.com", "azure"))), "a suffix lookalike through azure is refused");

  // --- through the auth server, with the gate on --------------------------------------
  await startAuth(HOOK_URI);
  for (const email of [INVITED, "Verify.Probe@TryPennie.com", "outsider@example.com", "someone@evil.trypennie.com"]) {
    const r = await signup(email);
    eq(r.status, 403, `${email} through the email provider is refused by the auth server`);
    assert(/Slate accepts|Pennie staff sign in/.test(r.body), `${email} is refused with the hook's own message`);
    eq(usersWith(email), "0", `${email} leaves no auth.users row`);
  }

  // --- the control: the same outsider with no gate, and the audit read ----------------
  await startAuth(null);
  const control = await signup("outsider@example.com");
  eq(control.status, 200, "control: with no hook the same outside address signs up, so the refusals were the hook's");
  eq(await passwordSignIn("outsider@example.com"), 200, "and signs in with a password, which the audit log records");
  const reading = JSON.parse(sql(audit, "service_role")) as {
    entries: number;
    logins: { provider: string; logins: number; actors: string[] }[];
  };
  assert(reading.entries > 0, `the audit read counts the entries GoTrue wrote in the window (${reading.entries})`);
  const byEmail = reading.logins.find((l) => l.provider === "email");
  assert(Boolean(byEmail && byEmail.logins >= 1), "a password sign in comes back as a login through provider email");
  assert(Boolean(byEmail?.actors.includes("outsider@example.com")), "naming the address that signed in");
} catch (err) {
  assert(false, `the run threw: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  cleanup();
}

finish();
