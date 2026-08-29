// The shared alerter contract is itself a guard, so it has to have been SEEN to
// fail (#1596, L1).
//
// scripts/lib/alerter-contract.ts holds assertions that used to sit, word for
// word, in both alerter suites. Moving them somewhere shared makes one new
// failure possible that was not possible before: the helper going vacuous. A
// helper that asserts nothing and a helper whose assertions all passed produce
// the same silent success in both callers (L98), and because it is now the only
// copy, both alerters would lose the same coverage at once.
//
// So the helper is driven here against deliberately broken alerters and required
// to catch each one, through an `assert` this file supplies and records rather
// than the harness's own.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-alerter-contract.ts
import {
  assertAlerterFailsLoud,
  assertHouseStyle,
  FAIL_LOUD_CHECKS,
  HOUSE_STYLE_CHECKS,
} from "./lib/alerter-contract.ts";
import { assert, finish } from "./lib/harness.ts";

/** An `assert` that records instead of reporting, so failures can be asserted ON. */
function recorder() {
  const failures: string[] = [];
  let checks = 0;
  return {
    failures,
    get checks() {
      return checks;
    },
    assert(cond: boolean, msg: string) {
      checks++;
      if (!cond) failures.push(msg);
    },
  };
}

// --- assertHouseStyle catches each thing it claims to catch --------------------
{
  const clean = recorder();
  const n = assertHouseStyle(clean.assert, "The deploy failed on main. Open the run.", "clean");
  assert(clean.failures.length === 0, "clean copy passes the house-style check");
  assert(n === HOUSE_STYLE_CHECKS, `it reports how many checks it made (${n})`);
  assert(clean.checks === HOUSE_STYLE_CHECKS, "and it really made that many");

  // Each violation, one at a time, so a single over-broad rule cannot answer for
  // all three. The dashes are \u escapes deliberately: a file holding the literal
  // characters is rejected by the repo's own style hook, which cannot tell the
  // line banning a character from a line using it.
  const cases: [string, string, string][] = [
    ["em dash", `a sentence \u2014 broken`, "no em or en dashes"],
    ["en dash", `a range 1\u20132`, "no em or en dashes"],
    ["unicode emoji", "the deploy failed \u{1F525}", "no unicode emoji"],
    ["slack shortcode", "the deploy failed :fire:", "no slack emoji shortcodes"],
  ];
  for (const [label, text, expected] of cases) {
    const r = recorder();
    assertHouseStyle(r.assert, text, "");
    assert(
      r.failures.some((f) => f.includes(expected)),
      `house style catches a ${label} (failures: ${JSON.stringify(r.failures)})`,
    );
  }
}

// --- assertAlerterFailsLoud passes a correct alerter ---------------------------
//
// The positive half first: without it, a helper hard-wired to fail would satisfy
// every negative case below and prove nothing (L159).
{
  const good = recorder();
  const n = await assertAlerterFailsLoud(good.assert, {
    channel: "C123",
    configured: async (post) => {
      const r = await post({ text: "the deploy failed", channel: "C123" });
      return r.ok ? { ok: true } : { ok: false, reason: r.error };
    },
    unconfigured: async (post) => {
      const r = await post({ text: "the deploy failed" });
      return { ok: false, reason: r.error };
    },
  });
  assert(good.failures.length === 0, `a correct alerter passes (${JSON.stringify(good.failures)})`);
  assert(n === FAIL_LOUD_CHECKS, `it reports how many checks it made (${n})`);
  assert(good.checks === FAIL_LOUD_CHECKS, "and it really made that many");
}

// --- and catches each way an alerter can go quietly wrong ----------------------
{
  // THE HEADLINE: an alerter that reports success while Slack was never
  // configured. Nobody was warned, and the run that needed the warning is the one
  // nobody is watching.
  const r = recorder();
  await assertAlerterFailsLoud(r.assert, {
    channel: "C123",
    configured: async (post) => {
      const res = await post({ text: "x", channel: "C123" });
      return res.ok ? { ok: true } : { ok: false, reason: res.error };
    },
    unconfigured: async () => ({ ok: true }),
  });
  assert(
    r.failures.some((f) => /unconfigured/i.test(f)),
    `a silently-succeeding unconfigured alerter is caught (${JSON.stringify(r.failures)})`,
  );
}
{
  // Slack refused and the alerter swallowed it.
  const r = recorder();
  await assertAlerterFailsLoud(r.assert, {
    channel: "C123",
    configured: async (post) => {
      await post({ text: "x", channel: "C123" });
      return { ok: true }; // swallows the error the poster returned
    },
    unconfigured: async (post) => {
      const res = await post({ text: "x" });
      return { ok: false, reason: res.error };
    },
  });
  assert(
    r.failures.some((f) => /FAILS LOUD when the Slack post errors/.test(f)),
    `an alerter that swallows a Slack error is caught (${JSON.stringify(r.failures)})`,
  );
}
{
  // Posted to the wrong channel, so the alert went somewhere nobody reads.
  const r = recorder();
  await assertAlerterFailsLoud(r.assert, {
    channel: "C123",
    configured: async (post) => {
      const res = await post({ text: "x", channel: "C-WRONG" });
      return res.ok ? { ok: true } : { ok: false, reason: res.error };
    },
    unconfigured: async (post) => ({ ok: false, reason: (await post({ text: "x" })).error }),
  });
  assert(
    r.failures.some((f) => /SLACK_ALERTS_CHANNEL/.test(f)),
    `posting to the wrong channel is caught (${JSON.stringify(r.failures)})`,
  );
}
{
  // Posted twice, so an incident pages the reader two or more times.
  const r = recorder();
  await assertAlerterFailsLoud(r.assert, {
    channel: "C123",
    configured: async (post) => {
      await post({ text: "x", channel: "C123" });
      const res = await post({ text: "x", channel: "C123" });
      return res.ok ? { ok: true } : { ok: false, reason: res.error };
    },
    unconfigured: async (post) => ({ ok: false, reason: (await post({ text: "x" })).error }),
  });
  assert(
    r.failures.some((f) => /posts exactly once/.test(f)),
    `a double post is caught (${JSON.stringify(r.failures)})`,
  );
}
{
  // Never posted at all, which is the shape a helper that skipped its own work
  // would also produce, so it must not read as a pass.
  const r = recorder();
  await assertAlerterFailsLoud(r.assert, {
    channel: "C123",
    configured: async () => ({ ok: true }),
    unconfigured: async () => ({ ok: false, reason: "slack-not-configured" }),
  });
  assert(
    r.failures.some((f) => /posts exactly once/.test(f)),
    `an alerter that never posts is caught (${JSON.stringify(r.failures)})`,
  );
}

// The counts the two suites pin are the counts the helper actually makes, so a
// helper that quietly dropped an assertion fails there rather than passing.
assert(HOUSE_STYLE_CHECKS === 3 && FAIL_LOUD_CHECKS === 8, "the pinned counts are the real ones");

finish();
