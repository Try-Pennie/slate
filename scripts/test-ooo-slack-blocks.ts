// Tests for the interactive OOO Slack Block Kit builders (#77).
// Run: node --experimental-strip-types scripts/test-ooo-slack-blocks.ts
import {
  approvalBlocks,
  rejectionModalView,
  noteFromViewState,
  OOO_APPROVE_ACTION,
  OOO_REJECT_ACTION,
  OOO_REJECT_MODAL,
  OOO_REJECT_NOTE_BLOCK,
  OOO_REJECT_NOTE_INPUT,
} from "../src/lib/notify/ooo-slack-blocks.ts";
import { assert, finish } from "./lib/harness.ts";

// --- approval blocks ---
{
  const blocks = approvalBlocks("Pending: Aria Agent", "req-42") as Array<{
    type: string;
    text?: { text?: string };
    elements?: {
      action_id: string;
      value: string;
      style?: string;
      confirm?: unknown;
    }[];
  }>;
  assert(blocks[0].text?.text === "Pending: Aria Agent", "section carries the text");
  const actions = blocks[1];
  const ids = (actions.elements ?? []).map((e) => e.action_id);
  assert(
    ids.includes(OOO_APPROVE_ACTION) && ids.includes(OOO_REJECT_ACTION),
    "both Approve and Decline buttons present",
  );
  assert(
    (actions.elements ?? []).every((e) => e.value === "req-42"),
    "buttons carry the request id",
  );
  const approve = (actions.elements ?? []).find(
    (e) => e.action_id === OOO_APPROVE_ACTION,
  );
  assert(approve?.style === "primary", "approve is the primary button");
  // #1239 decision 6: the pending notice now says how many appointments approving
  // would move, and that is the whole intervention. NO confirm dialog on Approve: it
  // would slow every approval, including the majority that move nothing, to guard a
  // minority the notice already warns about. A decision that is only true because
  // nobody added one has no owner and no test (L281), so it is pinned here.
  assert(
    approve?.confirm === undefined,
    "approve is one click: no blocking confirm dialog",
  );
}

// --- rejection modal ---
{
  const view = rejectionModalView("req-7", "Tue, Oct 7 2025") as {
    callback_id: string;
    private_metadata: string;
    blocks: { block_id?: string }[];
  };
  assert(view.callback_id === OOO_REJECT_MODAL, "modal has the reject callback id");
  assert(view.private_metadata === "req-7", "request id rides in private_metadata");
  assert(
    view.blocks.some((b) => b.block_id === OOO_REJECT_NOTE_BLOCK),
    "modal has the note input block",
  );
}

// --- note extraction ---
{
  const submission = {
    state: {
      values: {
        [OOO_REJECT_NOTE_BLOCK]: {
          [OOO_REJECT_NOTE_INPUT]: { value: "Coverage is thin that week." },
        },
      },
    },
  };
  assert(
    noteFromViewState(submission) === "Coverage is thin that week.",
    "extracts the typed note",
  );
  assert(noteFromViewState({}) === "", "missing note resolves to empty string");
}

finish();
