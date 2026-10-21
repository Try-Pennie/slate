// #3541: a Salesforce Lead id's two spellings, so a lookup keyed on one finds a row
// stored under the other.
//
// A booking stores whichever spelling its caller sent (15 or 18 characters), and
// Marcia's token accepts either, so every place Marcia looks a lead up asks with both.
// The 18 character form is the 15 plus a case checksum Salesforce defines: for each
// five character block, a bit per uppercase letter, indexing A to Z then 0 to 5.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-lead-id-spellings.ts
import { leadIdKey, leadIdSpellings } from "../src/lib/salesforce/lead-xbc.ts";
import { eq, finish } from "./lib/harness.ts";

// Salesforce's own documented example (an Account id; the checksum is the same for every object).
eq(leadIdSpellings("001D000000IqhSL"), { short: "001D000000IqhSL", long: "001D000000IqhSLIAZ" }, "the 18 character form of Salesforce's documented example");
eq(leadIdSpellings("001D000000IqhSLIAZ"), { short: "001D000000IqhSL", long: "001D000000IqhSLIAZ" }, "and an 18 character id gives back the same two spellings");
eq(leadIdSpellings("00Q000000000000"), { short: "00Q000000000000", long: "00Q000000000000EAA" }, "a Lead id with no capitals after its prefix: the Q alone sets the first block's letter");
eq(leadIdSpellings("00Q000000000000AAA").long, "00Q000000000000AAA", "an 18 character id is kept as given, the spelling a row written with it holds");
// Blocks 00QAb (Q, A: 4 + 8 = 12, M), CdEfG (C, E, G: 1 + 4 + 16 = 21, V), hIjKl (I, K: 2 + 8 = 10, K).
eq(leadIdSpellings("00QAbCdEfGhIjKl").long, "00QAbCdEfGhIjKlMVK", "each block's capitals set its own letter");
eq(leadIdSpellings("00Q5f00000AbCdE").long, "00Q5f00000AbCdEEAV", "the pair the Marcia suite books across");
eq(leadIdKey(leadIdSpellings("00Q5f00000AbCdE").long), "00Q5f00000AbCdE", "the long form keys to the short one");

finish();
