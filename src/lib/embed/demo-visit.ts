import { DEMO_BUCKET_CODE } from "./public-test-bucket.ts";

/**
 * The made up person a visit to `/demo` books as (#3424).
 *
 * The demo is shown to somebody outside Pennie, so the booker arrives prefilled
 * the way a real lead's does (Dan, 2026-10-06: a fake name, a demo address and a
 * 555 number), and the visitor only has to pick a time.
 *
 * Each visit gets its OWN details rather than one shared set, and that is the
 * point of this module rather than a nicety. Slate's one call per person check
 * grades a match on email and phone (`person-dedupe.ts`): two visitors sharing an
 * address AND a number grade `medium`, which silently MOVES the first visitor's
 * call to the second visitor's time, and sharing either one alone asks the second
 * visitor whether they already have a call. A code drawn per visit keeps every
 * visitor a stranger to every other.
 *
 * Nothing here reaches a person. The address is a plus alias of a mailbox nobody
 * reads, and the number is in 555-0100 to 555-0199, the range set aside for
 * fiction in every area code. The demo bucket is a test bucket, so no text or
 * webhook is ever sent for it in any case.
 *
 * Pure: the randomness is passed in, so the distinctness is tested with a seeded
 * generator rather than asserted.
 */

/** Characters in a visit code. 36^6 is about two billion, far past any demo. */
export const DEMO_SUFFIX_LENGTH = 6;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * US area codes the number is drawn across. Spread over a hundred of them so two
 * visitors rarely share a number (one in ten thousand per pair), and when they do,
 * the distinct address keeps the match `weak`, which asks rather than moves.
 * `scripts/test-demo-visit.ts` holds every one to the booker's own phone check.
 */
export const DEMO_AREA_CODES = [
  201, 202, 203, 205, 206, 207, 208, 209, 210, 212, 213, 214, 215, 216, 217, 218, 219, 224, 225, 228,
  229, 231, 234, 239, 240, 248, 251, 252, 253, 254, 256, 260, 262, 267, 269, 270, 276, 281, 301, 302,
  303, 304, 305, 307, 308, 309, 310, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 323, 325, 330,
  334, 336, 337, 339, 347, 351, 352, 360, 361, 385, 386, 401, 402, 404, 405, 406, 407, 408, 409, 410,
  412, 413, 414, 415, 417, 419, 423, 424, 425, 430, 432, 434, 435, 440, 443, 469, 470, 475, 478, 479,
] as const;

/** Draw a visit code. `random` returns a number in [0, 1), like `Math.random`. */
export function newDemoSuffix(random: () => number): string {
  let out = "";
  for (let i = 0; i < DEMO_SUFFIX_LENGTH; i++) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  }
  return out;
}

/** A stable number from the visit code, so one visit always carries one phone. */
function hashOf(suffix: string): number {
  let h = 2166136261;
  for (const ch of suffix) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export interface DemoVisit {
  /** The lead id the booker sends with the booking. */
  salesforceId: string;
  /** The `/book` style query this visit stands for, read by `readBookEntryQuery`. */
  query: { xbc: string; external_id: string; name: string; email: string; phone: string };
}

/** The visit a code stands for. Refuses a code that is not plain letters and
 *  digits, rather than building it into an email address. */
export function demoVisit(suffix: string): DemoVisit {
  if (!/^[a-z0-9]{1,32}$/.test(suffix)) {
    throw new Error(`demo visit code is not plain lower case letters and digits: ${JSON.stringify(suffix)}`);
  }
  const h = hashOf(suffix);
  const area = DEMO_AREA_CODES[h % DEMO_AREA_CODES.length];
  const line = String(Math.floor(h / DEMO_AREA_CODES.length) % 100).padStart(2, "0");
  const salesforceId = `demo-${suffix}`;
  return {
    salesforceId,
    query: {
      xbc: DEMO_BUCKET_CODE,
      external_id: salesforceId,
      name: "Demo Lead",
      email: `demo+${suffix}@trypennie.com`,
      phone: `(${area}) 555-01${line}`,
    },
  };
}
