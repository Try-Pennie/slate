/**
 * Where the confirmation mark's self-served assets live, and where the player's
 * wasm comes from (#2560).
 *
 * Stated once so the build script and the guard that checks its output cannot
 * drift: a guard reading a different path from the one the build writes would
 * pass while protecting nothing.
 */
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** The check mark animation, built by `scripts/build-confirmation-mark-assets.ts`. */
export const CHECKMARK_LOTTIE_PATH = "public/brand/checkmark.lottie";

/**
 * The dotLottie player's wasm, copied out of node_modules and served by Slate.
 *
 * The player otherwise fetches it from jsdelivr with an unpkg fallback, so the
 * one branded moment on the confirmation screen would depend on a third party
 * being up. `setWasmUrl` also turns those fallbacks OFF, which is the behaviour
 * wanted here: a failure to load ours must surface, not silently reach a CDN.
 */
export const DOTLOTTIE_WASM_PATH = "public/brand/dotlottie-player.wasm";

/** The repo and path the source animation is maintained in. */
export const SOURCE_LOTTIE_REPO = "Halo-lab-Trypennie/trypennie";
export const SOURCE_LOTTIE_REPO_PATH = "public/animation/loadingAnimation.lottie";

/**
 * The wasm shipped by the INSTALLED `@lottiefiles/dotlottie-web`.
 *
 * Resolved through the react package rather than named by a path under
 * `node_modules/.pnpm/`, which carries the version in its directory name and so
 * would need editing on every bump: exactly the drift this file exists to catch.
 */
export function installedWasmPath(root: string): string {
  const react = realpathSync(join(root, "node_modules/@lottiefiles/dotlottie-react"));
  return createRequire(join(react, "dist/index.js")).resolve(
    "@lottiefiles/dotlottie-web/dotlottie-player.wasm",
  );
}

/**
 * Where the app's OWN import of `@lottiefiles/dotlottie-web` lands, and where the
 * react package's lands. `ConfirmationMarkPlayer` imports the player class
 * directly for its static `preload`, which compiles the wasm ahead of the
 * confirmation screen. That only helps if the class it warms is the one the
 * react player constructs: were the two to resolve to different copies (a react
 * bump that moved its own pin), the warm would compile a wasm nobody uses and
 * the blank before the mark would come back with nothing failing.
 */
export function webPackageRoots(root: string): { direct: string; viaReact: string } {
  const direct = realpathSync(join(root, "node_modules/@lottiefiles/dotlottie-web"));
  const viaReact = dirname(dirname(installedWasmPath(root)));
  return { direct, viaReact: realpathSync(viaReact) };
}

/** The installed dotlottie-web version, which is what the wasm is a build of. */
export function installedWasmVersion(root: string): string {
  const pkg = join(dirname(dirname(installedWasmPath(root))), "package.json");
  return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
}
