import { useState, useEffect, useCallback, useRef } from "react";
import {
  Card, Button, Modal, Input, CardSkeleton, Toggle, ConfirmModal,
  ModelSelectModal, SegmentedControl,
} from "@/shared/components";

// ── Library ────────────────────────────────────────────────────────────────

function PromptCard({ entry, onEdit, onDelete, onToggleActive, onToggleLive, onTest }) {
  const isLive = entry.isActive && entry.isLive;
  return (
    <Card padding="sm" className="flex flex-col gap-3">
      {/* Header: label + model badge + LIVE */}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-main" title={entry.label}>
              {entry.label}
            </h3>
            <code
              className="max-w-full truncate rounded bg-black/5 px-1.5 py-0.5 font-mono text-[10px] text-text-muted dark:bg-white/5"
              title={entry.model}
            >
              {entry.model}
            </code>
          </div>
        </div>
        {isLive && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            <span className="size-1.5 rounded-full bg-primary" />
            Live
          </span>
        )}
      </div>

      {/* Prompt body — monospaced, scrollable, read-only preview */}
      <pre className="max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text-main">
        {entry.prompt}
      </pre>

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
        <div className="flex flex-col gap-2">
          <Toggle
            size="sm"
            checked={entry.isActive}
            onChange={(v) => onToggleActive(entry, v)}
            label="Aktif"
          />
          <Toggle
            size="sm"
            checked={entry.isLive}
            onChange={(v) => onToggleLive(entry, v)}
            label="Inject ke request customer (live)"
          />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onTest}
            className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
            title="Test in Playground"
          >
            <span className="material-symbols-outlined text-[18px]">play_arrow</span>
            <span className="text-[10px] leading-tight">Test</span>
          </button>
          <button
            onClick={onEdit}
            className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
            title="Edit"
          >
            <span className="material-symbols-outlined text-[18px]">edit</span>
            <span className="text-[10px] leading-tight">Edit</span>
          </button>
          <button
            onClick={onDelete}
            className="flex flex-col items-center rounded px-2 py-1 text-red-500 transition-colors hover:bg-red-500/10"
            title="Hapus"
          >
            <span className="material-symbols-outlined text-[18px]">delete</span>
            <span className="text-[10px] leading-tight">Hapus</span>
          </button>
        </div>
      </div>
    </Card>
  );
}

function PromptFormModal({ isOpen, entry, onClose, onSave, activeProviders, modelAliases }) {
  const [label, setLabel] = useState(entry?.label || "");
  const [model, setModel] = useState(entry?.model || "");
  const [prompt, setPrompt] = useState(entry?.prompt || "");
  const [isActive, setIsActive] = useState(entry?.isActive ?? true);
  const [isLive, setIsLive] = useState(entry?.isLive ?? false);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isEdit = !!entry;
  const taRef = useRef(null);

  const handleSave = async () => {
    if (!label.trim()) return setError("Label is required");
    if (!model.trim()) return setError("Model is required");
    if (!prompt.trim()) return setError("Prompt is required");
    setError("");
    setSaving(true);
    const ok = await onSave({ label: label.trim(), model: model.trim(), prompt, isActive, isLive });
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={isEdit ? "Edit JB" : "Tambah JB"} size="lg">
        <div className="flex flex-col gap-3">
          <Input
            label="Label"
            value={label}
            onChange={(e) => { setLabel(e.target.value); setError(""); }}
            placeholder="big-pickle-JB"
            error={error && !label.trim() ? error : ""}
          />

          <div>
            <label className="mb-1.5 block text-sm font-medium">Model</label>
            <div className="flex gap-2">
              <input
                value={model}
                onChange={(e) => { setModel(e.target.value); setError(""); }}
                placeholder="provider/model"
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text-main outline-none focus:border-primary"
              />
              <Button
                onClick={() => setShowModelSelect(true)}
                variant="ghost"
                size="sm"
                icon="search"
              >
                Browse model
              </Button>
            </div>
            {error && !model.trim() && <p className="mt-0.5 text-xs text-red-500">{error}</p>}
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Prompt</label>
            <textarea
              ref={taRef}
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setError(""); }}
              rows={14}
              placeholder={"<project_instructions>\n...\n</project_instructions>"}
              className="w-full resize-y rounded-lg border border-border bg-surface p-3 font-mono text-xs leading-relaxed text-text-main outline-none focus:border-primary"
            />
            <p className="mt-1 text-[10px] text-text-muted">
              {prompt.length} chars · plain text or XML-style tags
            </p>
          </div>

          <div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3">
            <Toggle size="sm" checked={isActive} onChange={setIsActive} label="Aktif" />
            <Toggle
              size="sm"
              checked={isLive}
              onChange={setIsLive}
              label="Inject ke request customer (live)"
            />
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">Cancel</Button>
            <Button
              onClick={handleSave}
              fullWidth
              size="sm"
              disabled={saving}
            >
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      <ModelSelectModal
        isOpen={showModelSelect}
        onClose={() => setShowModelSelect(false)}
        onSelect={(m) => { setModel(m.value); setShowModelSelect(false); }}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title="Browse model"
        closeOnSelect
      />
    </>
  );
}

