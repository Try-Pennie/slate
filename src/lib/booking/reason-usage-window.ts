/** Default lookback for "recently used" (#990): a full quarter, so a seasonal or
 *  lower-frequency reason is not mistaken for unused. The reason editor prints it,
 *  so it lives apart from `reason-usage.ts`, which imports the secret key client
 *  and would ship it to the browser with the constant (#3172). */
export const REASON_USAGE_WINDOW_DAYS = 90;
