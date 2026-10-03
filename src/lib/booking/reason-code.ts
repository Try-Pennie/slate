// The two reason rules the admin editor applies in the browser as well as the
// server: the label bound and how a label becomes its code. They live apart from
// `reason-options.ts`, which imports the secret key client, so the editor can use
// them without shipping that client to the browser (#3172).

/** Max length of a reason label (the admin editor enforces the same bound). */
export const REASON_LABEL_MAX = 80;

/**
 * Derive a stable analytics code from a human label: lowercase, keep [a-z0-9],
 * collapse any run of other characters to a single underscore, trim leading and
 * trailing underscores. A label with no usable characters yields "" and the
 * caller must reject it (a code can never be empty).
 */
export function slugifyCode(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
