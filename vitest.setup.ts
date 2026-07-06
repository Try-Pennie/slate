import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom doesn't implement scrollIntoView, which the form's error/edit effects
// call; stub it so those effects don't throw under test. Guarded so node-env
// suites (e.g. the middleware test) that share this setup don't hit `Element`.
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

afterEach(() => cleanup());
