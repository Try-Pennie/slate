// #4006: the pure decisions behind `pnpm verify:marcia-lead-fill`, pinned offline by
// `scripts/test-marcia-lead-fill-check.ts`, so a live run is spent only on what a
// fixture cannot answer: whether the deployed Worker's Salesforce Lead read fills a
// move's missing email and phone from the real org, inside its 2.5 second cap.
//
// Relative imports only, and nothing that reads the network or the environment.
import { usableTokenKeys, FIXTURE_TOKEN_KEY } from "../../src/lib/mcp-booking/machine-token.ts";
import { MACHINE_TOKEN_AUDIENCE, MACHINE_TOKEN_ISSUER } from "../../src/lib/mcp-booking/token-shape.ts";
import { PARTNER_BUCKET_CODE } from "../../src/lib/embed/public-test-bucket.ts";

/** Every way a run can end, each on its own exit code (L11). */
export const LEAD_FILL_OUTCOMES = {
  proven: { exit: 0, says: "a move through the booking MCP filled the lead's email and phone from the Salesforce Lead on production, and the test call was cancelled" },
  notConfigured: { exit: 1, says: "no apply flag, no lead id, no usable token key, or no credentials; nothing was attempted" },
  canaryWindow: { exit: 2, says: "inside the smoke canary's window; nothing was attempted" },
  leadUnsuitable: { exit: 3, says: "this Salesforce Lead cannot prove the fill; nothing was booked" },
  bookingsAnswerFirst: { exit: 4, says: "Slate already holds this lead's details or a call for it, so the Lead would never be asked; nothing was booked" },
  salesforceUnreadable: { exit: 5, says: "the Salesforce Lead could not be read from here; nothing was booked" },
  noTimes: { exit: 6, says: "find_times through the booking MCP did not offer two times on the partner test bucket; nothing was booked" },
  mcpRefused: { exit: 7, says: "the booking MCP refused a call" },
  setupRefused: { exit: 8, says: "the test call could not be booked" },
  notFilled: { exit: 9, says: "the move landed, but the booking does not hold the Lead's email and phone, so the fill did not come from Salesforce" },
  residue: { exit: 10, says: "cleanup left the test call active" },
  cleanupUnverified: { exit: 11, says: "cleanup could not read whether the test call is cancelled, so nothing is vouched for" },
} as const;
export type LeadFillOutcome = keyof typeof LEAD_FILL_OUTCOMES;

/** Where Marcia's booking MCP answers. */
export const BOOKING_MCP_URL = "https://slate-booking-mcp.trypennie.dev/mcp";

/** The zone the run's times are asked and booked in. */
export const RUN_TIME_ZONE = "America/New_York";

/** The only addresses the run will let Google send the moved and cancelled invites to. */
export const INVITE_DOMAIN = "@trypennie.com";

const LEAD_ID = /^00Q[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;

/** A Salesforce Lead id, 15 or 18 characters, or a reason it is not one. */
export function leadIdProblem(raw: string | undefined): string | null {
  const id = (raw ?? "").trim();
  if (!id) return "set VERIFY_MARCIA_LEAD_ID to the Salesforce Lead the run books as";
  return LEAD_ID.test(id) ? null : "VERIFY_MARCIA_LEAD_ID is not a Salesforce Lead id (00Q, 15 or 18 characters)";
}

/**
 * The token key, from the file `MARCIA_TOKEN_KEY_FILE` names (read by the caller and
 * passed in) or else `MARCIA_TOKEN_KEY_A`, and whether it can sign. Never echoed: a
 * problem names what is wrong, never any part of the value.
 */
export function tokenKeyFrom(fileContents: string | null, envValue: string | undefined): { key: string } | { problem: string } {
  const raw = (fileContents ?? envValue ?? "").trim();
  if (!raw) return { problem: "no token key: set MARCIA_TOKEN_KEY_FILE to the file holding Marcia's token key, or MARCIA_TOKEN_KEY_A" };
  if (raw === FIXTURE_TOKEN_KEY) return { problem: "the token key is the public fixture key, which production never accepts" };
  const { keys } = usableTokenKeys([raw]);
  return keys.length === 1 ? { key: raw } : { problem: "the token key is too short to be the production key" };
}

/**
 * The claims of one test token: test flagged, so the call is routed to the partner
 * test bucket, and carrying NO name, email or phone, so the move must fill them.
 * One per call, each with its own nonce, as Marcia signs one per attempt.
 */
export function leadFillClaims(leadId: string, nowMs: number, nonce: string): Record<string, unknown> {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: MACHINE_TOKEN_ISSUER,
    aud: MACHINE_TOKEN_AUDIENCE,
    iat,
    exp: iat + 10 * 60,
    nonce,
    salesforce_id: leadId,
    bucket_code: PARTNER_BUCKET_CODE,
    time_zone: RUN_TIME_ZONE,
    test: true,
  };
}

