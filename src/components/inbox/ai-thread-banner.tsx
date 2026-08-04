"use client";

import { useState, useEffect, useCallback } from "react";
import { Sparkles, Hand, Undo2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";

interface AiAccountStatus { autoReplyOn: boolean; }
const statusCache = new Map<string, AiAccountStatus>();

async function fetchAiAccountStatus(_userId: string): Promise<AiAccountStatus> {
  const cached = statusCache.get(_userId);
  if (cached) return cached;
  try {
    const res = await fetch("/api/ai/config", { cache: "no-store" });
    if (!res.ok) return { autoReplyOn: false };
    const j = await res.json();
    const status = { autoReplyOn: !!(j?.configured && j?.is_active && j?.auto_reply_enabled) };
    statusCache.set(_userId, status);
    return status;
  } catch { return { autoReplyOn: false }; }
}

interface AiThreadBannerProps {
  conversationId: string;
  disabled: boolean;
  handoffSummary?: string | null;
  assignedAgentId?: string | null;
  currentUserId?: string | null;
  onChange?: (patch: { ai_autoreply_disabled: boolean; assigned_agent_id?: string | null }) => void;
}

export function AiThreadBanner({
  conversationId, disabled, handoffSummary, assignedAgentId, currentUserId, onChange,
}: AiThreadBannerProps) {
  const { user } = useAuth();
  const [autoReplyOn, setAutoReplyOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(disabled);
  useEffect(() => setPaused(disabled), [conversationId, disabled]);

  useEffect(() => {
    if (!user?.$id) return;
    let alive = true;
    fetchAiAccountStatus(user.$id).then((s) => alive && setAutoReplyOn(s.autoReplyOn));
    return () => { alive = false; };
  }, [user?.$id]);

  const toggle = useCallback(async (paused: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused, assign_to_me: paused }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j?.error ?? "Failed to update AI status");
        return;
      }
      setPaused(paused);
      onChange?.({
        ai_autoreply_disabled: paused,
        ...(paused ? (currentUserId ? { assigned_agent_id: currentUserId } : {}) : { assigned_agent_id: null }),
      });
      toast.success(paused ? "Took over conversation" : "AI resumed");
    } catch { toast.error("Network error"); }
    finally { setBusy(false); }
  }, [conversationId, currentUserId, onChange]);

  if (!autoReplyOn) return null;

  if (paused) {
    return (
      <Banner tone="muted">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-white">AI paused</p>
          {handoffSummary && (
            <p className="truncate text-slate-400" title={handoffSummary}>{handoffSummary}</p>
          )}
        </div>
        <BannerButton onClick={() => toggle(false)} busy={busy} icon={Undo2}>Resume AI</BannerButton>
      </Banner>
    );
  }

  if (assignedAgentId) return null;

  return (
    <Banner tone="primary">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
        <span className="truncate font-medium text-white">AI is replying automatically</span>
      </div>
      <BannerButton onClick={() => toggle(true)} busy={busy} icon={Hand}>Take over</BannerButton>
    </Banner>
  );
}

function Banner({ tone, children }: { tone: "primary" | "muted"; children: React.ReactNode }) {
  return (
    <div className={cn(
      "flex items-center gap-3 border-b px-3 py-2 text-xs sm:px-4",
      tone === "primary" ? "border-primary/20 bg-primary/5" : "border-slate-800 bg-slate-900/40",
    )}>{children}</div>
  );
}

function BannerButton({ onClick, busy, icon: Icon, children }: {
  onClick: () => void; busy: boolean; icon: typeof Hand; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} disabled={busy}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-60">
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
      {children}
    </button>
  );
}