// ── Playground ─────────────────────────────────────────────────────────────

function Playground({ entries, initialEntryId, onLoadAll }) {
  const [selectedId, setSelectedId] = useState(initialEntryId || (entries[0]?.id ?? ""));
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const outRef = useRef(null);

  useEffect(() => {
    if (!selectedId && entries[0]) setSelectedId(entries[0].id);
  }, [entries, selectedId]);

  const selected = entries.find(e => e.id === selectedId) || null;

  // Playground sends a prompt preview only — it never hits the gateway, so the
  // operator can compare personas without polluting customer traffic.
  const run = () => {
    const text = input.trim();
    if (!text || !selected) return;
    setBusy(true);
    setOutput("");
    // Deterministic preview: show exactly what would be injected.
    setOutput(
      `Would inject into ${selected.model}:\n\n` +
      `${selected.prompt}\n\n--- user turn ---\n${text}`
    );
    setBusy(false);
    outRef.current?.scrollTo?.({ top: 0 });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          options={entries.length === 0 ? [{ value: "", label: "No entries" }] : entries.map(e => ({
            value: e.id,
            label: e.label,
          }))}
          value={selectedId}
          onChange={setSelectedId}
          size="sm"
          className="max-w-full"
        />
        <Button size="sm" variant="ghost" icon="download" onClick={onLoadAll}>
          Load semua
        </Button>
      </div>

      {selected && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-surface-2 p-3 font-mono text-[11px] text-text-muted">
          {selected.prompt}
        </pre>
      )}

      <div className="flex flex-col gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
          rows={4}
          placeholder="Test input… (Ctrl+Enter to run)"
          className="w-full resize-y rounded-lg border border-border bg-surface p-3 text-sm text-text-main outline-none focus:border-primary"
        />
        <Button onClick={run} disabled={busy || !input.trim() || !selected} icon="play_arrow">
          Run preview
        </Button>
      </div>

      {output && (
        <pre
          ref={outRef}
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text-main"
        >
          {output}
        </pre>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function SystemPromptPage() {
  const [entries, setEntries] = useState([]);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("library");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [toast, setToast] = useState("");
  const [playgroundSeed, setPlaygroundSeed] = useState(null);

  const notify = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2200);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const [spRes, provRes, aliasRes] = await Promise.all([
        fetch("/api/system-prompts"),
        fetch("/api/providers"),
        fetch("/api/models/alias"),
      ]);
      if (spRes.ok) {
        const d = await spRes.json();
        setEntries(d.entries || []);
      }
      if (provRes.ok) {
        const d = await provRes.json();
        setActiveProviders(d.connections || []);
      }
      if (aliasRes.ok) {
        const d = await aliasRes.json();
        setModelAliases(d.aliases || {});
      }
    } catch (error) {
      console.log("Error fetching system prompts:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const patchEntry = async (id, body) => {
    try {
      const res = await fetch(`/api/system-prompts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        notify(err.error || "Update failed");
        return false;
      }
      const updated = await res.json();
      setEntries(prev => prev.map(e => (e.id === id ? updated : e)));
      notify("System prompts disimpan");
      return true;
    } catch (error) {
      console.log("Error updating:", error);
      return false;
    }
  };

  const createEntry = async (data) => {
    try {
      const res = await fetch("/api/system-prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        notify(err.error || "Create failed");
        return false;
      }
      await fetchData();
      notify("System prompts disimpan");
      return true;
    } catch (error) {
      console.log("Error creating:", error);
      return false;
    }
  };

  const deleteEntry = (entry) => {
    setConfirm({
      title: "Hapus JB",
      message: `Delete "${entry.label}"? This stops injection for ${entry.model}.`,
      onConfirm: async () => {
        setConfirm(null);
        const res = await fetch(`/api/system-prompts/${entry.id}`, { method: "DELETE" });
        if (res.ok) {
          setEntries(prev => prev.filter(e => e.id !== entry.id));
          notify("JB dihapus");
        }
      },
    });
  };

  const liveCount = entries.filter(e => e.isActive && e.isLive).length;

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="relative flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-lg bg-surface border border-border px-4 py-2.5 text-sm text-text-main shadow-lg">
          <span className="material-symbols-outlined text-[18px] text-green-500">check_circle</span>
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">System Prompt</h1>
          <p className="mt-1 text-sm text-text-muted">
            One jailbreak/persona prompt per model — injected live into gateway traffic
          </p>
        </div>
        <Button icon="add" onClick={() => setEditing({ isNew: true })} className="w-full sm:w-auto">
          Tambah JB
        </Button>
      </div>

      {/* View switch + counts + toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          options={[
            { value: "library", label: "Library", icon: "folder" },
            { value: "playground", label: "Playground", icon: "play_arrow" },
          ]}
          value={view}
          onChange={setView}
          size="sm"
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted">
            <span className="font-semibold text-text-main">{entries.length}</span> entri
            <span className="mx-1.5 text-text-muted/50">·</span>
            <span className="font-semibold text-primary">{liveCount}</span> live
          </span>
        </div>
      </div>

      {view === "library" ? (
        entries.length === 0 ? (
          <Card>
            <div className="py-12 text-center">
              <div className="mb-4 inline-flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
                <span className="material-symbols-outlined text-[32px]">psychology</span>
              </div>
              <p className="mb-1 font-medium text-text-main">No system prompts yet</p>
              <p className="mb-4 text-sm text-text-muted">
                Add a jailbreak prompt bound to a model
              </p>
              <Button icon="add" onClick={() => setEditing({ isNew: true })}>
                Tambah JB
              </Button>
            </div>
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            {entries.map(entry => (
              <PromptCard
                key={entry.id}
                entry={entry}
                onEdit={() => setEditing(entry)}
                onDelete={() => deleteEntry(entry)}
                onToggleActive={(e, v) => patchEntry(e.id, { isActive: v })}
                onToggleLive={(e, v) => patchEntry(e.id, { isLive: v })}
                onTest={() => { setPlaygroundSeed(entry.id); setView("playground"); }}
              />
            ))}
          </div>
        )
      ) : (
        <Playground
          entries={entries}
          initialEntryId={playgroundSeed}
          onLoadAll={() => {
            const live = entries.filter(e => e.isActive && e.isLive);
            notify(live.length ? `Loaded ${live.length} live prompt(s)` : "No live prompts");
          }}
        />
      )}

      {/* Create / Edit modal */}
      {editing && (
        <PromptFormModal
          key={editing.isNew ? "new" : editing.id}
          isOpen
          entry={editing.isNew ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(data) => (editing.isNew ? createEntry(data) : patchEntry(editing.id, data))}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
        />
      )}

      <ConfirmModal
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={confirm?.onConfirm}
        title={confirm?.title || "Confirm"}
        message={confirm?.message}
        variant="danger"
      />
    </div>
  );
}