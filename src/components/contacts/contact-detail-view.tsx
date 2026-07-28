'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { databases, account } from '@/lib/appwrite/client';
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db';
import { Query } from 'appwrite';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag, ContactNote, CustomField, ContactCustomValue, Deal } from '@/types';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  X,
  DollarSign,
} from 'lucide-react';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
  const { t } = useTranslation();
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  // Details tab
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  const fetchContact = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);

    try {
      const doc = await databases.getDocument(DATABASE_ID, COLLECTIONS.contacts, contactId);
      setContact(doc as unknown as Contact);
      const data = doc as any;
      setEditName(data.name ?? '');
      setEditPhone(data.phone);
      setEditEmail(data.email ?? '');
      setEditCompany(data.company ?? '');
    } catch {
      setContact(null);
    }
    setLoading(false);
  }, [contactId]);

  const fetchTags = useCallback(async () => {
    if (!contactId) return;

    try {
      const [tagsRes, contactTagsRes] = await Promise.all([
        databases.listDocuments(DATABASE_ID, COLLECTIONS.tags, [Query.orderAsc('name')]),
        databases.listDocuments(DATABASE_ID, COLLECTIONS.contactTags, [Query.equal('contact_id', contactId)]),
      ]);

      setAllTags(tagsRes.documents as unknown as Tag[]);
      setContactTagIds(contactTagsRes.documents.map((ct: any) => ct.tag_id));
    } catch {
      setAllTags([]);
      setContactTagIds([]);
    }
  }, [contactId]);

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    try {
      const { documents } = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contactNotes,
        [Query.equal('contact_id', contactId), Query.orderDesc('created_at')]
      );
      setNotes(documents as unknown as ContactNote[]);
    } catch {
      setNotes([]);
    }
    setLoadingNotes(false);
  }, [contactId]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    try {
      const [fieldsRes, valuesRes] = await Promise.all([
        databases.listDocuments(DATABASE_ID, COLLECTIONS.customFields, [Query.orderAsc('field_name')]),
        databases.listDocuments(DATABASE_ID, COLLECTIONS.contactCustomValues, [Query.equal('contact_id', contactId)]),
      ]);

      setCustomFields(fieldsRes.documents as unknown as CustomField[]);
      const map: Record<string, string> = {};
      valuesRes.documents.forEach((v: any) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    } catch {
      setCustomFields([]);
      setCustomValues({});
    }
    setLoadingCustom(false);
  }, [contactId]);

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    try {
      const { documents } = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.deals,
        [Query.equal('contact_id', contactId), Query.orderDesc('created_at')]
      );
      setDeals(documents as unknown as Deal[]);
    } catch {
      setDeals([]);
    }
    setLoadingDeals(false);
  }, [contactId]);

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchTags();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
    }
  }, [open, contactId, fetchContact, fetchTags, fetchNotes, fetchCustomFields, fetchDeals]);

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error(t('contacts.form.phone') + ' ' + t('common.required'));
      return;
    }

    setSavingDetails(true);
    try {
      await databases.updateDocument(DATABASE_ID, COLLECTIONS.contacts, contactId, {
        name: editName.trim() || null,
        phone: editPhone.trim(),
        email: editEmail.trim() || null,
        company: editCompany.trim() || null,
      });
      toast.success(t('common.update'));
      fetchContact();
      onUpdated();
    } catch {
      toast.error(t('common.error'));
    }
    setSavingDetails(false);
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);

    const isSelected = contactTagIds.includes(tagId);

    if (isSelected) {
      try {
        const existing = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.contactTags,
          [Query.equal('contact_id', contactId), Query.equal('tag_id', tagId)]
        );
        if (existing.documents.length > 0) {
          await databases.deleteDocument(DATABASE_ID, COLLECTIONS.contactTags, existing.documents[0].$id);
        }
        setContactTagIds((prev) => prev.filter((id) => id !== tagId));
        onUpdated();
      } catch {
        // silently fail
      }
    } else {
      try {
        await databases.createDocument(DATABASE_ID, COLLECTIONS.contactTags, 'unique()', {
          contact_id: contactId,
          tag_id: tagId,
        });
        setContactTagIds((prev) => [...prev, tagId]);
        onUpdated();
      } catch {
        // silently fail
      }
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    let user;
    try {
      user = await account.get();
    } catch {
      toast.error(t('common.error'));
      setSavingNote(false);
      return;
    }
    if (!user) {
      toast.error(t('common.error'));
      setSavingNote(false);
      return;
    }

    try {
      await databases.createDocument(DATABASE_ID, COLLECTIONS.contactNotes, 'unique()', {
        contact_id: contactId,
        user_id: user.$id,
        note_text: newNote.trim(),
      });
      setNewNote('');
      fetchNotes();
      toast.success(t('contacts.addNote'));
    } catch {
      toast.error(t('common.error'));
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    try {
      await databases.deleteDocument(DATABASE_ID, COLLECTIONS.contactNotes, noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success(t('common.delete'));
    } catch {
      toast.error(t('common.error'));
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    try {
      // Delete existing values and re-insert
      const existing = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contactCustomValues,
        [Query.equal('contact_id', contactId)]
      );
      await Promise.all(
        existing.documents.map((v: any) =>
          databases.deleteDocument(DATABASE_ID, COLLECTIONS.contactCustomValues, v.$id)
        )
      );

      const rows = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value: val.trim(),
        }));

      if (rows.length > 0) {
        await Promise.all(
          rows.map((r) =>
            databases.createDocument(DATABASE_ID, COLLECTIONS.contactCustomValues, 'unique()', r)
          )
        );
      }

      toast.success(t('common.save'));
    } catch {
      toast.error(t('common.error'));
    }
    setSavingCustom(false);
  }

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-slate-900 border-slate-700 text-slate-200 sm:max-w-lg w-full p-0"
      >
        {loading || !contact ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Header */}
            <SheetHeader className="p-4 border-b border-slate-700/50">
              <div className="flex items-center gap-3">
                <Avatar className="size-12 bg-slate-800 border border-slate-700">
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-white truncate">
                    {contact.name || t('common.name')}
                  </SheetTitle>
                  <SheetDescription className="text-slate-400 text-xs mt-0.5">
                    {t('contacts.form.firstName')}
                  </SheetDescription>
                  <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-slate-400">
                    <button
                      onClick={copyPhone}
                      className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer"
                    >
                      <Phone className="size-3" />
                      {contact.phone}
                      {copiedPhone ? (
                        <Check className="size-3 text-primary" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                    {contact.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="size-3" />
                        {contact.email}
                      </span>
                    )}
                    {contact.company && (
                      <span className="flex items-center gap-1">
                        <Building2 className="size-3" />
                        {contact.company}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </SheetHeader>

            {/* Tabs */}
            <Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
              <TabsList className="bg-slate-800/50 border-b border-slate-700 mx-4 mt-3">
                <TabsTrigger
                  value="details"
                  className="data-active:bg-slate-800 data-active:text-primary text-slate-400"
                >
                  {t('contacts.form.firstName')}
                </TabsTrigger>
                <TabsTrigger
                  value="tags"
                  className="data-active:bg-slate-800 data-active:text-primary text-slate-400"
                >
                  {t('contacts.tags')}
                </TabsTrigger>
                <TabsTrigger
                  value="notes"
                  className="data-active:bg-slate-800 data-active:text-primary text-slate-400"
                >
                  {t('contacts.notes')}
                </TabsTrigger>
                <TabsTrigger
                  value="custom"
                  className="data-active:bg-slate-800 data-active:text-primary text-slate-400"
                >
                  {t('contacts.form.firstName')}
                </TabsTrigger>
                <TabsTrigger
                  value="deals"
                  className="data-active:bg-slate-800 data-active:text-primary text-slate-400"
                >
                  {t('contacts.deals')}
                </TabsTrigger>
              </TabsList>

              {/* Details Tab */}
              <TabsContent value="details" className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-slate-400 text-xs">{t('contacts.form.firstName')}</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="bg-slate-800 border-slate-700 text-white h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-slate-400 text-xs">
                      {t('contacts.form.phone')} <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className="bg-slate-800 border-slate-700 text-white h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-slate-400 text-xs">{t('contacts.form.email')}</Label>
                    <Input
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className="bg-slate-800 border-slate-700 text-white h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-slate-400 text-xs">{t('contacts.form.company')}</Label>
                    <Input
                      value={editCompany}
                      onChange={(e) => setEditCompany(e.target.value)}
                      className="bg-slate-800 border-slate-700 text-white h-8 text-sm"
                    />
                  </div>
                  <Button
                    onClick={saveDetails}
                    disabled={savingDetails}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                    size="sm"
                  >
                    {savingDetails ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    {t('common.save')}
                  </Button>
                </div>
              </TabsContent>

              {/* Tags Tab */}
              <TabsContent value="tags" className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3">
                  <p className="text-xs text-slate-400">
                    {t('contacts.addTag')}
                  </p>
                  {allTags.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      {t('contacts.noTags')}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allTags.map((tag) => {
                        const selected = contactTagIds.includes(tag.id);
                        return (
                          <button
                            key={tag.id}
                            onClick={() => toggleTag(tag.id)}
                            disabled={savingTags}
                            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all cursor-pointer ${
                              selected
                                ? 'ring-2 ring-primary ring-offset-1 ring-offset-slate-900'
                                : 'opacity-50 hover:opacity-80'
                            }`}
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {selected && <Check className="size-3 mr-1" />}
                            {tag.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* Notes Tab */}
              <TabsContent value="notes" className="flex-1 flex flex-col min-h-0 px-4 py-3">
                <div className="space-y-2 mb-3">
                  <Textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder={t('contacts.addNote')}
                    className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 min-h-[60px] text-sm resize-none"
                  />
                  <Button
                    onClick={addNote}
                    disabled={!newNote.trim() || savingNote}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                    size="sm"
                  >
                    {savingNote ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    {t('contacts.addNote')}
                  </Button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2">
                  {loadingNotes ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-slate-500" />
                    </div>
                  ) : notes.length === 0 ? (
                    <p className="text-sm text-slate-500 text-center py-8">
                      {t('contacts.noNotes')}
                    </p>
                  ) : (
                    notes.map((note) => (
                      <div
                        key={note.id}
                        className="rounded-lg bg-slate-800/50 border border-slate-700/50 p-3 group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm text-slate-300 whitespace-pre-wrap flex-1">
                            {note.note_text}
                          </p>
                          <button
                            onClick={() => deleteNote(note.id)}
                            className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition-all cursor-pointer shrink-0"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <p className="text-xs text-slate-500 mt-1.5">
                          {new Date(note.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>

              {/* Custom Fields Tab */}
              <TabsContent value="custom" className="flex-1 overflow-y-auto px-4 py-3">
                {loadingCustom ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-slate-500" />
                  </div>
                ) : customFields.length === 0 ? (
                  <p className="text-sm text-slate-500 text-center py-8">
                    {t('contacts.noTags')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {customFields.map((field) => (
                      <div key={field.id} className="space-y-1.5">
                        <Label className="text-slate-400 text-xs capitalize">
                          {field.field_name}
                        </Label>
                        <Input
                          value={customValues[field.id] ?? ''}
                          onChange={(e) =>
                            setCustomValues((prev) => ({
                              ...prev,
                              [field.id]: e.target.value,
                            }))
                          }
                          placeholder={`Enter ${field.field_name}...`}
                          className="bg-slate-800 border-slate-700 text-white h-8 text-sm placeholder:text-slate-500"
                        />
                      </div>
                    ))}
                    <Button
                      onClick={saveCustomFields}
                      disabled={savingCustom}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                      size="sm"
                    >
                      {savingCustom ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      {t('common.save')}
                    </Button>
                  </div>
                )}
              </TabsContent>

              {/* Deals Tab */}
              <TabsContent value="deals" className="flex-1 overflow-y-auto px-4 py-3">
                {loadingDeals ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-primary" />
                  </div>
                ) : deals.length === 0 ? (
                  <p className="text-xs text-slate-500">{t('contacts.noDeals')}</p>
                ) : (
                  <div className="space-y-2">
                    {deals.map((deal) => (
                      <div
                        key={deal.id}
                        className="rounded-lg border border-slate-700 bg-slate-800/50 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-white">
                            {deal.title}
                          </p>
                          {deal.stage && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                backgroundColor: `${deal.stage.color}20`,
                                color: deal.stage.color,
                              }}
                            >
                              {deal.stage.name}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 flex items-center justify-between text-xs text-slate-400">
                          <span className="flex items-center gap-1">
                            <DollarSign className="size-3" />
                            {new Intl.NumberFormat('en-US', {
                              style: 'currency',
                              currency: deal.currency || 'USD',
                              maximumFractionDigits: 0,
                            }).format(Number(deal.value || 0))}
                          </span>
                          {deal.status && deal.status !== 'open' && (
                            <span
                              className={
                                deal.status === 'won'
                                  ? 'text-primary'
                                  : 'text-red-400'
                              }
                            >
                              {deal.status}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
