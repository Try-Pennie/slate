// Registers the `@/` -> ./src resolution hook for node-native tests.
// Used via `node --experimental-strip-types --import ./scripts/register-paths.mjs`.
import { register } from "node:module";

register("./path-alias-hooks.mjs", import.meta.url);