/** A nonce no earlier run used: the run's start and the call's number. */
export function runNonce(runStartedMs: number, n: number): string {
  return `lead-fill-check-${runStartedMs}-${n}`;
}

export interface LeadFacts {
  email: string | null;
  phone: string | null;
}

/**
 * Why this Lead cannot prove the fill, or null. It needs an email and a phone to be
 * filled with, and the email must be a Pennie address, because the moved and the
 * cancelled invites go to whatever address the fill writes.
 */
export function leadProblem(lead: LeadFacts | null): string | null {
  if (!lead) return "Salesforce holds no Lead with this id";
  const missing = [lead.email ? null : "Email", lead.phone ? null : "Phone or MobilePhone"].filter(Boolean);
  if (missing.length > 0) return `the Lead has no ${missing.join(" and no ")}, so there is nothing to fill`;
  if (!lead.email!.trim().toLowerCase().endsWith(INVITE_DOMAIN)) {
    return `the Lead's Email is not a ${INVITE_DOMAIN} address, and the moved call's invite would go to it`;
  }
  return null;
}

/**
 * Why Slate would answer before Salesforce, or null. The move fills from the lead's
 * earlier test bookings FIRST, so any that hold an email or a phone keep the Lead from
 * being asked; and an active call in either world would be the one moved.
 */
export function slateAnswersFirst(known: LeadFacts | null, activeCalls: number): string | null {
  if (activeCalls > 0) return `the lead already holds ${activeCalls} active call(s); cancel them or use another test lead`;
  const held = [known?.email ? "an email" : null, known?.phone ? "a phone" : null].filter(Boolean);
  return held.length > 0 ? `the lead's earlier test bookings hold ${held.join(" and ")}, which a move uses before asking Salesforce; use a lead with none` : null;
}

const digits = (v: string) => v.replace(/\D/g, "");
/** Two phone numbers are one when their last ten digits agree (the US national number). */
export function samePhone(a: string, b: string): boolean {
  const x = digits(a);
  const y = digits(b);
  return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10);
}
export const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What the moved booking holds against what the Lead holds, by field and never by
 * value. Proven only when both are present and agree: with no earlier booking holding
 * either (checked first), the Lead is the only place they could have come from.
 */
export function fillVerdict(row: { attendee_email: string | null; attendee_phone: string | null }, lead: LeadFacts): { ok: true } | { ok: false; why: string } {
  const problems: string[] = [];
  if (!row.attendee_email) problems.push("email not filled");
  else if (!lead.email || !sameEmail(row.attendee_email, lead.email)) problems.push("email filled with something other than the Lead's");
  if (!row.attendee_phone) problems.push("phone not filled");
  else if (!lead.phone || !samePhone(row.attendee_phone, lead.phone)) problems.push("phone filled with something other than the Lead's");
  return problems.length === 0 ? { ok: true } : { ok: false, why: problems.join("; ") };
}

/** One JSON-RPC tools/call body. */
export function toolCall(id: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

/**
 * The booking MCP's answer to a tools/call, read: the tool's own answer (Slate's
 * gateway body), or a description of why there is none. Only codes and classes are
 * ever described, never a token, a value or a label.
 */
export function readToolAnswer(status: number, text: string): { ok: true; body: Record<string, unknown> } | { ok: false; why: string } {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return { ok: false, why: `HTTP ${status}, and the body is not JSON` };
  }
  const m = msg as { result?: { structuredContent?: unknown; isError?: boolean }; error?: { code?: unknown } };
  if (m.error) return { ok: false, why: `HTTP ${status}, JSON-RPC error ${String(m.error.code)}` };
  const body = m.result?.structuredContent;
  if (!body || typeof body !== "object") return { ok: false, why: `HTTP ${status}, and the answer carries no structured content (Slate unreachable?)` };
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return { ok: false, why: `refused ${String(b.code)} (${String(b.class)})` };
  return { ok: true, body: b };
}
