import { getConsoleLogs, getConsoleEmitter, initConsoleLogCapture } from "../../../../lib/consoleLogBuffer.js";

export const dynamic = "force-dynamic";

initConsoleLogCapture();

export async function GET_handler(req, res) {
  const emitter = getConsoleEmitter();
  const state = { closed: false, send: null as any, sendClear: null as any, keepalive: null as any };

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.send) emitter.off("line", state.send);
    if (state.sendClear) emitter.off("clear", state.sendClear);
    if (state.keepalive) clearInterval(state.keepalive);
  };

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send buffered logs immediately on connect
  const buffered = getConsoleLogs();
  if (buffered.length > 0) {
    res.write(`data: ${JSON.stringify({ type: "init", logs: buffered })}\n\n`);
  }

  // Push new lines as they arrive
  state.send = (line: string) => {
    if (state.closed) return;
    try { res.write(`data: ${JSON.stringify({ type: "line", line })}\n\n`); } catch { cleanup(); }
  };

  // Notify client when cleared
  state.sendClear = () => {
    if (state.closed) return;
    try { res.write(`data: ${JSON.stringify({ type: "clear" })}\n\n`); } catch { cleanup(); }
  };

  emitter.on("line", state.send);
  emitter.on("clear", state.sendClear);

  // Keepalive ping every 25s
  state.keepalive = setInterval(() => {
    if (state.closed) { clearInterval(state.keepalive); return; }
    try { res.write(": ping\n\n"); } catch { cleanup(); }
  }, 25000);

  // Cleanup on client disconnect
  req.on("close", cleanup);
  req.on("error", cleanup);
}
