/**
 * Block Kit builders for the interactive OOO manager notification (#77). Pure
 * and side-effect-free so the payloads are unit-testable
 * (scripts/test-ooo-slack-blocks.ts); the IO (posting/updating, opening the
 * modal) lives in src/lib/notify/slack.ts and the interactions route.
 */

/** Stable action/callback ids the interactions endpoint switches on. */
export const OOO_APPROVE_ACTION = "ooo_approve";
export const OOO_REJECT_ACTION = "ooo_reject";
export const OOO_REJECT_MODAL = "ooo_reject_modal";
export const OOO_REJECT_NOTE_BLOCK = "ooo_reject_note";
export const OOO_REJECT_NOTE_INPUT = "note";

/**
 * The pending manager notification, as the existing mrkdwn text plus an
 * Approve / Decline button row carrying the request id. Posting these blocks
 * still sends `text` too (notification fallback + accessibility).
 */
export function approvalBlocks(text: string, requestId: string): unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      block_id: `ooo_actions:${requestId}`,
      elements: [
        {
          type: "button",
          action_id: OOO_APPROVE_ACTION,
          value: requestId,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
        },
        {
          type: "button",
          action_id: OOO_REJECT_ACTION,
          value: requestId,
          text: { type: "plain_text", text: "Decline" },
        },
      ],
    },
  ];
}

/**
 * The modal opened when a manager clicks Decline, collecting an optional note.
 * `requestId` rides in private_metadata so the view_submission can act on it.
 */
export function rejectionModalView(requestId: string, whenLine: string): unknown {
  return {
    type: "modal",
    callback_id: OOO_REJECT_MODAL,
    private_metadata: requestId,
    title: { type: "plain_text", text: "Decline time off" },
    submit: { type: "plain_text", text: "Decline" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `Declining *${whenLine}*.` },
      },
      {
        type: "input",
        optional: true,
        block_id: OOO_REJECT_NOTE_BLOCK,
        label: { type: "plain_text", text: "Note to the agent (optional)" },
        element: {
          type: "plain_text_input",
          action_id: OOO_REJECT_NOTE_INPUT,
          multiline: true,
        },
      },
    ],
  };
}

/** Pull the typed note out of a view_submission payload's state, or "". */
export function noteFromViewState(view: unknown): string {
  const values = (
    view as {
      state?: { values?: Record<string, Record<string, { value?: string }>> };
    }
  )?.state?.values;
  return values?.[OOO_REJECT_NOTE_BLOCK]?.[OOO_REJECT_NOTE_INPUT]?.value ?? "";
}
