'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Sparkles, CheckCircle2, Trash2, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AiKnowledgeCard } from './ai-knowledge';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';

const MASKED_KEY = '••••••••••••••••';
const HANDOFF_QUEUE = '__queue__';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  openrouter: 'OpenRouter',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  openrouter: 'sk-or-v1-...',
};

export function AiConfig() {
  const { user } = useAuth();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  const [handoffAgentId, setHandoffAgentId] = useState('');

  const loadedUserIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('settings.aiConfig.loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider);
        setModel(data.model);
        setSystemPrompt(data.system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHandoffAgentId(data.handoff_agent_id ?? '');
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
      }
    } catch {
      toast.error(t('settings.aiConfig.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!user?.$id || loadedUserIdRef.current === user.$id) return;
    loadedUserIdRef.current = user.$id;
    void fetchConfig();
  }, [user?.$id, fetchConfig]);

  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    const isDefaultModel =
      model === AI_PROVIDER_DEFAULT_MODEL.openai ||
      model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
      model === AI_PROVIDER_DEFAULT_MODEL.openrouter ||
      model.trim() === '';
    if (isDefaultModel) setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
  };

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => ({
    provider,
    model: model.trim(),
    api_key: keyPayload(),
    embeddings_api_key: embeddingsKeyPayload(),
    system_prompt: systemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    auto_reply_max_per_conversation: maxPerConversation,
    handoff_agent_id: handoffAgentId || null,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model: model.trim(), api_key: keyPayload() }),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('settings.aiConfig.testSuccess'));
      else toast.error(data.error ?? t('settings.aiConfig.testRejected'));
    } catch {
      toast.error(t('settings.aiConfig.testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) { toast.error(t('settings.aiConfig.missingModel')); return; }
    if (!configured && !keyEdited) { toast.error(t('settings.aiConfig.missingApiKey')); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) { toast.success(t('settings.aiConfig.saveSuccess')); await fetchConfig(); }
      else toast.error(data.error ?? t('settings.aiConfig.saveFailed'));
    } catch {
      toast.error(t('settings.aiConfig.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('settings.aiConfig.removeSuccess'));
        setConfigured(false); setHasStoredKey(false); setApiKey(''); setKeyEdited(false);
        setIsActive(false); setAutoReplyEnabled(false); setSystemPrompt(''); setHandoffAgentId('');
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('settings.aiConfig.removeFailed'));
      }
    } catch {
      toast.error(t('settings.aiConfig.removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('settings.aiConfig.title')}</h2>
        <p className="mt-1 text-sm text-slate-400">{t('settings.aiConfig.description')}</p>
      </div>

      <Card className="border-slate-800 bg-slate-900">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-white">
            <Sparkles className="h-4 w-4 text-primary" /> {t('settings.aiConfig.providerAndKey')}
          </CardTitle>
          <CardDescription className="text-slate-400">
            {t('settings.aiConfig.encryptionNotice')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-slate-300">{t('settings.aiConfig.provider')}</Label>
              <Select value={provider} onValueChange={(v) => handleProviderChange(v as AiProvider)}>
                <SelectTrigger className="border-slate-700 bg-slate-800 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-slate-700 bg-slate-900">
                  {Object.entries(PROVIDER_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-model" className="text-slate-300">{t('settings.aiConfig.model')}</Label>
              <Input id="ai-model" value={model} onChange={(e) => setModel(e.target.value)}
                placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
                className="border-slate-700 bg-slate-800 text-white" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-key" className="text-slate-300">{t('settings.aiConfig.apiKey')}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input id="ai-key" type={showKey ? 'text' : 'password'} value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); setKeyEdited(true); }}
                  onFocus={() => { if (!keyEdited && hasStoredKey) { setApiKey(''); setKeyEdited(true); } }}
                  placeholder={KEY_PLACEHOLDER[provider]} autoComplete="off"
                  className="border-slate-700 bg-slate-800 text-white" />
                <button type="button" onClick={() => setShowKey((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white" tabIndex={-1}>
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button variant="outline" onClick={handleTest} disabled={testing}
                className="border-slate-700 text-slate-300 hover:bg-slate-800">
                {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                {t('settings.aiConfig.testKey')}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-embeddings-key" className="text-slate-300">
              {t('settings.aiConfig.embeddingsKey')}{' '}
              <span className="font-normal text-slate-500">{t('settings.aiConfig.optional')}</span>
            </Label>
            <Input id="ai-embeddings-key" type="password" value={embeddingsKey}
              onChange={(e) => { setEmbeddingsKey(e.target.value); setEmbeddingsKeyEdited(true); }}
              onFocus={() => { if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) { setEmbeddingsKey(''); setEmbeddingsKeyEdited(true); } }}
              placeholder="sk-... (OpenAI)" autoComplete="off"
              className="border-slate-700 bg-slate-800 text-white" />
            <p className="text-xs text-slate-500">{t('settings.aiConfig.embeddingsHint')}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-800 bg-slate-900">
        <CardHeader>
          <CardTitle className="text-base text-white">{t('settings.aiConfig.behaviour')}</CardTitle>
          <CardDescription className="text-slate-400">{t('settings.aiConfig.behaviourDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ai-prompt" className="text-slate-300">{t('settings.aiConfig.businessContext')}</Label>
            <Textarea id="ai-prompt" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t('settings.aiConfig.promptPlaceholder')} rows={5}
              className="border-slate-700 bg-slate-800 text-white" />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border border-slate-700 p-3">
            <div>
              <p className="text-sm font-medium text-white">{t('settings.aiConfig.enableAssistant')}</p>
              <p className="text-xs text-slate-400">{t('settings.aiConfig.enableAssistantDesc')}</p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border border-slate-700 p-3">
            <div>
              <p className="text-sm font-medium text-white">{t('settings.aiConfig.autoReply')}</p>
              <p className="text-xs text-slate-400">{t('settings.aiConfig.autoReplyDesc')}</p>
            </div>
            <Switch checked={autoReplyEnabled} onCheckedChange={setAutoReplyEnabled} disabled={!isActive} />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="ai-max" className="text-slate-300">{t('settings.aiConfig.maxAutoReplies')}</Label>
              <p className="text-xs text-slate-400">{t('settings.aiConfig.maxAutoRepliesDesc')}</p>
            </div>
            <Input id="ai-max" type="number" min={1} max={20} value={maxPerConversation}
              onChange={(e) => setMaxPerConversation(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
              disabled={!autoReplyEnabled} className="w-20 border-slate-700 bg-slate-800 text-white" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-handoff" className="text-slate-300">{t('settings.aiConfig.handoffTo')}</Label>
            <p className="text-xs text-slate-400">{t('settings.aiConfig.handoffToDesc')}</p>
            <Select value={handoffAgentId || HANDOFF_QUEUE}
              onValueChange={(v) => setHandoffAgentId(!v || v === HANDOFF_QUEUE ? '' : v)}
              disabled={!autoReplyEnabled}>
              <SelectTrigger id="ai-handoff" className="border-slate-700 bg-slate-800 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-slate-700 bg-slate-900">
                <SelectItem value={HANDOFF_QUEUE}>{t('settings.aiConfig.handoffQueue')}</SelectItem>
                {user && (
                  <SelectItem value={user.$id}>{user.name || user.email || user.$id}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <AiKnowledgeCard
        hasEmbeddingsKey={embeddingsKeyEdited ? embeddingsKey.trim().length > 0 : hasStoredEmbeddingsKey}
      />

      <div className="flex items-center justify-between">
        {configured ? (
          <Button variant="ghost" onClick={handleRemove} disabled={removing}
            className="text-red-400 hover:text-red-300">
            {removing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            {t('settings.aiConfig.remove')}
          </Button>
        ) : <span />}
        <Button onClick={handleSave} disabled={saving}
          className="bg-primary text-primary-foreground">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
