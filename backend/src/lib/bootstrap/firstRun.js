// First-run bootstrap: make a fresh deploy usable without touching Railway's
// variable editor.
//
// Every secret the app needs is either supplied by the environment or
// generated here and persisted to the settings row, then pushed back into
// process.env so the modules that read it see one value for the whole process.
// A dashboard password is generated the same way when neither a stored hash
// nor INITIAL_PASSWORD is present, and printed once to the boot log so the
// operator can log in and change it.
//
// The password is random, never a shared default. A fixed default would hand
// the first stranger who found the URL an authenticated instance.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const SECRET_KEYS = [
  ["JWT_SECRET", 48],
  ["API_KEY_SECRET", 48],
  ["MACHINE_ID_SALT", 32],
];

// How long a generated password is, and which characters it may use. Ambiguous
// glyphs (0/O, 1/l/I) are left out because this gets typed off a log by hand.
const PASSWORD_LENGTH = 20;
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const randomString = (length) => {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
};

const banner = (lines) => {
  const bar = "─".repeat(Math.max(...lines.map((l) => l.length)) + 4);
  console.log(`\n┌${bar}┐`);
  for (const l of lines) console.log(`│  ${l.padEnd(bar.length - 4)}  │`);
  console.log(`└${bar}┘`);
};

/**
 * @param {{getSettings: Function, updateSettings: Function}} db
 * @returns {Promise<{generatedPassword: string|null, generatedSecrets: string[]}>}
 */
export async function runFirstRunBootstrap(db) {
  const { getSettings, updateSettings } = db;
  const settings = await getSettings();

  // 1. Secrets. Environment wins; otherwise reuse what we stored last boot so
  //    sessions and API keys survive a restart.
  const updates = {};
  const generatedSecrets = [];

  for (const [key, length] of SECRET_KEYS) {
    if (process.env[key]) continue;
    const stored = settings[key];
    if (stored) {
      process.env[key] = stored;
      continue;
    }
    const value = randomString(length);
    updates[key] = value;
    process.env[key] = value;
    generatedSecrets.push(key);
  }

  // 2. Dashboard password.
  let generatedPassword = null;
  const hasStoredPassword = !!settings.password;
  const hasEnvPassword = !!process.env.INITIAL_PASSWORD;

  if (!hasStoredPassword && !hasEnvPassword) {
    generatedPassword = randomString(PASSWORD_LENGTH);
    updates.password = await bcrypt.hash(generatedPassword, 10);
    // Marks the account as still on its generated credential so the dashboard
    // can keep reminding the operator to change it.
    updates.passwordIsGenerated = true;
  }

  if (Object.keys(updates).length === 0) {
    return { generatedPassword, generatedSecrets };
  }

  await updateSettings(updates);

  if (generatedPassword) {
    banner([
      "Dashboard password was not configured, so one was generated.",
      "",
      `    password:  ${generatedPassword}`,
      "",
      "Open the dashboard and log in with it, then change it under",
      "Settings. This is printed once and never again.",
    ]);
  }

  if (generatedSecrets.length) {
    console.log(
      `[bootstrap] generated and stored: ${generatedSecrets.join(", ")}` +
        " (set them as variables to manage them yourself)"
    );
  }

  return { generatedPassword, generatedSecrets };
}
