
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { getDataDir } from "../../../../lib/dataDir.js";

// Parse any proxy string format → { server, username, password }
function parseProxyString(raw) {
  if (!raw) return null;
  raw = raw.trim();
  const badUrl = raw.match(/^(https?|socks[45]?):\/\/([^:]+):(\d+):([^:]+):(.+)$/);
  if (badUrl) {
    const [, , host, port, user, pass] = badUrl;
    return { server: `http://${host}:${port}`, username: user, password: pass };
  }
  const goodUrl = raw.match(/^(socks[45]?|https?|http):\/\/(?:([^:@]+):([^@]+)@)?([^:]+):(\d+)$/);
  if (goodUrl) {
    const [, proto, user, pass, host, port] = goodUrl;
    const r = { server: `${proto}://${host}:${port}` };
    if (user) r.username = user;
    if (pass) r.password = pass;
    return r;
  }
  const parts = raw.split(":");
  if (parts.length === 4 && /^\d+$/.test(parts[1]))
    return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
  if (parts.length === 2 && /^\d+$/.test(parts[1]))
    return { server: `http://${parts[0]}:${parts[1]}` };
  return null;
}
import { getSettings } from "../../../../lib/localDb.js";
import { 
  getCodeBuddyAccount, deleteCodeBuddyAccount, markCodeBuddyRunning,
  markCodeBuddySuccess, markCodeBuddyError, markCanvaEnrolled, createCodeBuddyJob, updateCodeBuddyJobResult,
  createProviderConnection, getProviderConnections, updateCodeBuddyJobStatus,
  deleteProviderConnectionByEmailAndProvider
} from "../../../../lib/db/index.js";

export const dynamic = "force-dynamic";

