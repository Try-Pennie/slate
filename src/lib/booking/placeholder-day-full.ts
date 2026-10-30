/**
 * #4391: the code a refusal carries when a program lead picked one of the placeholder's
 * extra times on a day whose placeholder day limit is reached. Its own module, with no
 * imports, so the booker and the manage page can tell it from a taken time (L35) without
 * pulling the server's booking code into the client bundle.
 */
export const PLACEHOLDER_DAY_FULL_CODE = "PLACEHOLDER_DAY_FULL";
