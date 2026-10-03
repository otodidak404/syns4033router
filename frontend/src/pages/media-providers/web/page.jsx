
import { Link } from 'react-router-dom';
import { useEffect, useState } from "react";
import { useNavigate } from 'react-router-dom';
import { Card, Badge, Button } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";

function getEffectiveStatus(conn) {
  const isCooldown = Object.entries(conn).some(
    ([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > Date.now()
  );
  return conn.testStatus === "unavailable" && !isCooldown ? "active" : conn.testStatus;
}

function ProviderCard({ provider, kind, connections }) {
  const providerInfo = AI_PROVIDERS[provider.id];
  const isNoAuth = !!providerInfo?.noAuth;
  const providerConns = connections.filter((c) => c.provider === provider.id);
  const connected = providerConns.filter((c) => { const s = getEffectiveStatus(c); return s === "active" || s === "success"; }).length;
  const error = providerConns.filter((c) => { const s = getEffectiveStatus(c); return s === "error" || s === "expired" || s === "unavailable"; }).length;
  const total = providerConns.length;
  const allDisabled = total > 0 && providerConns.every((c) => c.isActive === false);

  const renderStatus = () => {
    if (isNoAuth) return <Badge variant="success" size="sm">Ready</Badge>;
    if (allDisabled) return <Badge variant="default" size="sm">Disabled</Badge>;
    if (total === 0) return <span className="text-xs text-text-muted">No connections</span>;
    return (
      <>
        {connected > 0 && <Badge variant="success" size="sm" dot>{connected} Connected</Badge>}
        {error > 0 && <Badge variant="error" size="sm" dot>{error} Error</Badge>}
        {connected === 0 && error === 0 && <Badge variant="default" size="sm">{total} Added</Badge>}
      </>
    );
  };

  return (
    <Link to={`/dashboard/media-providers/${kind}/${provider.id}`} className="group">
      <Card padding="xs" className={`h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors cursor-pointer ${allDisabled ? "opacity-50" : ""}`}>
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="size-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: `${provider.color?.length > 7 ? provider.color : (provider.color ?? "#888") + "15"}` }}
          >
            <ProviderIcon
              src={`/providers/${provider.id}.png`}
              alt={provider.name}
              size={30}
              className="object-contain rounded-lg max-w-[30px] max-h-[30px]"
              fallbackText={provider.textIcon || provider.id.slice(0, 2).toUpperCase()}
              fallbackColor={provider.color}
            />
          </div>
          <div>
            <h3 className="font-semibold text-sm">{provider.name}</h3>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">{renderStatus()}</div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function ComboList({ combos }) {
  if (combos.length === 0) {
    return <p className="text-xs text-text-muted italic">No combos yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {combos.map((combo) => (
        <Link key={combo.id} to={`/dashboard/media-providers/combo/${combo.id}`}>
          <Card padding="xs" className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors cursor-pointer">
            <div className="flex min-w-0 items-center gap-3">
              <span className="material-symbols-outlined text-primary text-[18px]">layers</span>
              <code className="text-sm font-mono font-medium flex-1 truncate">{combo.name}</code>
              {/* Provider icons preview */}
              <div className="flex flex-wrap items-center gap-1 sm:shrink-0">
                {combo.models.slice(0, 6).map((entry, i) => {
                  const pid = typeof entry === "string" ? entry.split("/")[0] : "";
                  const p = AI_PROVIDERS[pid];
                  return (
                    <div key={`${entry}-${i}`} title={p?.name || entry} className="size-5 rounded flex items-center justify-center" style={{ backgroundColor: `${(p?.color ?? "#888")}15` }}>
                      <ProviderIcon
                        src={`/providers/${pid}.png`}
                        alt={p?.name || pid}
                        size={18}
                        className="object-contain rounded max-w-[18px] max-h-[18px]"
                        fallbackText={p?.textIcon || pid.slice(0, 2).toUpperCase()}
                        fallbackColor={p?.color}
                      />
                    </div>
                  );
                })}
                {combo.models.length > 6 && (
                  <span className="text-[10px] text-text-muted ml-1">+{combo.models.length - 6}</span>
                )}
              </div>
              <span className="text-[11px] text-text-muted shrink-0">{combo.models.length}</span>
              <span className="material-symbols-outlined text-text-muted text-[16px]">chevron_right</span>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}

function Section({ title, icon, kind, providers, connections, combos, onCreateCombo }) {
  return (
    <div>
      {/* Header — title left, Create Combo right */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="material-symbols-outlined text-primary">{icon}</span>
          <h2 className="text-base font-semibold">{title}</h2>
          <span className="text-xs text-text-muted">({providers.length} providers · {combos.length} combos)</span>
        </div>
        <Button size="sm" icon="add" onClick={onCreateCombo}>Create Combo</Button>
      </div>

      {/* Combos — top */}
      {combos.length > 0 && (
        <div className="mb-4">
          <ComboList combos={combos} />
        </div>
      )}

      {/* Providers grid — bottom */}
      {providers.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-border rounded-xl text-text-muted text-sm">
          No providers.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} kind={kind} connections={connections} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function WebProvidersPage() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState([]);
  const [combos, setCombos] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);

  const fetchAll = async () => {
    // This used to be `if (res.ok) set(...)` with a bare `catch {}`, so a failed
    // load left the previous state in place and said nothing -- the page showed
    // "No connections" whether the operator has none or the request failed.
    let conns = null;
    let combs = null;
    try {
      const [connsRes, combosRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/combos", { cache: "no-store" }),
      ]);
      if (connsRes.ok) conns = (await connsRes.json()).connections || [];
      if (combosRes.ok) combs = (await combosRes.json()).combos || [];
      const failed = [
        conns === null ? "providers" : null,
        combs === null ? "combos" : null,
      ].filter(Boolean);
      if (failed.length) {
        setLoadError(`Could not load ${failed.join(" and ")}. Showing what is already loaded.`);
      } else {
        setLoadError(null);
      }
    } catch {
      setLoadError("Could not reach the server. Showing what is already loaded.");
      return;
    }
    if (conns !== null) setConnections(conns);
    if (combs !== null) setCombos(combs);
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchAll(); }, []);

  const searchProviders = getProvidersByKind("webSearch");
  const fetchProviders = getProvidersByKind("webFetch");
  const searchCombos = combos.filter((c) => c.kind === "webSearch");
  const fetchCombos = combos.filter((c) => c.kind === "webFetch");

  const handleCreateCombo = async (kind) => {
    // Generate unique default name
    const base = kind === "webSearch" ? "search-combo" : "fetch-combo";
    let name = base;
    let i = 1;
    const existing = new Set(combos.map((c) => c.name));
    while (existing.has(name)) { name = `${base}-${i++}`; }
    setActionError(null);
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, models: [], kind }),
      });
      if (!res.ok) {
        // A proxy or the platform can answer with HTML, and `res.json()` then throws
        // inside the error path -- so the operator saw nothing at all.
        const raw = await res.text();
        let message = `Failed to create combo (HTTP ${res.status})`;
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.error) message = parsed.error;
        } catch { /* not JSON, keep the status-based message */ }
        setActionError(message);
        return;
      }
      const created = JSON.parse(await res.text());
      navigate(`/dashboard/media-providers/combo/${created.id}`);
    } catch (e) {
      setActionError(`Could not reach the server: ${e?.message || e}`);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {(actionError || loadError) && (
        <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400 flex items-start gap-2">
          <span className="material-symbols-outlined text-[18px] shrink-0">error</span>
          <span className="flex-1">{actionError || loadError}</span>
          {actionError && (
            <button type="button" onClick={() => setActionError(null)}
              className="material-symbols-outlined text-[16px] shrink-0 hover:opacity-70"
              aria-label="Dismiss">close</button>
          )}
        </div>
      )}
      <Section
        title="Web Search" icon="search" kind="webSearch"
        providers={searchProviders} connections={connections} combos={searchCombos}
        onCreateCombo={() => handleCreateCombo("webSearch")}
      />

      {/* Divider between sections */}
      <div className="border-t border-border" />

      <Section
        title="Web Fetch" icon="travel_explore" kind="webFetch"
        providers={fetchProviders} connections={connections} combos={fetchCombos}
        onCreateCombo={() => handleCreateCombo("webFetch")}
      />
    </div>
  );
}
