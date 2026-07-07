// Fixture: a second failing node-native test (non-zero exit) that also crashes
// AFTER emitting its marker, exercising the "later failure isn't hidden" path.
console.error("FAIL: fail-b marker BRAVO");
throw new Error("fail-b throws BRAVO-THROW");
