// The manager's decline confirmation, pinned where it can be read (#2455).
//
// The confirm asked "Decline Ada's request?" and stopped there: a name and no
// consequence, identical for a two hour appointment and for a fortnight. A
// destructive control has to say what the press does, derived from the state it
// is about to change rather than from a generic warning (L180).
//
// The sentences live in a pure builder so they can be read in one place and held
// here, the same way the agent's own two acts are, rather than sitting inline in
// a component where only a mounted render can see them (L41).
// Run: node --experimental-strip-types scripts/test-ooo-decline-copy.ts
import { assert, finish } from "./lib/harness.ts";
import { declineConfirmCopy } from "../src/lib/ooo/decline-copy.ts";

const one = declineConfirmCopy("Ada", 1);
const many = declineConfirmCopy("Ada", 5);

// --- it names the person, in both shapes ------------------------------------
for (const [label, copy] of [
  ["one day", one],
  ["several days", many],
] as [string, { question: string; consequence: string }][]) {
  assert(copy.question.includes("Ada"), `${label}: the question names the agent`);
  assert(
    copy.consequence.includes("Ada"),
    `${label}: the consequence names the agent, so it reads on its own`,
  );
}

// --- and it is DIFFERENT for a longer window --------------------------------
//
// The whole reason it takes a day count. If these two agreed the sentence would
// be carrying no information about the request in front of the manager.
assert(
  one.question !== many.question,
  "a five day request does not ask the same question as a one day one",
);
assert(many.question.includes("5 days"), `the longer window states its size (${many.question})`);
assert(
  !one.question.includes("1 day"),
  `a single window does not count itself, which reads as padding (${one.question})`,
);

// --- the consequence says what HAPPENS, not that it cannot be undone --------
for (const [label, copy] of [
  ["one day", one],
  ["several days", many],
] as [string, { question: string; consequence: string }][]) {
  assert(
    /Slack/.test(copy.consequence),
    `${label}: it says the agent is told, which is the part a misclick costs`,
  );
  assert(
    /bookable/.test(copy.consequence),
    `${label}: and what becomes of their days`,
  );
  assert(
    !/cannot be undone|are you sure|permanent/i.test(copy.consequence),
    `${label}: no generic warning standing in for the real consequence`,
  );
}

// --- it claims nothing about the note ---------------------------------------
//
// The note is optional and the control cannot see whether one was typed, so a
// sentence promising it would be a claim nothing measured (L11).
for (const copy of [one, many]) {
  assert(
    !/note/i.test(copy.consequence),
    `the consequence promises no note: ${copy.consequence}`,
  );
}

// --- no dashes, matching the copy rules the repo lints for -------------------
for (const copy of [one, many]) {
  for (const line of [copy.question, copy.consequence]) {
    assert(
      !/[\u2014\u2013]/.test(line),
      `no dash punctuation in lead facing copy: ${line}`,
    );
  }
}

// --- an unreadable count never reaches the screen ---------------------------
//
// `oooDayCount` answers 1 rather than NaN, and this holds the builder to the
// same promise from its own side: "the NaN days" is worse than under describing
// a window whose dates the row already shows.
const notANumber = declineConfirmCopy("Ada", Number.NaN);
assert(
  !/NaN/.test(notANumber.question) && !/NaN/.test(notANumber.consequence),
  `an unreadable count renders no NaN (${notANumber.question})`,
);

finish();
