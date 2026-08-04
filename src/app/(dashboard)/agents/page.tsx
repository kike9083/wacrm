'use client';

import { useEffect, useState } from 'react';
import { Bot, Sparkles, Settings2, BarChart3 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiConfig } from '@/components/settings/ai-config';

type Tab = 'playground' | 'setup' | 'usage';

export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>('playground');
  const [decided, setDecided] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setTab(data?.configured ? 'playground' : 'setup');
      } catch {
        if (!cancelled) setTab('setup');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Bot className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-white">AI Agents</h1>
        </div>
        <p className="mt-1 text-sm text-slate-400">
          Your bring-your-own-key AI agent — set it up, then test it in the playground before it replies to customers in the inbox.
        </p>
      </div>

      {decided && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="bg-slate-900 border border-slate-700">
            <TabsTrigger value="playground"
              className="data-active:bg-slate-800 data-active:text-primary text-slate-400">
              <Sparkles className="mr-1.5 h-4 w-4" /> Playground
            </TabsTrigger>
            <TabsTrigger value="setup"
              className="data-active:bg-slate-800 data-active:text-primary text-slate-400">
              <Settings2 className="mr-1.5 h-4 w-4" /> Setup
            </TabsTrigger>
            <TabsTrigger value="usage"
              className="data-active:bg-slate-800 data-active:text-primary text-slate-400">
              <BarChart3 className="mr-1.5 h-4 w-4" /> Usage
            </TabsTrigger>
          </TabsList>

          <TabsContent value="playground" className="mt-4">
            <AiPlayground onGoToSetup={() => setTab('setup')} />
          </TabsContent>

          <TabsContent value="setup" className="mt-6">
            <AiConfig />
          </TabsContent>

          <TabsContent value="usage" className="mt-4">
            <AiUsageCard />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
