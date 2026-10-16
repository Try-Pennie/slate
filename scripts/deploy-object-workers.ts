// Deploy the object Workers Slate's bindings name (OBJECT_WORKER_CONFIGS), each one only
// when its bundle or config differs from the version serving (#3561). A Worker deploy
// restarts its Durable Objects, so an unchanged one is left running; every doubt deploys.
// Which Workers were skipped, and why, is printed.
//
// For the paths that deploy them outside the gradual deploy (which calls the same code
// in process): the hand deploy (scripts/deploy-verified.ts) and the load run's arm job.
//
//   node --experimental-strip-types scripts/deploy-object-workers.ts                 # production
//   node --experimental-strip-types scripts/deploy-object-workers.ts --env loadtest  # load test
//
// Exit 0 when every Worker is deployed or proved unchanged, 1 when a needed deploy failed
// (nothing after it is attempted), 2 for an argument it does not know.
import { OBJECT_WORKER_CONFIGS } from "./lib/gradual-deploy.ts";
import { objectWorkerOps } from "./lib/object-worker-io.ts";
import { deployObjectWorkers } from "./lib/object-worker-skip.ts";

const args = process.argv.slice(2);
let env = "";
if (args.length === 2 && args[0] === "--env" && /^[a-z][a-z0-9-]*$/.test(args[1])) {
  env = args[1];
} else if (args.length !== 0) {
  console.error(`::error title=object worker deploy::unknown arguments ${JSON.stringify(args)}; the only one is --env <name>. Nothing was deployed.`);
  process.exit(2);
}

const result = await deployObjectWorkers(objectWorkerOps(env, (line) => console.log(`  ${line}`)), OBJECT_WORKER_CONFIGS);
const where = env ? `the ${env} environment` : "production";
if (!result.ok) {
  console.error(
    `::error title=object worker deploy failed::${result.config} could not be deployed to ${where} (${result.reason}). Deployed: ${result.deployed.join(", ") || "none"}; unchanged and skipped: ${result.skipped.join(", ") || "none"}. Slate's bindings name it, so do not deploy Slate until it deploys.`,
  );
  process.exit(1);
}
if (result.unstamped.length > 0) {
  // Not a failure (the deploy worked), but the skip can never happen for these until it is.
  console.warn(
    `::warning title=object worker not stamped::${result.unstamped.join(", ")} deployed to ${where}, but the serving version does not read back as carrying this bundle's stamp, so the next deploy will redeploy it and restart its objects again.`,
  );
}
console.log(
  `\n  object workers in ${where}: deployed ${result.deployed.join(", ") || "none"}; unchanged and skipped ${result.skipped.join(", ") || "none"}\n`,
);
