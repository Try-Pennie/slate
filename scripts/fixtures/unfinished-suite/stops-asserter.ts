// #3520 fixture, never run as a suite (not named test-*.ts): the same stop, on the
// booking suites' asserter.
import { createAsserter } from "../../lib/booking-fakes.ts";

const { assert, finish } = createAsserter();

async function main() {
  assert(true, "the one assertion before the stop");
  await new Promise(() => {});
  assert(false, "never reached");
}

main().then(finish);