export async function POST_handler(req, res, { params }) {
  try {
    const resolvedParams = await params;
    const accountId = parseInt(resolvedParams.id);
    const body = req.body;
    const { action, deleteFrom9router } = body;

    const account = await getCodeBuddyAccount(accountId);
    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    // ── Action: Run single account automation ────────────────────────
    if (action === "run") {
      if (global._codebuddyState?.activeJobId) {
        return res.status(400).json({ error: "Another job is already running." });
      }

      const jobId = uuidv4();
      await createCodeBuddyJob(jobId, "signup", 1);
      
      // Background worker run single
      runSingleJob(jobId, accountId).catch(console.error);

      return res.json({ job_id: jobId, count: 1 });
    }

    // ── Action: Inject API key to 9router ───────────────────────────
    if (action === "add-to-9router") {
      if (account.apiKeyStatus !== "ready" || !account.apiKey) {
        return res.status(400).json({ error: "The account is not ready (restricted or failed)." });
      }

      try {
        const provider = account.provider || "codebuddy";
        const connData = {
          provider: provider,
          authType: "apikey",
          name: account.email,
          apiKey: account.apiKey,
          email: account.email,
          priority: 1,
          isActive: true,
          testStatus: "unknown",
        };

        // Leonardo and Weavy use cookie-based auth — the apiKey in codebuddyAccounts
        // is actually the browser cookie string from the signup automation
        if (provider === "leonardo" || provider === "weavy") {
          connData.authType = "cookie";
          connData.cookie = account.apiKey;
          delete connData.apiKey;
        } else if (provider === "kimi-coding") {
          connData.authType = "oauth";
          connData.accessToken = account.apiKey;
        } else if (provider === "kiro" || provider === "qoder") {
          connData.accessToken = account.apiKey;
          if (provider === "qoder") {
            connData.providerSpecificData = {
              userId: account.email,
            };
          }
        }

        await createProviderConnection(connData);
        return res.json({ ok: true, email: account.email, message: `✓ ${account.email} was added to the ${provider} provider in SYNS4033ROUTER.` });
      } catch (e) {
        return res.status(500).json({ error: `Failed to add the account to SYNS4033ROUTER: ${e.message}` });
      }
    }

    // ── Action: Delete account ───────────────────────────────────────
    if (action === "delete") {
      if (deleteFrom9router && account.email && account.provider) {
        await deleteProviderConnectionByEmailAndProvider(account.email, account.provider);
      }
      await deleteCodeBuddyAccount(accountId);
      
      // Delete profile dir
      if (account.profileDir && fs.existsSync(account.profileDir)) {
        try {
          fs.rmSync(account.profileDir, { recursive: true, force: true });
        } catch (e) {
          console.error("Failed to delete profile dir:", account.profileDir, e);
        }
      }
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    console.error("Error in POST /api/automation/codebuddy/[id]:", error);
    return res.status(500).json({ error: error.message });
  }
}

async function runSingleJob(jobId, accountId) {
  global._codebuddyState.activeJobId = jobId;
  global._codebuddyState.stopFlag = false;

  try {
    await updateCodeBuddyJobStatus(jobId, "running");
    const settings = await getSettings();

    await markCodeBuddyRunning(accountId);
    await updateCodeBuddyJobResult(jobId, 0, {
      status: "running",
      step: "Starting browser automation..."
    });

    await executeCodeBuddySignupSingle(accountId, jobId, settings);
  } catch (e) {
    console.error("Error running single CodeBuddy job:", e);
  } finally {
    global._codebuddyState.activeJobId = null;
    const finalStatus = global._codebuddyState.stopFlag ? "stopped" : "completed";
    await updateCodeBuddyJobStatus(jobId, finalStatus);
  }
}

function executeCodeBuddySignupSingle(accountId, jobId, settings) {
  return new Promise(async (resolve, reject) => {
    try {
      const account = await getCodeBuddyAccount(accountId);
      if (!account) return reject(new Error("Account not found"));

      const isLeonardo = account.provider === "leonardo";
      const isWeavy = account.provider === "weavy";
      const isKimi = account.provider === "kimi-coding" || account.provider === "kimi";
      const isQoder = account.provider === "qoder";
      const isCloudflare = account.provider === "cloudflare";
      if (isLeonardo && !settings.leonardo_invite_link) {
        return reject(new Error("The Leonardo invite link is not configured in Settings."));
      }

function missingSignupRuntime(venvPython, scriptPath) {
  // This route drives a Python script that drives a browser, and this deployment
  // provides neither: the image is node:22-alpine with no interpreter and no
  // virtualenv, and the signup scripts are not in the repository. spawn() then
  // fails with a bare ENOENT for every account, which says nothing about why.
  const missing = [];
  if (!fs.existsSync(venvPython)) missing.push(venvPython);
  if (!fs.existsSync(scriptPath)) missing.push(scriptPath);
  return missing;
}
      const venvPython = path.resolve(process.cwd(), ".venv/bin/python");
      const scriptPath = isLeonardo
        ? path.resolve(process.cwd(), "src/automation/leonardo_signup.py")
        : isWeavy
        ? path.resolve(process.cwd(), "src/automation/weavy_signup.py")
        : isKimi
        ? path.resolve(process.cwd(), "src/automation/kimi_signup.py")
        : isQoder
        ? path.resolve(process.cwd(), "src/automation/qoder_signup.py")
        : isCloudflare
        ? path.resolve(process.cwd(), "src/automation/cloudflare_signup.py")
        : path.resolve(process.cwd(), "src/automation/codebuddy_signup.py");
      const missingRuntime = missingSignupRuntime(venvPython, scriptPath);
      if (missingRuntime.length) {
        const msg = `Signup needs Python and ${scriptPath}, which this deployment does not ` +
          `provide: ${missingRuntime.join(", ")}`;
        await markCodeBuddyError(account.id, msg);
        await updateCodeBuddyJobResult(jobId, 0, {
          email: account.email, status: "failed", error: msg, ok: false,
        });
        return resolve();
      }

      const profilesDir = isLeonardo
        ? path.resolve(process.cwd(), "profiles/leonardo")
        : isWeavy
        ? path.resolve(process.cwd(), "profiles/weavy")
        : isKimi
        ? path.resolve(process.cwd(), "profiles/kimi")
        : isQoder
        ? path.resolve(process.cwd(), "profiles/qoder")
        : isCloudflare
        ? path.resolve(process.cwd(), "profiles/cloudflare")
        : path.resolve(process.cwd(), "profiles/codebuddy");

      const args = [
        scriptPath,
        `--email=${account.email}`,
        `--password=${account.password}`,
        `--profiles-dir=${profilesDir}`,
      ];

      if (isLeonardo) {
        args.push(`--invite-link=${settings.leonardo_invite_link}`);
        args.push(`--signup-method=${account.signupMethod || "google"}`);
        if (account.canvaEnrolled === 1) {
          args.push("--skip-canva");
        }
        if (settings.codebuddy_leave_canva_team === "1") {
          args.push("--leave-canva-team");
        }
      } else if (isCloudflare) {
        const ammailSettings = settings;
        const ammailBaseUrl = ammailSettings.ammail_base_url || "";
        const ammailApiKey = ammailSettings.ammail_api_key || "";
        const ammailDomain = ammailSettings.ammail_default_domain || "";
        if (ammailBaseUrl && ammailApiKey && ammailDomain) {
          args.push(`--ammail-base-url=${ammailBaseUrl}`);
          args.push(`--ammail-api-key=${ammailApiKey}`);
          args.push(`--ammail-domain=${ammailDomain}`);
        }
        const captchaKey = settings.codebuddy_2captcha_api_key || "";
        if (captchaKey) {
          args.push(`--2captcha-key=${captchaKey}`);
        }
      } else if (isWeavy) {
        if (account.signupMethod === "google" || (account.email && (account.email.endsWith("@gmosel.com") || account.email.endsWith("@gmail.com")))) {
          args.push("--gsuite");
        }
        args.push("--clean");
      }

      if (settings.codebuddy_browser_headless !== "0") {
        args.push("--headless");
      }

      if (settings.codebuddy_proxy_enabled === "1" && settings.codebuddy_proxy_pool && !isQoder) {
        try {
          const pool = JSON.parse(settings.codebuddy_proxy_pool);
          if (Array.isArray(pool) && pool.length > 0) {
            const chosen = pool[Math.floor(Math.random() * pool.length)];
            const parsed = parseProxyString(chosen);
            if (parsed) {
              args.push(`--proxy-server=${parsed.server}`);
              if (parsed.username) args.push(`--proxy-user=${parsed.username}`);
              if (parsed.password) args.push(`--proxy-pass=${parsed.password}`);
              console.log(`[proxy] Using: ${parsed.server} (auth: ${!!parsed.username})`);
            } else {
              console.error("[proxy] Could not parse:", chosen);
            }
          }
        } catch (e) {
          console.error("Failed to parse proxy pool:", e);
        }
      }

      try {
        const logDir = path.join(getDataDir(), "logs");
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(
          `${logDir}/automation_spawn.log`,
          `[${new Date().toISOString()}] [id]/route.js spawning python: ${venvPython} ${args.join(" ")}\n`
        );
      } catch (err) {
        console.error("Failed to write to automation_spawn.log:", err);
      }

      const child = spawn(venvPython, args, {
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" }
      });
      if (global._codebuddyState?.activeProcesses) {
        global._codebuddyState.activeProcesses.add(child);
      }
      let lastStep = "Browser diluncurkan...";
      let done = false;

      child.stdout.on("data", async (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.step) {
              lastStep = parsed.step;
              await updateCodeBuddyJobResult(jobId, 0, {
                email: account.email,
                status: "running",
                step: lastStep
              });
            } else if (parsed.canva_enrolled) {
              await markCanvaEnrolled(account.id, 1);
              await updateCodeBuddyJobResult(jobId, 0, {
                email: account.email,
                status: "running",
                step: "Canva enrolled. Connecting to Leonardo AI..."
              });
            } else if (parsed.status === "success") {
              done = true;
              const apiKeyToSave = (isLeonardo || isWeavy) ? parsed.cookie : parsed.api_key;
              await markCodeBuddySuccess(account.id, apiKeyToSave);
              await updateCodeBuddyJobResult(jobId, 0, {
                email: account.email,
                status: "done",
                api_key: apiKeyToSave,
                balance: parsed.balance,
                left_team: parsed.left_team,
                ok: true
              });


              if (settings.codebuddy_auto_9router === "1" || isLeonardo || isWeavy || isKimi || isQoder || isCloudflare) {
                try {
                  const provider = account.provider || "codebuddy";
                  const connData = {
                    provider: provider,
                    authType: (isLeonardo || isWeavy) ? "cookie" : (isKimi || isQoder) ? "oauth" : "apikey",
                    name: account.email,
                    apiKey: apiKeyToSave,
                    email: account.email,
                    priority: 1,
                    isActive: true,
                    testStatus: (isLeonardo || isWeavy || isKimi || isQoder || isCloudflare) ? "active" : "unknown",
                  };

                  if (isLeonardo || isWeavy) {
                    connData.cookie = parsed.cookie;
                    connData.last_balance = parsed.balance !== undefined ? parsed.balance : 150;
                    if (isLeonardo || isWeavy) {
                      connData.accessToken = parsed.jwt;
                      connData.cached_jwt = parsed.jwt;
                      connData.jwt_expires_at = Math.floor(Date.now() / 1000) + 1800;
                    }
                    if (isWeavy && (parsed.firebase_refresh_token || parsed.firebase_api_key)) {
                      connData.providerSpecificData = {
                        firebase_refresh_token: parsed.firebase_refresh_token || "",
                        firebase_api_key: parsed.firebase_api_key || "",
                      };
                    }
                  } else if (isCloudflare) {
                    connData.provider = "cloudflare-ai";
                    connData.authType = "apikey";
                    connData.apiKey = parsed.api_key;
                    connData.providerSpecificData = {
                      accountId: parsed.account_id || "",
                    };
                  } else if (isKimi) {
                    connData.accessToken = parsed.api_key;
                    connData.refreshToken = parsed.refresh_token;
                    connData.expiresAt = parsed.expires_in
                      ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
                      : null;
                  } else if (isQoder) {
                    connData.accessToken = parsed.api_key;
                    connData.refreshToken = parsed.refresh_token;
                    connData.expiresAt = parsed.expires_in
                      ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
                      : null;
                    connData.displayName = parsed.name || null;
                    connData.email = parsed.email || account.email;
                    connData.providerSpecificData = {
                      authMethod: "device",
                      userId: parsed.user_id || "",
                      machineId: parsed.machine_id || "",
                      organizationId: parsed.organization_id || "",
                    };
                  } else if (provider === "kiro") {
                    connData.accessToken = apiKeyToSave;
                  }

                  await createProviderConnection(connData);
                } catch (e) {
                  console.error("Auto add to 9router failed:", e);
                }
              }
            } else if (parsed.status === "error") {
              done = true;
              await markCodeBuddyError(account.id, parsed.message);
              await updateCodeBuddyJobResult(jobId, 0, {
                email: account.email,
                status: "failed",
                error: parsed.message,
                ok: false
              });
            }
          } catch (e) {
            // ignore
          }
        }
      });

      child.on("close", async (code) => {
        if (global._codebuddyState?.activeProcesses) {
          global._codebuddyState.activeProcesses.delete(child);
        }
        if (!done) {
          const errMsg = global._codebuddyState?.stopFlag 
            ? "Stopped by the user."
            : `Process stopped with exit code ${code}.`;
          await markCodeBuddyError(account.id, errMsg);
          await updateCodeBuddyJobResult(jobId, 0, {
            email: account.email,
            status: "failed",
            error: errMsg,
            ok: false
          });
        }
        resolve();
      });

      child.on("error", async (err) => {
        if (global._codebuddyState?.activeProcesses) {
          global._codebuddyState.activeProcesses.delete(child);
        }
        if (!done) {
          const errMsg = global._codebuddyState?.stopFlag 
            ? "Stopped by the user."
            : (err.message || String(err));
          await markCodeBuddyError(account.id, errMsg);
          await updateCodeBuddyJobResult(jobId, 0, {
            email: account.email,
            status: "failed",
            error: errMsg,
            ok: false
          });
        }
        resolve();
      });

    } catch (e) {
      reject(e);
    }
  });
}
