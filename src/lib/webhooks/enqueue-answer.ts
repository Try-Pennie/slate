/**
 * What `enqueue_webhook_deliveries` answers (#3495): how many endpoints subscribe to
 * the event, and each delivery it WROTE (a repeat of the same logical event writes
 * none), with the endpoint it is for and the payload exactly as stored. The first
 * send posts that stored payload, so it and every retry send the same body.
 *
 * Imports NOTHING, so the real database suite reads an answer with the same reader the
 * Worker uses (scripts/verify-webhook-enqueue-sql.ts runs on bare node with no path
 * aliases), and the db-replay job's trigger paths stay these two files rather than the
 * whole database types graph a type import would pull in. The formats an endpoint may
 * carry are therefore the caller's to pass: the Worker passes `WEBHOOK_FORMATS`' keys.
 */
/** The endpoint row a delivery is for, as the function answers it (the table's columns). */
export interface EnqueuedEndpoint {
  id: string;
  org_id: string;
  url: string;
  secret: string | null;
  events: string[];
  format: string;
  auth_header: string | null;
  active: boolean;
  created_at: string;
}

export interface EnqueuedDelivery {
  id: string;
  /** Recorded in a terminal state and never POSTed (#459, #2073). */
  suppressed: boolean;
  payload: Record<string, unknown>;
  endpoint: EnqueuedEndpoint;
}

export interface EnqueueAnswer {
  subscribers: number;
  deliveries: EnqueuedDelivery[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The answer, or a refusal naming what could not be read. Never a guess: an answer
 * read as "nothing to send" when it was really unreadable is a webhook dropped with no
 * failure, which is the silent loss #1036 and #1459 were opened about (L505, L425).
 */
export function readEnqueueAnswer(data: unknown, knownFormats: readonly string[]): EnqueueAnswer {
  if (!isObject(data)) throw new Error("the webhook enqueue answer was not an object");
  const subscribers = data.subscribers;
  if (typeof subscribers !== "number" || !Number.isInteger(subscribers) || subscribers < 0) {
    throw new Error(`the webhook enqueue answer's subscribers was not a count: ${JSON.stringify(subscribers)}`);
  }
  if (!Array.isArray(data.deliveries)) throw new Error("the webhook enqueue answer carried no deliveries list");
  // At most one delivery per subscriber: more means the answer is not the one asked.
  if (data.deliveries.length > subscribers) {
    throw new Error(`the webhook enqueue answer has ${data.deliveries.length} deliveries for ${subscribers} subscribers`);
  }
  const deliveries = data.deliveries.map((raw, i): EnqueuedDelivery => {
    if (!isObject(raw)) throw new Error(`webhook enqueue delivery ${i + 1} was not an object`);
    if (typeof raw.id !== "string" || raw.id === "") throw new Error(`webhook enqueue delivery ${i + 1} has no id`);
    if (typeof raw.suppressed !== "boolean") throw new Error(`webhook enqueue delivery ${i + 1}'s suppressed was not true or false`);
    if (!isObject(raw.payload)) throw new Error(`webhook enqueue delivery ${i + 1}'s payload was not an object`);
    return { id: raw.id, suppressed: raw.suppressed, payload: raw.payload, endpoint: readEndpoint(raw.endpoint, i + 1, knownFormats) };
  });
  return { subscribers, deliveries };
}

/** The endpoint row a delivery is for, with every field a send reads checked. */
function readEndpoint(raw: unknown, n: number, knownFormats: readonly string[]): EnqueuedEndpoint {
  if (!isObject(raw)) throw new Error(`webhook enqueue delivery ${n} has no endpoint`);
  for (const field of ["id", "org_id", "url"] as const) {
    if (typeof raw[field] !== "string" || raw[field] === "") throw new Error(`webhook enqueue delivery ${n}'s endpoint has no ${field}`);
  }
  if (typeof raw.format !== "string" || !knownFormats.includes(raw.format)) {
    throw new Error(`webhook enqueue delivery ${n}'s endpoint has a format Slate does not know: ${JSON.stringify(raw.format)}`);
  }
  if (typeof raw.active !== "boolean") throw new Error(`webhook enqueue delivery ${n}'s endpoint has no active flag`);
  if (!Array.isArray(raw.events)) throw new Error(`webhook enqueue delivery ${n}'s endpoint has no events list`);
  return {
    id: raw.id as string,
    org_id: raw.org_id as string,
    url: raw.url as string,
    secret: typeof raw.secret === "string" ? raw.secret : null,
    events: raw.events.map(String),
    format: raw.format,
    auth_header: typeof raw.auth_header === "string" ? raw.auth_header : null,
    active: raw.active,
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
  };
}
