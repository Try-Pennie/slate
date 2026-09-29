// Where the list of retired booking key hashes is kept in the repo (#2879).
//
// The Worker reads the list from the BOOKING_API_RETIRED_KEY_HASHES secret, and a
// secret can be neither read back nor appended to: `wrangler secret put` replaces
// it whole. So the list lives here too, one `label:sha256:<hash>` entry per line.
// Hashes are not secret. `pnpm hash:retired-key` adds the new entry to this file and
// prints the whole list for the secret, and the file is committed alongside.
export const RETIRED_KEY_HASHES_FILE = "docs/retired-booking-key-hashes.txt";
