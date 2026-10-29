/**
 * The live transfer settings on /admin/coordinator-booking (#4380): how many advisors must
 * be free in the transfer queue before the coordinator page offers "Transfer now", and the
 * line the customer is transferred to. Every sentence the section says, and the one reading
 * of what was typed, which the server action uses (the page never decides what is valid).
 *
 * The bounds and the line's shape are the column checks' (migration 0214), from
 * `transfer-queue.ts`, so the form cannot accept what the database refuses
 * (scripts/test-transfer-offer-form.ts). Pure, relative imports only.
 */
import { isTransferLine, TRANSFER_THRESHOLD_MAX, TRANSFER_THRESHOLD_MIN } from "../coordinator/transfer-queue.ts";

export const TRANSFER_FORM_COPY = {
  heading: "Live transfer",
  rule: "When enough advisors are free, a coordinator's page offers to transfer the customer to this line before they book a time.",
  thresholdLabel: "Advisors free before a transfer is offered",
  lineLabel: "Transfer line",
  save: "Save live transfer",
  thresholdRefused: `Enter a whole number of advisors from ${TRANSFER_THRESHOLD_MIN} to ${TRANSFER_THRESHOLD_MAX}.`,
  lineRefused: "Enter the transfer line as 786-504-0671.",
  unreadable: "Could not read the live transfer settings.",
  unreadableMeanwhile: "Until they can be read, coordinators are not offered a transfer and book a time as usual. Reload the page to try again.",
} as const;

export type TransferOfferForm = { ok: true; threshold: number; line: string } | { ok: false; error: string };

export function parseTransferOfferForm(rawThreshold: string, rawLine: string): TransferOfferForm {
  const t = rawThreshold.trim();
  const n = /^[0-9]{1,3}$/.test(t) ? Number(t) : NaN;
  const thresholdOk = Number.isInteger(n) && n >= TRANSFER_THRESHOLD_MIN && n <= TRANSFER_THRESHOLD_MAX;
  const line = rawLine.trim();
  const lineOk = isTransferLine(line);
  if (thresholdOk && lineOk) return { ok: true, threshold: n, line };
  const errors = [thresholdOk ? null : TRANSFER_FORM_COPY.thresholdRefused, lineOk ? null : TRANSFER_FORM_COPY.lineRefused];
  return { ok: false, error: errors.filter((e) => e !== null).join(" ") };
}
