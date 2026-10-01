// Fetching the advisor's photo for the reminder's contact card (#1334). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-advisor-card-photo.ts
//
// The photo is an optional extra on an email a real person reads, so every way it
// can go wrong must end in "no photo" rather than in a broken card, a bloated email
// or a stalled lane. Driven through real `Response` objects and a fake timer, so no
// network and no real clock.
import {
  CARD_PHOTO_DEADLINE_MS,
  CARD_PHOTO_MAX_BYTES,
  cardPhotoUrl,
  fetchCardPhoto,
  type PhotoFetcher,
} from "../src/lib/booking/advisor-card-photo.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const STORED = "https://lh3.googleusercontent.com/a/ACg8ocK_example=s96-c";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A fetcher answering one canned response, recording what it was asked. */
function answering(make: () => Response) {
  const asked: string[] = [];
  const fetcher: PhotoFetcher = async (url) => {
    asked.push(url);
    return make();
  };
  return { fetcher, asked };
}

async function read(fetcher: PhotoFetcher, url = cardPhotoUrl(STORED)!) {
  const unread: unknown[] = [];
  const photo = await fetchCardPhoto(url, fetcher, (err) => unread.push(err));
  return { photo, unread };
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// --- the URL: a modest square size, and only a web address ------------------------
//
// Google's user content host takes a size suffix; the stored value asks for 96px,
// which is blurry on a contact screen. Measured 2026-10-01: 256px PNGs ran to 112 KB,
// and the same photos asked for as JPEG (`-rj`) came back at 14 to 27 KB.
eq(cardPhotoUrl(STORED), "https://lh3.googleusercontent.com/a/ACg8ocK_example=s256-c-rj", "the stored 96px asks for 256px instead");
eq(
  cardPhotoUrl("https://lh3.googleusercontent.com/a/x=s96"),
  "https://lh3.googleusercontent.com/a/x=s256-c-rj",
  "an uncropped size suffix is replaced too",
);
eq(cardPhotoUrl("https://example.com/me.jpg"), "https://example.com/me.jpg", "a URL with no size suffix is used as it is");
eq(cardPhotoUrl("http://lh3.googleusercontent.com/a/x=s96-c"), null, "a plain http address is not fetched");
eq(cardPhotoUrl("not a url"), null, "nor is something that is not a URL");
eq(cardPhotoUrl(""), null, "nor an empty value");

// --- a JPEG and a PNG, embedded in their real type --------------------------------
{
  const { fetcher, asked } = answering(() => new Response(JPEG, { headers: { "content-type": "image/jpeg" } }));
  const { photo, unread } = await read(fetcher);
  eq(photo, { type: "JPEG", base64: b64(JPEG) }, "a JPEG comes back as base64, typed JPEG");
  eq(unread.length, 0, "and nothing is reported");
  eq(asked, ["https://lh3.googleusercontent.com/a/ACg8ocK_example=s256-c-rj"], "fetched once, at the sized URL");
}
{
  const { fetcher } = answering(() => new Response(PNG, { headers: { "content-type": "image/png; charset=binary" } }));
  const { photo } = await read(fetcher);
  eq(photo, { type: "PNG", base64: b64(PNG) }, "a PNG comes back typed PNG, parameters on the media type ignored");
}

// --- never anything that is not an image -----------------------------------------
{
  const { fetcher } = answering(
    () => new Response("<html>Error 400</html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  const { photo, unread } = await read(fetcher);
  eq(photo, null, "an HTML answer is never embedded");
  eq(unread.length, 1, "and is reported once");
  assert(/not an image/.test(reasonOf(unread[0])), `with a reason naming it (${reasonOf(unread[0])})`);
}
{
  const { fetcher } = answering(() => new Response(JPEG, { headers: { "content-type": "image/gif" } }));
  const { photo } = await read(fetcher);
  eq(photo, null, "an image type the card cannot declare is refused");
}
{
  // Labelled a JPEG and holding something else: the label alone is not trusted.
  const { fetcher } = answering(() => new Response("<html></html>", { headers: { "content-type": "image/jpeg" } }));
  const { photo, unread } = await read(fetcher);
  eq(photo, null, "data that does not match its declared type is refused");
  assert(/does not match/.test(reasonOf(unread[0])), `and says so (${reasonOf(unread[0])})`);
}
{
  const { fetcher } = answering(() => new Response(null, { headers: { "content-type": "image/jpeg" } }));
  const { photo } = await read(fetcher);
  eq(photo, null, "an empty body is no photo");
}
{
  const { fetcher } = answering(() => new Response("gone", { status: 404, headers: { "content-type": "image/jpeg" } }));
  const { photo, unread } = await read(fetcher);
  eq(photo, null, "a refused fetch is no photo");
  assert(/404/.test(reasonOf(unread[0])), `and names the status (${reasonOf(unread[0])})`);
}
{
  const fetcher: PhotoFetcher = async () => {
    throw new TypeError("fetch failed");
  };
  const { photo, unread } = await read(fetcher);
  eq(photo, null, "a fetch that throws is no photo");
  eq(unread.length, 1, "and is reported once");
}

// --- too large, refused rather than bloating the email ------------------------------
{
  // Declared too large: refused from the header, before the body is read.
  const big = new Uint8Array(CARD_PHOTO_MAX_BYTES + 1);
  big.set(JPEG);
  const { fetcher } = answering(
    () => new Response(big, { headers: { "content-type": "image/jpeg", "content-length": String(big.length) } }),
  );
  const { photo, unread } = await read(fetcher);
  eq(photo, null, "an image declared larger than the cap is refused");
  assert(/too large/.test(reasonOf(unread[0])), `and says so (${reasonOf(unread[0])})`);
}
{
  // No length declared (a chunked answer): the cap still holds while reading.
  const big = new Uint8Array(CARD_PHOTO_MAX_BYTES + 1);
  big.set(JPEG);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = big.subarray(pulled, pulled + 16 * 1024);
      if (chunk.length === 0) return controller.close();
      pulled += chunk.length;
      controller.enqueue(chunk);
    },
  });
  const { fetcher } = answering(() => new Response(stream, { headers: { "content-type": "image/jpeg" } }));
  const { photo, unread } = await read(fetcher);
  eq(photo, null, "an undeclared body over the cap is refused");
  assert(/too large/.test(reasonOf(unread[0])), `and says so (${reasonOf(unread[0])})`);
}
{
  // Exactly at the cap is allowed: the cap is a ceiling, not a strict bound below it.
  const atCap = new Uint8Array(CARD_PHOTO_MAX_BYTES);
  atCap.set(JPEG);
  const { fetcher } = answering(() => new Response(atCap, { headers: { "content-type": "image/jpeg" } }));
  const { photo } = await read(fetcher);
  eq(photo?.type, "JPEG", "an image exactly at the cap is embedded");
}

// --- a fetch that never answers ---------------------------------------------------
{
  const timer = { ms: 0, set: 0, cleared: 0 };
  let signal: AbortSignal | undefined;
  const fetcher: PhotoFetcher = (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  };
  const unread: unknown[] = [];
  const photo = await fetchCardPhoto(cardPhotoUrl(STORED)!, fetcher, (err) => unread.push(err), (ms, fire) => {
    timer.ms = ms;
    timer.set += 1;
    queueMicrotask(fire);
    return () => {
      timer.cleared += 1;
    };
  });
  eq(photo, null, "a hung fetch gives up as no photo");
  eq(unread.length, 1, "reported once");
  assert(/no answer within/.test(reasonOf(unread[0])), `as a timeout (${reasonOf(unread[0])})`);
  eq(timer.ms, CARD_PHOTO_DEADLINE_MS, "under the photo's own deadline");
  eq(timer.cleared, timer.set, "whose timer is cleared");
  eq(signal?.aborted, true, "and the abandoned request is aborted rather than left running");
}

finish();
