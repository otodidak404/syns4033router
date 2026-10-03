
import { testProxyUrl } from "../../../lib/network/proxyTest.js";

export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const result = await testProxyUrl({
      proxyUrl: body?.proxyUrl,
      testUrl: body?.testUrl,
      timeoutMs: body?.timeoutMs,
    });

    if (result?.ok) {
      return res.json(result);
    }

    const status = typeof result?.status === "number" ? result.status : 500;
    // res.json takes one argument; the { status } was ignored, so a failed proxy
    // test answered HTTP 200.
    return res.status(status).json({ ok: false, error: result?.error || "Proxy test failed" });
  } catch (err) {
    const message = err?.name === "AbortError" ? "Proxy test timed out" : (err?.message || String(err));
    return res.status(500).json({ ok: false, error: message });
  }
}
