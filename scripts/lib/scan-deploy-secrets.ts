// Which secrets DEPLOY.md tells an operator to set, and whether the load test
// guard's two lists still partition them (#2335).
//
// The deployment's secret inventory lives in ONE place, the `wrangler secret put`
// lines of the disaster-recovery runbook, and `src/lib/loadtest-guard.ts` splits
// it in two: the three a load run legitimately holds, and everything else, which a
// load test build must never carry. Derived here rather than maintained beside it,
// because a secret added to the runbook and not classified would otherwise be
// silently exempt from the guard written to catch it (L96).
//
// A commented line counts. `# wrangler secret put BOOKING_API_KEY_2` is the
// rotation key: it is not set today and must never be set on a load test, so
// leaving it out would exempt exactly the name somebody sets under pressure.

export interface SecretPartition {
  /** Every name the runbook names, in the order it names them. */
  inventory: string[];
  /** Named by the runbook and classified by neither list. */
  unclassified: string[];
  /** Classified as production-only but no longer in the runbook at all. */
  stale: string[];
  /** On both lists at once, so which check ran first would decide. */
  overlapping: string[];
}

export function deploySecretNames(deployMd: string): string[] {
  const out: string[] = [];
  for (const m of deployMd.matchAll(/wrangler secret put\s+([A-Z][A-Z0-9_]*)/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function partitionDeploySecrets(
  deployMd: string,
  allowed: readonly string[],
  productionOnly: readonly string[],
): SecretPartition {
  const inventory = deploySecretNames(deployMd);
  const classified = new Set([...allowed, ...productionOnly]);
  return {
    inventory,
    unclassified: inventory.filter((n) => !classified.has(n)),
    stale: productionOnly.filter((n) => !inventory.includes(n)),
    overlapping: productionOnly.filter((n) => allowed.includes(n)),
  };
}
