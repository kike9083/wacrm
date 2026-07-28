'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { databases } from "@/lib/appwrite/client"
import { DATABASE_ID, COLLECTIONS } from "@/lib/appwrite/db"
import { Query } from "appwrite"
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';

const PAGE_SIZE = 25;

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

export default function ContactsPage() {
  const { t } = useTranslation();
  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // All tags for display
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});

  const fetchTags = useCallback(async () => {
    const response = await databases.listDocuments(DATABASE_ID, COLLECTIONS.tags, []);
    if (response.documents) {
      const map: Record<string, Tag> = {};
      response.documents.forEach((t: any) => (map[t.$id] = t));
      setTagsMap(map);
    }
  }, []);

  const fetchContacts = useCallback(async () => {
    setLoading(true);

    const from = page * PAGE_SIZE;

    const queries: string[] = [
      Query.orderDesc('created_at'),
      Query.limit(PAGE_SIZE),
      Query.offset(from),
    ];

    if (search.trim()) {
      queries.push(Query.search('name', search.trim()));
    }

    let response;
    try {
      response = await databases.listDocuments(DATABASE_ID, COLLECTIONS.contacts, queries);
    } catch {
      toast.error(t('common.error'));
      setLoading(false);
      return;
    }

    setTotalCount(response.total);

    if (response.documents.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // Fetch tags for these contacts
    const contactIds = response.documents.map((c: any) => c.$id);
    let contactTagsResponse;
    try {
      contactTagsResponse = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contactTags,
        [Query.equal('contact_id', contactIds)]
      );
    } catch {
      contactTagsResponse = { documents: [] };
    }

    const tagsByContact: Record<string, string[]> = {};
    contactTagsResponse.documents.forEach((ct: any) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    const enriched: ContactWithTags[] = response.documents.map((c: any) => ({
      ...c,
      id: c.$id,
      created_at: c.$createdAt,
      tags: (tagsByContact[c.$id] ?? [])
        .map((tid) => tagsMap[tid])
        .filter(Boolean),
    }));

    setContacts(enriched);
    setLoading(false);
  }, [page, search, tagsMap]);

  // Load-once-on-mount-ish data fetches. Each setter inside runs
  // inside an async promise completion (Supabase await), not
  // synchronously in the effect body, so the cascade the lint rule
  // warns about doesn't apply here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const response = await databases.listDocuments(DATABASE_ID, COLLECTIONS.contactTags, [
      Query.equal('contact_id', contact.id),
    ]);
    setEditContact(contact);
    setEditContactTags(response.documents as any[]);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    try {
      await databases.deleteDocument(DATABASE_ID, COLLECTIONS.contacts, deleteTarget.id);
      toast.success(t('contacts.deleteContact'));
      fetchContacts();
    } catch {
      toast.error(t('common.error'));
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{t('contacts.title')}</h1>
          <p className="text-sm text-slate-400 mt-1">
            {t('contacts.subtitle')} {totalCount > 0 && `${totalCount} total contacts.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setImportOpen(true)}
            className="border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            <Upload className="size-4" />
            {t('contacts.importContacts')}
          </Button>
          <Button
            onClick={openAddForm}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" />
            {t('contacts.addContact')}
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            // Reset pagination when the query changes — the result
            // set shrinks/grows, page N may no longer be valid.
            setPage(0);
          }}
          placeholder={t('contacts.searchPlaceholder')}
          className="pl-8 bg-slate-900 border-slate-700 text-white placeholder:text-slate-500"
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-slate-800 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-slate-800 hover:bg-transparent">
              <TableHead className="text-slate-400">{t('contacts.form.firstName')}</TableHead>
              <TableHead className="text-slate-400">{t('contacts.form.phone')}</TableHead>
              <TableHead className="text-slate-400 hidden md:table-cell">{t('contacts.form.email')}</TableHead>
              <TableHead className="text-slate-400 hidden lg:table-cell">{t('contacts.form.company')}</TableHead>
              <TableHead className="text-slate-400 hidden md:table-cell">{t('contacts.tags')}</TableHead>
              <TableHead className="text-slate-400 hidden lg:table-cell">{t('contacts.createdAt')}</TableHead>
              <TableHead className="text-slate-400 w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-slate-800">
                <TableCell colSpan={7} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-slate-500">{t('common.loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-slate-800">
                <TableCell colSpan={7} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-slate-600" />
                    <p className="text-sm text-slate-500">
                      {search ? t('common.noResults') : t('contacts.noContacts')}
                    </p>
                    {!search && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="mt-2 border-slate-700 text-slate-300 hover:bg-slate-800"
                      >
                        <Plus className="size-3.5" />
                        {t('contacts.addContact')}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="border-slate-800 hover:bg-slate-900/50 cursor-pointer"
                  onClick={() => openDetail(contact.id)}
                >
                  <TableCell className="text-white font-medium">
                    {contact.name || <span className="text-slate-500 italic">{t('common.name')}</span>}
                  </TableCell>
                  <TableCell className="text-slate-300 font-mono text-xs">
                    {contact.phone}
                  </TableCell>
                  <TableCell className="text-slate-400 hidden md:table-cell text-sm">
                    {contact.email || <span className="text-slate-600">-</span>}
                  </TableCell>
                  <TableCell className="text-slate-400 hidden lg:table-cell text-sm">
                    {contact.company || <span className="text-slate-600">-</span>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {contact.tags && contact.tags.length > 0 ? (
                        contact.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-slate-600 text-xs">-</span>
                      )}
                      {contact.tags && contact.tags.length > 3 && (
                        <span className="text-[10px] text-slate-500">
                          +{contact.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-500 text-xs hidden lg:table-cell">
                    {new Date(contact.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-slate-400 hover:text-white"
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="bg-slate-900 border-slate-700"
                      >
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditForm(contact);
                          }}
                          className="text-slate-300 focus:bg-slate-800 focus:text-white"
                        >
                          <Pencil className="size-4" />
                          {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-slate-700" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete(contact);
                          }}
                        >
                          <Trash2 className="size-4" />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500">
            {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, totalCount)} /{' '}
            {totalCount}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs text-slate-400 px-2">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          fetchContacts();
          fetchTags();
        }}
      />

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={fetchContacts}
      />

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-slate-900 border-slate-700 text-slate-200 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white">{t('contacts.deleteContact')}</DialogTitle>
            <DialogDescription className="text-slate-400">
              {t('contacts.deleteConfirmation')}{' '}
              <span className="text-slate-200 font-medium">
                {deleteTarget?.name || deleteTarget?.phone}
              </span>
              ? {t('common.cannotBeUndone')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-slate-900 border-slate-700">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
