import { afterEach } from "vitest";

// Shared by every vitest file, but only the jsdom ones (the component tests that
// opt in with `@vitest-environment jsdom`) need a DOM, React, or Testing Library.
// Since #608 the default environment is `node`, so importing Testing Library at
// the top level would load React into all ~53 node-env files that never render.
// Everything DOM-shaped is therefore behind a document check and a lazy import.
if (typeof document !== "undefined") {
  // jsdom doesn't implement scrollIntoView, which the form's error/edit effects
  // call; stub it so those effects don't throw under test.
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  // jsdom has no ResizeObserver; the embedded Booker uses one to post slate:resize.
  // A no-op stub lets the embed effects mount without throwing.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // jsdom has no IntersectionObserver either; the confirmation mark's dotLottie
  // player observes its own canvas so it can stop painting while off screen
  // (#2560). Without this the player throws out of a passive effect, which fails
  // the test that mounted it and says nothing about what went wrong.
  if (typeof globalThis.IntersectionObserver === "undefined") {
    globalThis.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  }

  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());
}
