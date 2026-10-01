import { useState, useEffect, useCallback } from "react";
import {
  Card, Button, Modal, Input, Toggle, ConfirmModal, ModelSelectModal, CardSkeleton,
} from "@/shared/components";

function SkillCard({ skill, assignments, onToggle, onAssign, onUnassign, busy }) {
  const mine = assignments.filter(a => a.skillId === skill.id);
  const activeModels = [...new Set(mine.filter(a => a.isActive).map(a => a.model))];

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate font-mono text-sm font-semibold text-text-main">{skill.id}</h3>
            <span className="rounded-full bg-black/5 px-2 py-0.5 text-[10px] text-text-muted dark:bg-white/5">
              {(skill.chars / 1000).toFixed(1)}k chars
            </span>
            {activeModels.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                <span className="size-1.5 rounded-full bg-primary" />
                Live on {activeModels.length}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Model chips, each toggleable */}
      <div className="flex flex-wrap gap-1.5">
        {mine.length === 0 && (
          <p className="text-xs text-text-muted italic">
            Not assigned — this skill is not injected into any model.
          </p>
        )}
        {mine.map(a => (
          <div
            key={a.id}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 py-1 pl-2.5 pr-1"
          >
            <code className="max-w-[220px] truncate font-mono text-[11px] text-text-main" title={a.model}>
              {a.model}
            </code>
            <Toggle size="sm" checked={a.isActive} onChange={(v) => onToggle(a, v)} disabled={busy} />
            <button
              onClick={() => onUnassign(a)}
              disabled={busy}
              className="rounded p-0.5 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40"
              title="Remove assignment"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end border-t border-border-subtle pt-3">
        <Button size="sm" variant="ghost" icon="add_link" onClick={onAssign} disabled={busy}>
          Assign model
        </Button>
      </div>
    </Card>
  );
}

export default function SkillsPage() {
  const [skills, setSkills] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [providers, setProviders] = useState([]);
  const [aliases, setAliases] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [assigning, setAssigning] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const notify = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2000);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const [msRes, provRes, aliasRes] = await Promise.all([
        fetch("/api/model-skills"),
        fetch("/api/providers"),
        fetch("/api/models/alias"),
      ]);
      if (msRes.ok) {
        const d = await msRes.json();
        setSkills(d.skills || []);
        setAssignments(d.assignments || []);
      }
      if (provRes.ok) setProviders((await provRes.json()).connections || []);
      if (aliasRes.ok) setAliases((await aliasRes.json()).aliases || {});
    } catch (e) {
      console.log("Error loading skills:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toggle = async (assignment, isActive) => {
    setBusy(true);
    const res = await fetch(`/api/model-skills/${assignment.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
    });
    setBusy(false);
    if (!res.ok) return notify((await res.json().catch(() => ({}))).error || "Update failed");
    const updated = await res.json();
    setAssignments(prev => prev.map(a => (a.id === updated.id ? updated : a)));
    notify("Skill assignments disimpan");
  };

  const assign = async (model) => {
    if (!assigning || !model) return;
    setBusy(true);
    const res = await fetch("/api/model-skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, skillId: assigning.id }),
    });
    setBusy(false);
    if (!res.ok) return notify((await res.json().catch(() => ({}))).error || "Assign failed");
    await fetchData();
    setAssigning(null);
    notify("Skill assigned");
  };

  const unassign = (assignment) => {
    setConfirm({
      title: "Remove assignment",
      message: `Stop injecting this skill into ${assignment.model}?`,
      onConfirm: async () => {
        setConfirm(null);
        const res = await fetch(`/api/model-skills/${assignment.id}`, { method: "DELETE" });
        if (!res.ok) return notify("Remove failed");
        setAssignments(prev => prev.filter(a => a.id !== assignment.id));
        notify("Assignment removed");
      },
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const liveCount = assignments.filter(a => a.isActive).length;
  const modelCount = new Set(assignments.map(a => a.model)).size;

  return (
    <div className="relative flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-text-main shadow-lg">
          <span className="material-symbols-outlined text-[18px] text-green-500">check_circle</span>
          {toast}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Skills</h1>
        <p className="text-sm text-text-muted">
          Capability docs injected into a model's system prompt — per model, so an image
          model never gets chat API documentation.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
        <span>
          <span className="font-semibold text-text-main">{skills.length}</span> skill
        </span>
        <span className="text-text-muted/50">·</span>
        <span>
          <span className="font-semibold text-text-main">{modelCount}</span> model
        </span>
        <span className="text-text-muted/50">·</span>
        <span>
          <span className="font-semibold text-primary">{liveCount}</span> live assignment
        </span>
      </div>

      {skills.length === 0 ? (
        <Card>
          <div className="py-12 text-center">
            <span className="material-symbols-outlined mb-2 text-[32px] text-text-muted">extension</span>
            <p className="font-medium text-text-main">No skills found on disk</p>
            <p className="text-sm text-text-muted">
              Add a <code className="font-mono">skills/&lt;id&gt;/SKILL.md</code> directory.
            </p>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {skills.map(s => (
            <SkillCard
              key={s.id}
              skill={s}
              assignments={assignments.filter(a => a.skillId === s.id)}
              onToggle={toggle}
              onAssign={() => setAssigning(s)}
              onUnassign={unassign}
              busy={busy}
            />
          ))}
        </div>
      )}

      <ModelSelectModal
        isOpen={!!assigning}
        onClose={() => setAssigning(null)}
        onSelect={assign}
        activeProviders={providers}
        modelAliases={aliases}
        title={assigning ? `Assign ${assigning.id} to a model` : "Assign skill"}
        closeOnSelect
      />

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