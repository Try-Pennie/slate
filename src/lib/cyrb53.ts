/**
 * cyrb53: a fast, well mixed 53 bit hash of a string, written as a short base 36 name. Not
 * cryptographic: for stable short names and fingerprints where a collision only has to be
 * unlikely, never where somebody could be trying to cause one. The confirm line's ladder keys
 * (`line-key.ts`) and the booking pace readings' capacity fingerprints (`capacity-fill.ts`) both
 * use this one copy.
 *
 * Pure, no imports, so node tests load it directly.
 */
export function cyrb53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
