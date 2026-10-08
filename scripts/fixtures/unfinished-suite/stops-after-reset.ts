// #3520 fixture, never run as a suite (not named test-*.ts): finish() called with an
// injected exit (as the harness's own test does), then resetHarness(), then a stop. The
// reset must arm the guard again, or one injected finish disarms it for the process.
import { assert, finish, resetHarness } from "../../lib/harness.ts";

finish(() => {});
resetHarness();

async function main() {
  assert(true, "the one assertion before the stop");
  await new Promise(() => {});
}

main().then(() => finish());
