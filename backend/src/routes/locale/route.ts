
import { LOCALE_COOKIE, normalizeLocale, isSupportedLocale } from "../../i18n/config.js";

export async function POST_handler(req, res) {
  try {
    const { locale } = req.body;
    
    if (!locale || !isSupportedLocale(locale)) {
      return res.status(400).json({ error: "Invalid locale" });
    }

    const normalized = normalizeLocale(locale);
    const cookieStore = { get: (k) => ({ value: (req).cookies?.[k] }) };
    cookieStore.set(LOCALE_COOKIE, normalized, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365, // 1 year
    });

    return res.json({ success: true, locale: normalized });
  } catch (error) {
    return res.status(500).json({ error: "Failed to set locale" });
  }
}
