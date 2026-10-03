// The sign-in domain gate fails CLOSED (#3083).
//
// `isAllowedEmail` treats an empty domain as "allow any Google account", which
// is the open PoC mode #589 kept. Before #3083 the value came from
// `process.env.GOOGLE_HOSTED_DOMAIN ?? ""`, so a deploy that lost the var (a
// renamed key, a dropped vars block, an env section that forgot it) opened
// sign-in to every Google account, and the callback provisions each one as an
// agent. Nothing pinned the var either: wrangler.jsonc set it and no test read it.
//
// Two halves, each blind where the other looks:
//   - the RESOLVER refuses an unset domain unless ALLOW_ANY_GOOGLE_DOMAIN=1 says
//     the open mode is deliberate, so a missing var is a refused sign-in and a
//     log line rather than an open door;
//   - the CONFIG, as wrangler resolves it for every environment the file
//     declares, carries trypennie.com and never the escape hatch.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-hosted-domain-required.ts
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";
import {
  resolveHostedDomain,
  HostedDomainMissingError,
  isAllowedEmail,
} from "../src/lib/auth/domain.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DOMAIN = "trypennie.com";
const CONFIG = "wrangler.jsonc";

// --- the resolver ---------------------------------------------------------------

function refuses(env: Record<string, string | undefined>, label: string): void {
  let refused = false;
  try {
    resolveHostedDomain(env);
  } catch (err) {
    refused = err instanceof HostedDomainMissingError;
  }
  assert(refused, `${label}: refuses with HostedDomainMissingError`);
}

refuses({}, "unset");
refuses({ GOOGLE_HOSTED_DOMAIN: "" }, "empty");
refuses({ GOOGLE_HOSTED_DOMAIN: "   " }, "whitespace only");
// Only the exact opt-in opens it: a truthy-looking value nobody meant is not consent.
refuses({ ALLOW_ANY_GOOGLE_DOMAIN: "true" }, "an opt-in spelled other than 1");
refuses({ ALLOW_ANY_GOOGLE_DOMAIN: "0" }, "an opt-in of 0");

eq(resolveHostedDomain({ GOOGLE_HOSTED_DOMAIN: DOMAIN }), DOMAIN, "a set domain is returned");
eq(
  resolveHostedDomain({ GOOGLE_HOSTED_DOMAIN: ` ${DOMAIN} ` }),
  DOMAIN,
  "surrounding space is trimmed",
);
eq(resolveHostedDomain({ ALLOW_ANY_GOOGLE_DOMAIN: "1" }), "", "the explicit opt-in allows any account");
eq(
  resolveHostedDomain({ GOOGLE_HOSTED_DOMAIN: DOMAIN, ALLOW_ANY_GOOGLE_DOMAIN: "1" }),
  DOMAIN,
  "a configured domain wins over the opt-in, so the flag can only ever widen an unset gate",
);

// The resolved domain still does its job, so a resolver that returned the right
// string to a gate that ignored it cannot pass.
const resolved = resolveHostedDomain({ GOOGLE_HOSTED_DOMAIN: DOMAIN });
assert(isAllowedEmail(`a@${DOMAIN}`, resolved), "an in-domain email is allowed");
assert(!isAllowedEmail("a@gmail.com", resolved), "an outside email is refused");

// --- the config, as wrangler resolves it ----------------------------------------

type Resolved = { vars?: Record<string, unknown> };
const raw = experimental_readRawConfig({ config: CONFIG }).rawConfig as {
  env?: Record<string, unknown>;
};
const envNames = Object.keys(raw.env ?? {});
// Positive control on the enumeration: the file is known to declare a loadtest
// environment, so an enumeration that found none read the wrong thing.
assert(envNames.includes("loadtest"), "the env enumeration finds the declared loadtest environment");

for (const name of [undefined, ...envNames]) {
  const label = name ? `env.${name}` : "production (top level)";
  const vars = (unstable_readConfig({ config: CONFIG, env: name }) as unknown as Resolved).vars ?? {};
  eq(vars.GOOGLE_HOSTED_DOMAIN, DOMAIN, `${label} sets GOOGLE_HOSTED_DOMAIN to ${DOMAIN}`);
  eq(vars.NEXT_PUBLIC_GOOGLE_HOSTED_DOMAIN, DOMAIN, `${label} sets the login page hint to ${DOMAIN}`);
  assert(!("ALLOW_ANY_GOOGLE_DOMAIN" in vars), `${label} does not carry the allow-any escape hatch`);
  // And the resolver, fed exactly what that environment carries, lands on the domain.
  const asEnv = Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [k, typeof v === "string" ? v : undefined]),
  );
  eq(resolveHostedDomain(asEnv), DOMAIN, `${label} resolves to ${DOMAIN} through the real resolver`);
}

finish();
