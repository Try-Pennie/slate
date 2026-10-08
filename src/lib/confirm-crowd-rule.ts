/**
 * What a confirm waiting in a crowd does when the leader ahead of it booked the LAST
 * advisor of the rung it booked from (#3338), as this build declares it (#3429).
 *
 * - `stops`: the leader reports the slot full and every confirm waiting behind it is
 *   answered SLOT_TAKEN, even when a rung further down the tier ladder still has
 *   somebody free. This is the rule #3338 found, and every build before #3437 runs it.
 * - `walks`: the next confirm leads and walks the tier ladder like any confirm, so a
 *   crowd books one advisor per free advisor across the ladder and is told SLOT_TAKEN
 *   only once the whole ladder is spent (Dan, 2026-10-06: "Same as a normal confirm").
 *
 * It exists for the load run's burst (#3429). A crowd behind a one deep rung with a
 * staffed rung below it ends one way under each rule, so the judge has to know which
 * rule the deployment it measured runs: a FAIL naming #3338 is right only on a build
 * that says it walks. The load test deployment reports this value from
 * `/api/smoke/version`, and every burst driver records what it said.
 *
 * #3437 set this to `walks` in the change that made a crowd walk the ladder. A build
 * whose behaviour and declaration disagree does not pass quietly in either direction:
 * a build that walks while saying `stops` gives a drop burst that cannot show the
 * defect it declares, which the judge reports as unconcluded, and a build that stops
 * while saying `walks` fails the drop burst by name.
 *
 * Enforced, not only declared (L407): `scripts/test-confirm-contention.ts` drives the
 * REAL confirm path with a crowd behind a top rung of one advisor and a staffed rung
 * below it, reads which rule the outcome shows, and fails unless it is this one. So a
 * change to the behaviour without this flip, or to this without the behaviour, fails
 * the build.
 *
 * Pure, no `@/` imports, so the node suites read the vocabulary directly.
 */
export const CONFIRM_CROWD_RULES = ["stops", "walks"] as const;

export type ConfirmCrowdRule = (typeof CONFIRM_CROWD_RULES)[number];

export const CONFIRM_CROWD_RULE: ConfirmCrowdRule = "walks";
