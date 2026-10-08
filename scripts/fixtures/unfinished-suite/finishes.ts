// #3520 fixture, never run as a suite (not named test-*.ts): the positive control, a
// suite that awaits something that does settle and reaches finish().
import { assert, finish } from "../../lib/harness.ts";

async function main() {
  assert(true, "the one assertion");
  await new Promise((resolve) => setTimeout(resolve, 10));
}

main().then(() => finish());
