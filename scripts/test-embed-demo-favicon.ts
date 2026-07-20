// Guard: the embed demo host page (public/embed-example.html) must declare a
// favicon so browsers don't request /favicon.ico and 404 (noisy dev console,
// #60). The app serves /icon.svg via Next's icon convention, but a static page
// under public/ only gets an icon if it links one explicitly.
// Run: node --experimental-strip-types scripts/test-embed-demo-favicon.ts
import { readFileSync } from "node:fs";
import { assert, finish } from "./lib/harness.ts";

const html = readFileSync("public/embed-example.html", "utf8");

assert(
  /<link[^>]+rel=["']icon["'][^>]*>/i.test(html),
  "embed-example.html declares a <link rel=\"icon\">",
);
assert(
  /<link[^>]+rel=["']icon["'][^>]*href=["']\/icon\.svg["']/i.test(html),
  "the favicon points at /icon.svg (served by Next's icon convention)",
);

finish();
