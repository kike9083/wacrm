'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BarChart3, Bot, PencilLine } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/dashboard/skeleton';
import { format, parseISO } from 'date-fns';

interface UsageResponse {
  window_days: number;
  truncated: boolean;
  totals: { calls: number; prompt_tokens: number; completion_tokens: number; total_tokens: number };
  by_mode: { auto_reply: { calls: number; tokens: number }; draft: { calls: number; tokens: number } };
  by_model: { model: string; provider: string; calls: number; tokens: number }[];
  daily: { date: string; tokens: number; calls: number }[];
}

const WINDOWS = [7, 30, 90] as const;

function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// SVG bar chart — no external charting library needed
function TokenBarChart({ data }: { data: { day: string; tokens: number }[] }) {
  if (data.length === 0) return null;
  const maxTokens = Math.max(...data.map((d) => d.tokens), 1);
  const barWidth = Math.max(2, Math.min(20, Math.floor(600 / data.length) - 2));

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${data.length * (barWidth + 2) + 40} 200`} className="h-[200px] w-full" preserveAspectRatio="xMidYMid meet">
        {data.map((d, i) => {
          const barH = (d.tokens / maxTokens) * 170;
          const x = 30 + i * (barWidth + 2);
          return (
            <g key={i}>
              <rect x={x} y={200 - barH} width={barWidth} height={barH} rx={2}
                className="fill-primary/80 hover:fill-primary transition-colors" />
              {i % Math.max(1, Math.floor(data.length / 6)) === 0 && (
                <text x={x + barWidth / 2} y={198} textAnchor="middle" className="fill-slate-500 text-[9px]">
                  {d.day}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon?: typeof Bot }) {
  return (
    <div className="rounded-md border border-slate-800 p-3">
      <p className="flex items-center gap-1 text-xs text-slate-400">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-white">{value}</p>
    </div>
  );
}

export function AiUsageCard() {
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<UsageResponse | null>(null);
  const loadedRef = useRef<number | null>(null);

  const fetchUsage = useCallback(async (windowDays: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ai/usage?days=${windowDays}`, { cache: 'no-store' });
      const json = await res.json().catch(() => null);
      if (!res.ok) { toast.error(json?.error ?? 'Failed to load usage'); setData(null); return; }
      setData(json as UsageResponse);
    } catch { toast.error('Failed to load usage'); setData(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (loadedRef.current === days) return;
    loadedRef.current = days;
    void fetchUsage(days);
  }, [days, fetchUsage]);

  const chartData = data?.daily.map((d) => ({
    day: format(parseISO(d.date), 'MMM d'),
    tokens: d.tokens,
  })) ?? [];
  const hasSpend = (data?.totals.total_tokens ?? 0) > 0;

  return (
    <Card className="border-slate-800 bg-slate-900">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base text-white">
              <BarChart3 className="h-4 w-4 text-primary" /> Token usage
            </CardTitle>
            <CardDescription className="text-slate-400">
              Tokens spent on your provider key by drafts and the auto-reply bot. Counts only — no message content is stored here.
            </CardDescription>
          </div>
          <Select value={String(days)} onValueChange={(v) => { loadedRef.current = null; setDays(Number(v)); }}>
            <SelectTrigger className="w-32 flex-shrink-0 border-slate-700 bg-slate-800 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-slate-700 bg-slate-900">
              {WINDOWS.map((w) => (
                <SelectItem key={w} value={String(w)}>Last {w} days</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading || !data ? (
          <Skeleton className="h-[220px] w-full" />
        ) : !hasSpend ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-slate-400">
            <BarChart3 className="h-8 w-8 opacity-40" />
            <p>No AI usage in the last {data.window_days} days yet.</p>
            <p className="text-xs">This fills in as the assistant drafts and auto-replies.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Total tokens" value={formatCompactNumber(data.totals.total_tokens)} />
              <Stat label="LLM calls" value={String(data.totals.calls)} />
              <Stat label="Auto-reply" value={formatCompactNumber(data.by_mode.auto_reply.tokens)} icon={Bot} />
              <Stat label="Drafts" value={formatCompactNumber(data.by_mode.draft.tokens)} icon={PencilLine} />
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-slate-400">Tokens per day</p>
              <TokenBarChart data={chartData} />
            </div>

            {data.by_model.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium text-slate-400">By model</p>
                <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
                  {data.by_model.map((m) => (
                    <li key={`${m.provider}:${m.model}`} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="min-w-0 truncate">
                        <span className="text-white">{m.model}</span>{' '}
                        <span className="text-xs text-slate-500">({m.provider})</span>
                      </span>
                      <span className="flex-shrink-0 tabular-nums text-slate-400">
                        {formatCompactNumber(m.tokens)} tok · {m.calls} {m.calls === 1 ? 'call' : 'calls'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.truncated && (
              <p className="text-xs text-slate-500">
                Showing a partial window — usage is high enough that only the most recent records are summarized here.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
