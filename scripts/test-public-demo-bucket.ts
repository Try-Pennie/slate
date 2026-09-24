// Guard: a static page under public/ is served to anyone on the production
// domain, so every booking link it carries must name the public test bucket
// (#2660), never a real one. The embed demo used to book bucket 411, so anybody
// who opened /embed-example.html and pressed its button booked a real advisor's
// calendar and sent Regal a real booking event.
// Run: node --experimental-strip-types scripts/test-public-demo-bucket.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";
import { PUBLIC_TEST_BUCKET_CODES } from "../src/lib/embed/public-test-bucket.ts";

const PUBLIC: readonly string[] = PUBLIC_TEST_BUCKET_CODES;

/** Every data-cal-link in the html, decoded, with the xbc each one names. */
function bookingLinks(html: string): { link: string; xbc: string | null }[] {
  return [...html.matchAll(/data-cal-link\s*=\s*["']([^"']+)["']/gi)].map((m) => {
    const link = m[1].replace(/&amp;/g, "&");
    const query = link.includes("?") ? link.slice(link.indexOf("?") + 1) : "";
    return { link, xbc: new URLSearchParams(query).get("xbc") };
  });
}

// Positive controls: the scan must see a real bucket, and a link naming none.
const control = bookingLinks(
  `<button data-cal-link="book?xbc=411&amp;external_id=x"></button><a data-cal-link='router?form=abc'></a>`,
);
assert(control.length === 2, "the scan finds both links in the control");
assert(control[0].xbc === "411", "the scan reads a real bucket code from a link");
assert(control[1].xbc === null, "the scan reports a link that names no bucket");

const pages = readdirSync("public").filter((f) => f.endsWith(".html"));
assert(pages.length > 0, "public/ holds at least one html page to check");

let checked = 0;
for (const page of pages) {
  for (const { link, xbc } of bookingLinks(readFileSync(join("public", page), "utf8"))) {
    checked += 1;
    assert(
      xbc !== null && PUBLIC.includes(xbc),
      `public/${page} books the public test bucket (${PUBLIC.join(", ")}), not ${xbc ?? "no bucket"}: ${link}`,
    );
  }
}
assert(checked > 0, "at least one booking link was checked, so a pass is not an empty scan");

finish();
