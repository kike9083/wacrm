"use client";

import { useState, useEffect, useCallback } from "react";
import { databases, account } from "@/lib/appwrite/client";
import { DATABASE_ID, COLLECTIONS } from "@/lib/appwrite/db";
import { Query } from "appwrite";
import { cn } from "@/lib/utils";
import type { Contact, Deal, ContactNote, Tag, PipelineStage } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";

interface ContactSidebarProps {
  contact: Contact | null;
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    // Fetch deals, notes, and tags in parallel
    const [dealsRes, notesRes, contactTagsRes] = await Promise.all([
      databases.listDocuments(DATABASE_ID, COLLECTIONS.deals, [
        Query.equal("contact_id", contact.id),
        Query.orderDesc("created_at"),
      ]),
      databases.listDocuments(DATABASE_ID, COLLECTIONS.contactNotes, [
        Query.equal("contact_id", contact.id),
        Query.orderDesc("created_at"),
      ]),
      databases.listDocuments(DATABASE_ID, COLLECTIONS.contactTags, [
        Query.equal("contact_id", contact.id),
      ]),
    ]);

    const dealsData = dealsRes.documents.map((d: any) => ({
      ...d,
      id: d.$id,
    })) as Deal[];
    setDeals(dealsData);

    setNotes(
      notesRes.documents.map((d: any) => ({
        ...d,
        id: d.$id,
      })) as ContactNote[]
    );

    // Fetch linked tags
    if (contactTagsRes.documents.length > 0) {
      const tagIds = contactTagsRes.documents
        .map((ct: any) => ct.tag_id)
        .filter(Boolean);
      const uniqueTagIds = [...new Set(tagIds)];
      if (uniqueTagIds.length > 0) {
        const tagsRes = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.tags,
          [Query.equal("$id", uniqueTagIds)]
        );
        const tagsMap = new Map(
          tagsRes.documents.map((t: any) => [
            t.$id,
            { ...t, id: t.$id } as Tag,
          ])
        );
        const mapped = contactTagsRes.documents
          .filter((ct: any) => ct.tag_id && tagsMap.has(ct.tag_id))
          .map((ct: any) => ({
            ...tagsMap.get(ct.tag_id)!,
            contact_tag_id: ct.$id,
          }));
        setTags(mapped);
      } else {
        setTags([]);
      }
    } else {
      setTags([]);
    }

    // Fetch pipeline stages for deals
    const stageIds = [
      ...new Set(dealsData.map((d: any) => d.stage_id).filter(Boolean)),
    ];
    if (stageIds.length > 0) {
      const stagesRes = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.pipelineStages,
        [Query.equal("$id", stageIds)]
      );
      const stagesMap = new Map(
        stagesRes.documents.map((s: any) => [s.$id, { ...s, id: s.$id }])
      );
      setDeals((prev) =>
        prev.map((deal) => ({
          ...deal,
          stage: stagesMap.get((deal as any).stage_id) as PipelineStage,
        }))
      );
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    setAddingNote(true);

    try {
      const currentUser = await account.get();
      const doc = await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.contactNotes,
        "unique()",
        {
          contact_id: contact.id,
          user_id: currentUser.$id,
          note_text: newNote.trim(),
        }
      );
      setNotes((prev) => [
        { ...doc, id: doc.$id } as unknown as ContactNote,
        ...prev,
      ]);
      setNewNote("");
    } catch (err) {
      console.error("Failed to add note:", err);
    }
    setAddingNote(false);
  }, [contact, newNote]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-slate-800 bg-slate-900">
        <p className="text-sm text-slate-500">Select a conversation</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-slate-800 bg-slate-900">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-700 text-lg font-semibold text-white">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-white">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-slate-400">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800"
            >
              <Phone className="h-4 w-4 text-slate-500" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-slate-600" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300">
                <Mail className="h-4 w-4 text-slate-500" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-slate-800" />

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-slate-500">
              <TagIcon className="h-3 w-3" />
              Tags
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-slate-600">No tags</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-slate-800" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-slate-500">
              <DollarSign className="h-3 w-3" />
              Active Deals
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-slate-600">No deals</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-slate-800 px-3 py-2"
                  >
                    <p className="text-sm font-medium text-white">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-slate-800" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-slate-500">
              <StickyNote className="h-3 w-3" />
              Notes
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-slate-800 px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-slate-300">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-slate-600">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
