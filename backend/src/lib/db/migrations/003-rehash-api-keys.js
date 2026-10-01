// Keys were stored in the clear before bca7ab6 and are hashed after it.
// validateApiKey() has only ever looked a key up by
// sha256(salt + ":" + key), so every row still holding plaintext stopped
// matching the moment hashing landed: the operator's own keys all began
// returning 401 while the dashboard kept working, because the dashboard
// authenticates with a session cookie rather than an API key.
//
// There was no migration to bridge the two, so the keys stayed dead for the
// life of the database.
//
// Hashing is imported rather than copied: a second copy of the salt would
// quietly produce different digests and make this migration a no-op that looks
// like it ran.
//
// Idempotent by construction — a stored value that is already 64 hex characters
// is a digest and is left alone, so re-running this is safe.
import { hashApiKey } from "../repos/apiKeysRepo.js";

const IS_SHA256_HEX = /^[0-9a-f]{64}$/;

export default {
  version: 3,
  name: "rehash-plaintext-api-keys",
  up(db) {
    // The table may not exist on a database created before API keys were
    // introduced; the initial migration owns it, and this runs after that.
    const exists = db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='apiKeys'"
    );
    if (!exists) return { rehashed: 0, skipped: 0, reason: "no apiKeys table" };

    // The adapter takes (sql, params); it has no prepare(), and these calls are
    // synchronous because the migration runner wraps them in one transaction.
    const rows = db.all("SELECT id, key FROM apiKeys");

    let rehashed = 0;
    let skipped = 0;
    for (const row of rows) {
      if (typeof row.key !== "string" || IS_SHA256_HEX.test(row.key)) {
        skipped += 1;
        continue;
      }
      db.run("UPDATE apiKeys SET key = ? WHERE id = ?", [hashApiKey(row.key), row.id]);
      rehashed += 1;
    }

    if (rehashed > 0) {
      console.log(
        `[migrate] re-hashed ${rehashed} API key(s) stored in plaintext; ${skipped} already hashed`
      );
    }
    return { rehashed, skipped };
  },
};