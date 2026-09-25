// Fixture for the tree write tripwire (#2733): passes only when the runner told
// it that an outer run's tripwire covers it. A suite that starts the runner again
// (test-run-tests.ts does) must not arm a second watcher over the same tree,
// where it would see its concurrent siblings' writes and blame them on itself.
if (process.env.SLATE_TREE_TRIPWIRE !== "nested") {
  console.error(`FAIL: expected SLATE_TREE_TRIPWIRE=nested, got ${process.env.SLATE_TREE_TRIPWIRE}`);
  process.exit(1);
}
console.log("ok: the runner marked this suite as nested");
process.exit(0);
