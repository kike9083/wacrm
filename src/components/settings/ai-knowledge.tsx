'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, Pencil, RefreshCw, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface DocSummary { id: string; title: string; updated_at: string; }
type EditTarget = 'new' | string | null;

export function AiKnowledgeCard({ hasEmbeddingsKey }: { hasEmbeddingsKey: boolean }) {
  const { t } = useTranslation();
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge');
      const data = await res.json();
      if (res.ok) setDocs(data.documents ?? []);
      else toast.error(data.error ?? t('settings.aiKnowledge.loadFailed'));
    } catch { toast.error(t('settings.aiKnowledge.loadFailed')); }
    finally { setLoading(false); }
  }, [t]);

  useEffect(() => { void fetchDocs(); }, [fetchDocs]);

  const openNew = () => { setEditing('new'); setTitle(''); setContent(''); };
  const openEdit = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`);
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? t('settings.aiKnowledge.openFailed')); return; }
      setEditing(id); setTitle(data.title ?? ''); setContent(data.content ?? '');
    } catch { toast.error(t('settings.aiKnowledge.openFailed')); }
  };
  const cancelEdit = () => { setEditing(null); setTitle(''); setContent(''); };

  const save = async () => {
    if (!title.trim() || !content.trim()) { toast.error(t('settings.aiKnowledge.titleContentRequired')); return; }
    setSaving(true);
    try {
      const isNew = editing === 'new';
      const res = await fetch(isNew ? '/api/ai/knowledge' : `/api/ai/knowledge/${editing}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.warning) toast.warning(data.warning);
        else toast.success(isNew ? t('settings.aiKnowledge.saveSuccessNew') : t('settings.aiKnowledge.saveSuccessUpdate'));
        cancelEdit(); await fetchDocs();
      } else toast.error(data.error ?? t('settings.aiKnowledge.saveFailed'));
    } catch { toast.error(t('settings.aiKnowledge.saveFailed')); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`, { method: 'DELETE' });
      if (res.ok) { toast.success(t('settings.aiKnowledge.removeSuccess')); setDocs((d) => d.filter((x) => x.id !== id)); }
      else { const data = await res.json(); toast.error(data.error ?? t('settings.aiKnowledge.removeFailed')); }
    } catch { toast.error(t('settings.aiKnowledge.removeFailed')); }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) toast.success(t('settings.aiKnowledge.reindexSuccess', { count: data.reindexed }));
      else toast.error(data.error ?? t('settings.aiKnowledge.reindexFailed'));
    } catch { toast.error(t('settings.aiKnowledge.reindexFailed')); }
    finally { setReindexing(false); }
  };

  return (
    <Card className="border-slate-800 bg-slate-900">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-white">
          <BookOpen className="h-4 w-4 text-primary" /> {t('settings.aiKnowledge.title')}
        </CardTitle>
        <CardDescription className="text-slate-400">
          {t('settings.aiKnowledge.description', {
            searchType: hasEmbeddingsKey ? t('settings.aiKnowledge.semanticSearchOn') : t('settings.aiKnowledge.keywordSearchOn'),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-slate-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('common.loading')}
          </div>
        ) : (
          <>
            {docs.length === 0 && editing === null && (
              <p className="text-sm text-slate-400">{t('settings.aiKnowledge.noDocs')}</p>
            )}
            {docs.length > 0 && (
              <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
                {docs.map((doc) => (
                  <li key={doc.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0 truncate text-sm text-white">{doc.title}</span>
                    <span className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-slate-400 hover:text-white"
                        onClick={() => void openEdit(doc.id)} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-400 hover:text-red-300"
                        onClick={() => void remove(doc.id)} title="Delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {editing !== null ? (
              <div className="space-y-3 rounded-md border border-slate-800 p-3">
                <div className="space-y-2">
                  <Label htmlFor="kb-title" className="text-slate-300">{t('settings.aiKnowledge.editDocTitle')}</Label>
                  <Input id="kb-title" value={title} onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('settings.aiKnowledge.editDocTitlePlaceholder')} disabled={saving}
                    className="border-slate-700 bg-slate-800 text-white" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kb-content" className="text-slate-300">{t('settings.aiKnowledge.editDocContent')}</Label>
                  <Textarea id="kb-content" value={content} onChange={(e) => setContent(e.target.value)}
                    placeholder={t('settings.aiKnowledge.editDocContentPlaceholder')} rows={8} disabled={saving}
                    className="border-slate-700 bg-slate-800 text-white" />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelEdit} disabled={saving}
                    className="text-slate-400 hover:text-white">{t('common.cancel')}</Button>
                  <Button onClick={save} disabled={saving}
                    className="bg-primary text-primary-foreground">
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('settings.aiKnowledge.saveDoc')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <Button variant="outline" size="sm" onClick={openNew}
                  className="border-slate-700 text-slate-300 hover:bg-slate-800">
                  <Plus className="mr-2 h-4 w-4" /> {t('settings.aiKnowledge.addDoc')}
                </Button>
                {hasEmbeddingsKey && docs.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={reindex} disabled={reindexing}
                    title={t('settings.aiKnowledge.reindexTooltip')}
                    className="text-slate-400 hover:text-white">
                    {reindexing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    {t('settings.aiKnowledge.reindex')}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
