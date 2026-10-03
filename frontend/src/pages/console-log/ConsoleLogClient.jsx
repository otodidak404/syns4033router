
import { useState, useEffect, useRef } from "react";
import { Card, Button } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

function colorLine(line) {
  const match = line.match(/\[(\w+)\]/g);
  const levelTag = match ? match[1]?.replace(/\[|\]/g, "") : null;
  const color = LOG_LEVEL_COLORS[levelTag] || "text-green-400";
  return <span className={color}>{line}</span>;
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const logRef = useRef(null);

  const handleClear = async () => {
    // The old version awaited the request and never looked at the response. A refused
    // or failed delete left the logs on screen with nothing said, and because the UI is
    // cleared by an SSE event rather than by this call, a successful-looking button
    // press changed nothing.
    setError(null);
    try {
      const res = await fetch("/api/translator/console-logs", { method: "DELETE" });
      if (!res.ok) {
        setError(`Could not clear the logs (HTTP ${res.status}).`);
        return;
      }
      // Cleared locally as well as by the SSE event, so a stream that is already down
      // does not leave a stale buffer on screen.
      setLogs([]);
    } catch (err) {
      setError(`Could not clear the logs: ${err?.message || err}`);
    }
  };

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      // A frame that is not JSON threw inside the handler and was swallowed by the
      // browser, so a corrupted frame looked like a stream that had gone quiet.
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "init") {
        setLogs(msg.logs.slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        setLogs((prev) => {
          const next = [...prev, msg.line];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "clear") {
        setLogs([]);
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  return (
    <div className="">
      <Card>
        <div className="flex items-center justify-end gap-3 px-4 pt-3 pb-2">
          {!connected && (
            <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
              <span className="material-symbols-outlined text-[14px]">cloud_off</span>
              Live stream disconnected — logs below may be out of date
            </span>
          )}
          <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
            Clear
          </Button>
        </div>
        {error && (
          <div role="alert" className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            <span className="material-symbols-outlined text-[18px] shrink-0">error</span>
            <span className="flex-1">{error}</span>
          </div>
        )}
        <div
          ref={logRef}
          className="bg-black rounded-b-lg p-4 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
        >
          {logs.length === 0 ? (
            <span className="text-text-muted">No console logs yet.</span>
          ) : (
            <div className="space-y-0.5">
              {logs.map((line, i) => (
                <div key={i}>{colorLine(line)}</div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
