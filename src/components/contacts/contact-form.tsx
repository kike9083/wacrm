'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { databases, account } from '@/lib/appwrite/client';
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db';
import { Query } from 'appwrite';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';

interface ContactFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  contactTags?: ContactTag[];
  onSaved: () => void;
}

export function ContactForm({
  open,
  onOpenChange,
  contact,
  contactTags = [],
  onSaved,
}: ContactFormProps) {
  const { t } = useTranslation();
  const isEdit = !!contact;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);

  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);

  useEffect(() => {
    if (open) {
      setName(contact?.name ?? '');
      setPhone(contact?.phone ?? '');
      setEmail(contact?.email ?? '');
      setCompany(contact?.company ?? '');
      setSelectedTagIds(contactTags.map((ct) => ct.tag_id));
      fetchTags();
    }
  }, [open, contact]);

  async function fetchTags() {
    setLoadingTags(true);
    try {
      const { documents } = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.tags,
        [Query.orderAsc('name')]
      );
      setTags(documents as unknown as Tag[]);
    } catch {
      setTags([]);
    }
    setLoadingTags(false);
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!phone.trim()) {
      toast.error(t('contacts.form.phone') + ' ' + t('common.required'));
      return;
    }

    setSaving(true);

    try {
      let user;
      try {
        user = await account.get();
      } catch {
        throw new Error('Not authenticated');
      }
      if (!user) throw new Error('Not authenticated');

      let contactId = contact?.id;

      if (isEdit && contactId) {
        try {
          await databases.updateDocument(DATABASE_ID, COLLECTIONS.contacts, contactId, {
            name: name.trim() || null,
            phone: phone.trim(),
            email: email.trim() || null,
            company: company.trim() || null,
          });
        } catch (err) {
          throw err;
        }
      } else {
        try {
          const doc = await databases.createDocument(
            DATABASE_ID,
            COLLECTIONS.contacts,
            'unique()',
            {
              user_id: user.$id,
              name: name.trim() || null,
              phone: phone.trim(),
              email: email.trim() || null,
              company: company.trim() || null,
            }
          );
          contactId = doc.$id;
        } catch (err) {
          throw err;
        }
      }

      // Sync tags
      if (contactId) {
        const existingTags = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.contactTags,
          [Query.equal('contact_id', contactId)]
        );
        await Promise.all(
          existingTags.documents.map((t: any) =>
            databases.deleteDocument(DATABASE_ID, COLLECTIONS.contactTags, t.$id)
          )
        );

        if (selectedTagIds.length > 0) {
          await Promise.all(
            selectedTagIds.map((tag_id) =>
              databases.createDocument(DATABASE_ID, COLLECTIONS.contactTags, 'unique()', {
                contact_id: contactId!,
                tag_id,
              })
            )
          );
        }
      }

      toast.success(isEdit ? t('common.update') : t('common.create'));
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.error');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-200 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white">
            {isEdit ? t('contacts.editContact') : t('contacts.addContact')}
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            {isEdit
              ? t('contacts.editContact')
              : t('contacts.addContact')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cf-name" className="text-slate-300">
              {t('contacts.form.firstName')}
            </Label>
            <Input
              id="cf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-phone" className="text-slate-300">
              {t('contacts.form.phone')} <span className="text-red-400">*</span>
            </Label>
            <Input
              id="cf-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 234 567 8900"
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
            />
            <p className="text-xs text-slate-500">
              {t('contacts.form.phone')} +1
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-email" className="text-slate-300">
              {t('contacts.form.email')}
            </Label>
            <Input
              id="cf-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john@example.com"
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-company" className="text-slate-300">
              {t('contacts.form.company')}
            </Label>
            <Input
              id="cf-company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Acme Inc."
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-slate-300">{t('contacts.tags')}</Label>
            {loadingTags ? (
              <div className="flex items-center gap-2 text-slate-500 text-sm">
                <Loader2 className="size-3 animate-spin" />
                {t('common.loading')}
              </div>
            ) : tags.length === 0 ? (
              <p className="text-xs text-slate-500">
                {t('contacts.noTags')}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors cursor-pointer ${
                        selected
                          ? 'ring-2 ring-primary ring-offset-1 ring-offset-slate-900'
                          : 'opacity-60 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: tag.color + '20',
                        color: tag.color,
                        borderColor: tag.color,
                      }}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter className="bg-slate-900 border-slate-700">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? t('common.update') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
