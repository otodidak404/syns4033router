
import { useState } from "react";

export default function AmmailTutorialPage() {
  const [copiedStates, setCopiedStates] = useState({});

  const handleCopy = (val) => {
    navigator.clipboard.writeText(val);
    setCopiedStates((prev) => ({ ...prev, [val]: true }));
    setTimeout(() => {
      setCopiedStates((prev) => ({ ...prev, [val]: false }));
    }, 1500);
  };

  const CopyButton = ({ value, text = "Copy", className = "" }) => {
    const isCopied = copiedStates[value];
    return (
      <button
        type="button"
        onClick={() => handleCopy(value)}
        className={`text-xs px-3 py-1 rounded cursor-pointer transition-all duration-150 flex items-center gap-1 border font-semibold shrink-0 ${
          isCopied
            ? "text-green-400 bg-green-500/10 border-green-500/20"
            : "text-white/50 hover:text-white bg-white/5 hover:bg-white/10 border-transparent"
        } ${className}`}
      >
        <span className="material-symbols-outlined text-[14px]">{isCopied ? "check" : "content_copy"}</span>
        {isCopied ? "Copied" : text}
      </button>
    );
  };

  return (
    <div className="max-w-3xl mx-auto py-8 px-4 text-white space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 pb-5">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-primary text-[28px]">auto_stories</span>
          <div>
            <h1 className="text-xl font-bold">Complete Temporary Mail Deployment Guide</h1>
            <p className="text-xs text-white/50 mt-0.5">Cloudflare Worker and D1 Database integration guide for SYNS4033ROUTER</p>
          </div>
        </div>
        <div className="flex gap-2">
          <a
            href="/dashboard/automation"
            className="px-3.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs font-semibold hover:bg-white/10 transition-colors cursor-pointer"
          >
            Back to Dashboard
          </a>
        </div>
      </div>

      <div className="space-y-6 text-sm leading-relaxed text-white/80">
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 text-xs text-primary/95 flex items-start gap-3">
          <span className="material-symbols-outlined shrink-0 mt-0.5">lightbulb</span>
          <p>
            <strong>Important:</strong> Use this guide for manual Cloudflare deployment with the CLI. For automatic setup, return to the Dashboard and use the <strong>⚡ Auto Deploy (Cloudflare)</strong> for one-click setup.
          </p>
        </div>

        {/* Step 1 */}
        <div className="bg-neutral-900 border border-white/5 rounded-xl p-6 space-y-4">
          <h4 className="text-base font-bold text-white flex items-center gap-2">
            <span className="bg-primary/20 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">1</span>
            Prerequisites and Cloudflare Login
          </h4>
          <p>
            Make sure Node.js is installed. Open a terminal and authenticate your Cloudflare account with the Wrangler CLI:
          </p>
          <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10 font-mono text-xs text-amber-300 gap-4">
            <span className="break-all">npx wrangler login</span>
            <CopyButton value="npx wrangler login" />
          </div>
        </div>

        {/* Step 2 */}
        <div className="bg-neutral-900 border border-white/5 rounded-xl p-6 space-y-4">
          <h4 className="text-base font-bold text-white flex items-center gap-2">
            <span className="bg-primary/20 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">2</span>
            Open the Directory and Install Dependencies
          </h4>
          <p>
            Open a terminal in your local worker directory (`tempmail`) and install the package dependencies:
          </p>
          <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10 font-mono text-xs text-amber-300 gap-4">
            <span className="break-all">cd /home/data/Project/9router/tempmail && npm install</span>
            <CopyButton value="cd /home/data/Project/9router/tempmail && npm install" />
          </div>
        </div>

        {/* Step 3 */}
        <div className="bg-neutral-900 border border-white/5 rounded-xl p-6 space-y-4">
          <h4 className="text-base font-bold text-white flex items-center gap-2">
            <span className="bg-primary/20 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">3</span>
            Create a Cloudflare D1 Database
          </h4>
          <p>
            New database name: <code>tempmail</code> in Cloudflare D1 stores mailbox data and message content:
          </p>
          <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10 font-mono text-xs text-amber-300 gap-4">
            <span className="break-all">npx wrangler d1 create tempmail</span>
            <CopyButton value="npx wrangler d1 create tempmail" />
          </div>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3.5 text-xs text-amber-300 flex items-start gap-2.5">
            <span className="material-symbols-outlined shrink-0 mt-0.5">warning</span>
            <span>
              The command above returns **database_id** (UUID). Copy that ID, open <code className="bg-white/10 px-1 py-0.5 rounded font-mono text-white">wrangler.jsonc</code> in your tempmail project, and replace <code>database_id</code> with the new ID.
            </span>
          </div>
        </div>

        {/* Step 4 */}
        <div className="bg-neutral-900 border border-white/5 rounded-xl p-6 space-y-4">
          <h4 className="text-base font-bold text-white flex items-center gap-2">
            <span className="bg-primary/20 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">4</span>
            Run D1 Database Migrations
          </h4>
          <p>
            Create the required tables by applying the database migrations to Cloudflare:
          </p>
          <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10 font-mono text-xs text-amber-300 gap-4">
            <span className="break-all">npx wrangler d1 migrations apply tempmail --remote</span>
            <CopyButton value="npx wrangler d1 migrations apply tempmail --remote" />
          </div>
        </div>

        {/* Step 5 */}
        <div className="bg-neutral-900 border border-white/5 rounded-xl p-6 space-y-4">
          <h4 className="text-base font-bold text-white flex items-center gap-2">
            <span className="bg-primary/20 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">5</span>
            Create an API Access Key for SYNS4033ROUTER
          </h4>
          <p>
            SYNS4033ROUTER communicates with the Worker through a secure API key. Run this SQL command to register the SYNS4033ROUTER administrator in your D1 database:
          </p>
          <div className="space-y-3">
            <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10 font-mono text-xs text-amber-300 gap-4">
              <span className="break-all overflow-hidden text-ellipsis">
                npx wrangler d1 execute tempmail --remote --command="INSERT OR IGNORE INTO chats (chat_id, username, first_name, last_name, created_at, updated_at) VALUES ('9router', '9router_admin', 'SYNS4033ROUTER', 'Admin', datetime('now'), datetime('now')); INSERT OR REPLACE INTO api_access (user_id, api_key, quota_daily, quota_used, quota_date, granted_by, granted_at, expires_at) VALUES ('9router', 'tm_YOUR_SECURE_API_KEY', 0, 0, strftime('%Y-%m-%d', 'now'), 'admin', datetime('now'), '2099-12-31T23:59:59Z');"
              </span>
              <CopyButton value={`npx wrangler d1 execute tempmail --remote --command="INSERT OR IGNORE INTO chats (chat_id, username, first_name, last_name, created_at, updated_at) VALUES ('9router', '9router_admin', 'SYNS4033ROUTER', 'Admin', datetime('now'), datetime('now')); INSERT OR REPLACE INTO api_access (user_id, api_key, quota_daily, quota_used, quota_date, granted_by, granted_at, expires_at) VALUES ('9router', 'tm_YOUR_SECURE_API_KEY', 0, 0, strftime('%Y-%m-%d', 'now'), 'admin', datetime('now'), '2099-12-31T23:59:59Z');"`} />
            </div>
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3.5 text-xs text-amber-300 flex items-start gap-2.5">
              <span className="material-symbols-outlined shrink-0 mt-0.5">info</span>
              <span>
                Replace <code>tm_YOUR_SECURE_API_KEY</code> with a random API key (for example, <code>tm_</code> followed by random hexadecimal characters). Copy this API key into your SYNS4033ROUTER settings.
              </span>
            </div>
          </div>
        </div>

        {/* Step 6 */}
        <div className="bg-neutral-900 border border-white/5 rounded-xl p-6 space-y-4">
          <h4 className="text-base font-bold text-white flex items-center gap-2">
            <span className="bg-primary/20 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">6</span>
            Configure Secret Tokens (Telegram and Webhook)
          </h4>
          <p>
            Store the Telegram bot token and webhook secret as Cloudflare secret variables:
          </p>
          <div className="space-y-3">
            <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10 font-mono text-xs text-amber-300 gap-4">
              <span className="break-all">npx wrangler secret put TELEGRAM_BOT_TOKEN</span>
              <CopyButton value="npx wrangler secret put TELEGRAM_BOT_TOKEN" />
            </div>
            <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10 font-mono text-xs text-amber-300 gap-4">
              <span className="break-all">npx wrangler secret put TELEGRAM_WEBHOOK_SECRET</span>
              <CopyButton value="npx wrangler secret put TELEGRAM_WEBHOOK_SECRET" />
            </div>
          </div>
        </div>

        {/* Step 7 */}
        <div className="bg-neutral-900 border border-white/5 rounded-xl p-6 space-y-4">
          <h4 className="text-base font-bold text-white flex items-center gap-2">
            <span className="bg-primary/20 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">7</span>
            Deploy to Cloudflare Workers
          </h4>
          <p>
            Open the <code className="bg-white/10 px-1 py-0.5 rounded font-mono text-white">wrangler.jsonc</code>, adjust the <code>vars</code> (domain and base URL) values for your domain, then deploy to Cloudflare:
          </p>
          <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10 font-mono text-xs text-amber-300 gap-4">
            <span className="break-all">npx wrangler deploy</span>
            <CopyButton value="npx wrangler deploy" />
          </div>
        </div>

        {/* Step 8 */}
        <div className="bg-neutral-900 border border-white/5 rounded-xl p-6 space-y-4">
          <h4 className="text-base font-bold text-white flex items-center gap-2">
            <span className="bg-primary/20 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">8</span>
            Register the Telegram Bot Webhook (Optional)
          </h4>
          <p>
            Register your worker domain with the Telegram API so the bot can receive commands immediately:
          </p>
          <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10 font-mono text-xs text-amber-300 gap-4">
            <span className="break-all">
              {'curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -H "Content-Type: application/json" -d \'{"url":"https://<worker-host>/telegram/webhook","secret_token":"<WEBHOOK_SECRET>"}\''}
            </span>
            <CopyButton value={`curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -H "Content-Type: application/json" -d '{"url":"https://<worker-host>/telegram/webhook","secret_token":"<WEBHOOK_SECRET>"}'`} />
          </div>
        </div>

        {/* Step 9 */}
        <div className="bg-neutral-900 border border-white/5 rounded-xl p-6 space-y-4">
          <h4 className="text-base font-bold text-white flex items-center gap-2">
            <span className="bg-primary/20 text-primary w-6 h-6 rounded-full flex items-center justify-center text-xs">9</span>
            Configure Cloudflare Email Routing and DNS
          </h4>
          <p>
            This step allows the deployed Worker to receive and process email. Open your Cloudflare dashboard and follow these instructions:
          </p>
          
          <div className="space-y-4 border-l-2 border-primary/30 pl-4 mt-2">
            <div>
              <h5 className="font-bold text-white text-xs flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>
                Part A: Synchronize and Lock DNS Records
              </h5>
              <p className="text-xs text-white/70 mt-1">
                If your DNS status is <code className="bg-white/10 text-white px-1 rounded">Not configured</code> or a record has the <code className="bg-amber-500/10 text-amber-300 px-1 rounded border border-amber-500/20">Unlocked</code> (for example, TXT SPF):
              </p>
              <ul className="list-disc list-inside text-xs text-white/70 mt-1.5 space-y-1 ml-2">
                <li>Open <strong>Email Routing</strong> in your Cloudflare domain dashboard.</li>
                <li>Select the **`Settings`** tab at the top.</li>
                <li>to the right of **`DNS records`**, click **`Lock`** the lock icon. Cloudflare will lock and apply all required MX and TXT records.</li>
              </ul>
            </div>

            <div>
              <h5 className="font-bold text-white text-xs flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>
                Part B: Create a Catch-All Routing Rule
              </h5>
              <p className="text-xs text-white/70 mt-1">
                To forward all incoming email to your Worker database:
              </p>
              <ul className="list-disc list-inside text-xs text-white/70 mt-1.5 space-y-1 ml-2">
                <li>Click the **`Routing rules`** (the third tab).</li>
                <li>Scroll down to **Catch-all address**.</li>
                <li>Click **Edit** or **Configure**.</li>
                <li>In the **Action** , select **`Send to a Worker`** .</li>
                <li>In the **Destination** , select the deployed Worker (for example: **`tempmail-pixelnest`**).</li>
                <li>Click **Save** to store the routing rule.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
