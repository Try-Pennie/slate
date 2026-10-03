// #3135: a public JSON route reads its body through `readJsonCapped`, which stops reading
// at a byte cap rather than buffering whatever arrives. These drive it with real Request
// bodies, a declared length that lies included, since the declared length is only a claim.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-read-json-capped.ts
import { readJsonCapped, PUBLIC_JSON_MAX_BYTES } from "../src/lib/http/read-json-capped.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://slate.test/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);

/** A body streamed in chunks, so nothing about its size is known until it is read. */
function streamed(chunks: number, chunkBytes: number, pulled: { count: number }): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) return controller.close();
      sent += 1;
      pulled.count = sent;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
  });
}

async function main() {
  eq(PUBLIC_JSON_MAX_BYTES, 16 * 1024, "the default public cap is 16 KB");

  const ok = await readJsonCapped(post(JSON.stringify({ a: 1 })), 1024);
  assert(!ok.tooLarge && JSON.stringify(ok.value) === '{"a":1}', "a small JSON body parses");

  const bad = await readJsonCapped(post("{not json"), 1024);
  assert(!bad.tooLarge && bad.value === null, "an unparseable body reads as null, like req.json().catch");

  const none = await readJsonCapped(post(null), 1024);
  assert(!none.tooLarge && none.value === null, "no body reads as null");

  const exact = await readJsonCapped(post(`"${"x".repeat(1022)}"`), 1024);
  assert(!exact.tooLarge, "a body of exactly the cap is accepted");

  const over = await readJsonCapped(post(`"${"x".repeat(1023)}"`), 1024);
  assert(over.tooLarge, "one byte past the cap is too large");

  const declared = await readJsonCapped(post("{}", { "content-length": "999999" }), 1024);
  assert(declared.tooLarge, "a body that DECLARES itself oversized is refused unread");

  // The declared length is a claim: a stream with no length is measured as it arrives, and
  // reading STOPS at the cap rather than pulling the rest of a large body into memory.
  const pulled = { count: 0 };
  const flood = await readJsonCapped(post(streamed(1000, 1024, pulled)), 4 * 1024);
  assert(flood.tooLarge, "an undeclared streamed body past the cap is too large");
  assert(pulled.count <= 6, `reading stopped near the cap rather than draining the body (${pulled.count} chunks pulled)`);

  const multibyte = await readJsonCapped(post(JSON.stringify("é".repeat(600))), 1024);
  assert(multibyte.tooLarge, "the cap is in BYTES, so 600 two byte characters exceed 1 KB");
}

await main();
finish();
