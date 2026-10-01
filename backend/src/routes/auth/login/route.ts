
import { getSettings } from "../../../lib/localDb.js";
import bcrypt from "bcryptjs";
import { setDashboardAuthCookie } from "../../../lib/auth/dashboardSession.js";
import { isOidcConfigured } from "../../../lib/auth/oidc.js";
import { checkLock, recordFail, recordSuccess, getClientIp } from "../../../lib/auth/loginLimiter.js";

const RESET_HINT = "Forgot password? Restore access from the host by updating the dashboard authentication settings.";

function isTunnelRequest(req, settings) {
  const host = (req.headers["host"] || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

export async function POST_handler(req, res) {
  try {
    const ip = getClientIp(req);
    const lock = checkLock(ip);
    if (lock.locked) {
      res.setHeader("Retry-After", String(lock.retryAfter));
      return res.status(429).json({ 
        error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`,
        retryAfter: lock.retryAfter, 
        resetHint: RESET_HINT 
      });
    }

    const { password } = req.body;
    const settings = await getSettings();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelRequest(req, settings) && settings.tunnelDashboardAccess !== true) {
      return res.status(403).json({ error: "Dashboard access via tunnel is disabled" });
    }

    const storedHash = settings.password;

    if (settings.authMode === "oidc" && isOidcConfigured(settings)) {
      return res.status(403).json({ error: "Password login is disabled. Use OIDC sign in." });
    }

    let isValid = false;
    if (storedHash) {
      isValid = await bcrypt.compare(password, storedHash);
    } else {
      const initialPassword = process.env.INITIAL_PASSWORD;
      if (!initialPassword) {
        return res.status(503).json({
          error: "Dashboard password is not configured. Set INITIAL_PASSWORD or configure a password locally.",
        });
      }
      isValid = password === initialPassword;
    }

    if (isValid) {
      recordSuccess(ip);
      await setDashboardAuthCookie(res, req);

      return res.json({ success: true });
    }

    const { remainingBeforeLock } = recordFail(ip);
    const postLock = checkLock(ip);
    if (postLock.locked) {
      res.setHeader("Retry-After", String(postLock.retryAfter));
      return res.status(429).json({ 
        error: `Too many failed attempts. Try again in ${postLock.retryAfter}s.`,
        retryAfter: postLock.retryAfter, 
        resetHint: RESET_HINT 
      });
    }
    return res.status(401).json({ 
      error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`, 
      remainingBeforeLock 
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
