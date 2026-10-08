// #3520 fixture, never run as a suite (not named test-*.ts): a suite on the shared
// harness that stops on an await that never settles, so it never reaches finish().
import { assert, finish } from "../../lib/harness.ts";

async function main() {
  assert(true, "the one assertion before the stop");
  await new Promise(() => {});
  assert(false, "never reached");
}

main().then(() => finish());
