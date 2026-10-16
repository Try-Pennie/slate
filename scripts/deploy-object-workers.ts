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
// #3560: it also refuses to deploy a confirm line build that speaks an older
// CONFIRM_LINE_PROTOCOL than the app serving in that environment (a line only rollback),
// since a newer app beside an older line object books a crowd one advisor or none.
//
// Exit 0 when every Worker is deployed or proved unchanged, 1 when a needed deploy failed
// (nothing after it is attempted), 2 for an argument it does not know, 3 when the line
// was refused for being older than the app (nothing deployed).
import { appendFileSync } from "node:fs";
import { OBJECT_WORKER_CONFIGS } from "./lib/gradual-deploy.ts";
import { objectWorkerOps } from "./lib/object-worker-io.ts";
import { deployObjectWorkers, deployTargetLabel, uncheckedLineWarning } from "./lib/object-worker-skip.ts";

const args = process.argv.slice(2);
let env = "";
if (args.length === 2 && args[0] === "--env" && /^[a-z][a-z0-9-]*$/.test(args[1])) {
  env = args[1];
} else if (args.length !== 0) {
  console.error(`::error title=object worker deploy::unknown arguments ${JSON.stringify(args)}; the only one is --env <name>. Nothing was deployed.`);
  process.exit(2);
}

const result = await deployObjectWorkers(objectWorkerOps(env, (line) => console.log(`  ${line}`)), OBJECT_WORKER_CONFIGS);
const where = deployTargetLabel(env);
if (!result.ok && result.kind === "refused") {
  console.error(
    `::error title=confirm line older than the app::Nothing was deployed to ${where}: ${result.reason}. A newer app beside an older line object puts every confirm on its isolate's own line, where a crowd books one advisor or none. Deploy the line from a build at least as new as the app; for a revert that lowers the protocol on purpose, deploy the app first, then the line.`,
  );
  process.exit(3);
}
if (result.unchecked.length > 0) {
  // #3854: the same words as the gradual deploy, as an annotation and in the job summary
  // (the load run's arm job runs this), so a skipped check is never only in the log.
  const warning = uncheckedLineWarning(result.unchecked, where);
  console.warn(`::warning title=confirm line protocol not checked::${warning}`);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, `**Warning:** ${warning}\n`, "utf8");
}
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
