'use client';

import { useState } from 'react';
import { databases, account } from '@/lib/appwrite/client';
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db';
import { ID, Query } from 'appwrite';
import { Contact, MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

/** `broadcast_recipients` inserts are independent of the send rate. */
const INSERT_BATCH_SIZE = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const response = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.contactCustomValues,
      [Query.equal('contact_id', slice)],
    );

    for (const row of response.documents ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
    let contacts: Contact[] = [];

    if (audience.type === 'all') {
      const response = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contacts,
      );
      contacts = (response.documents ?? []).map((d: any) => ({ ...d, id: d.$id }));
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      const contactTagsRes = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contactTags,
        [Query.equal('tag_id', audience.tagIds)],
      );
      const contactTags = contactTagsRes.documents ?? [];

      if (contactTags.length > 0) {
        const uniqueContactIds = [
          ...new Set(contactTags.map((ct: any) => ct.contact_id)),
        ];
        const response = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.contacts,
          [Query.equal('$id', uniqueContactIds)],
        );
        contacts = (response.documents ?? []).map((d: any) => ({ ...d, id: d.$id }));
      }
    } else if (audience.type === 'custom_field' && audience.customField) {
      contacts = await resolveCustomFieldAudience(audience.customField);
    } else if (audience.type === 'csv' && audience.csvContacts) {
      contacts = await upsertCsvContacts(audience.csvContacts);
    }

    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const excludeRes = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contactTags,
        [Query.equal('tag_id', audience.excludeTagIds)],
      );
      const excludedIds = new Set((excludeRes.documents ?? []).map((r: any) => r.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    return contacts;
  }

  /**
   * CSV uploads arrive as raw phone/name pairs, not DB rows. Before we
   * can insert broadcast_recipients (whose contact_id FKs contacts.id),
   * we need real contacts.id UUIDs. So: look up each CSV phone in the
   * caller's contacts table; insert any that don't exist; return the
   * resolved set.
   *
   * Pre-existing implementation synthesized `csv-N` strings as
   * contact_id, which failed the UUID cast on insert — every CSV
   * broadcast silently created zero recipients.
   */
  async function upsertCsvContacts(
    csvRows: { phone: string; name?: string }[],
  ): Promise<Contact[]> {
    if (csvRows.length === 0) return [];

    let user;
    try {
      user = await account.get();
    } catch {
      throw new Error('You are not signed in.');
    }

    const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
    for (const row of csvRows) {
      if (row.phone) uniqueByPhone.set(row.phone, row);
    }
    const phones = [...uniqueByPhone.keys()];

    const existingRes = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.contacts,
      [Query.equal('user_id', user.$id), Query.equal('phone', phones)],
    );
    const existing = (existingRes.documents ?? []).map((d: any) => ({ ...d, id: d.$id }));

    const byPhone = new Map<string, Contact>();
    for (const c of existing as Contact[]) {
      if (c.phone) byPhone.set(c.phone, c);
    }

    const missing = phones
      .filter((p) => !byPhone.has(p))
      .map((phone) => ({
        user_id: user.$id,
        phone,
        name: uniqueByPhone.get(phone)?.name ?? null,
      }));

    const INSERT_CHUNK = 200;
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const docs = await Promise.all(
        chunk.map((item) =>
          databases.createDocument(DATABASE_ID, COLLECTIONS.contacts, ID.unique(), item),
        ),
      );
      for (const doc of docs) {
        const c = { ...doc, id: doc.$id } as unknown as Contact;
        if (c.phone) byPhone.set(c.phone, c);
      }
    }

    return phones
      .map((p) => byPhone.get(p))
      .filter((c): c is Contact => Boolean(c));
  }

  async function resolveCustomFieldAudience(
    filter: CustomFieldFilter,
  ): Promise<Contact[]> {
    const { fieldId, operator, value } = filter;

    let matches: any[];
    if (operator === 'contains') {
      const response = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contactCustomValues,
        [Query.equal('custom_field_id', fieldId)],
      );
      matches = (response.documents ?? []).filter(
        (m: any) => m.value?.includes(value),
      );
    } else {
      const queries = [Query.equal('custom_field_id', fieldId)];
      if (operator === 'is') queries.push(Query.equal('value', value));
      else if (operator === 'is_not') queries.push(Query.notEqual('value', value));
      const response = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contactCustomValues,
        queries,
      );
      matches = response.documents ?? [];
    }

    const contactIds = [...new Set(matches.map((m: any) => m.contact_id))];
    if (contactIds.length === 0) return [];

    const { documents } = await databases.listDocuments(
      DATABASE_ID,
      COLLECTIONS.contacts,
      [Query.equal('$id', contactIds)],
    );
    return (documents ?? []).map((d: any) => ({ ...d, id: d.$id }));
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    try {
      setProgress(5);
      const contacts = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      setProgress(10);
      let user;
      try {
        user = await account.get();
      } catch {
        throw new Error('You are not signed in.');
      }

      const broadcastDoc = await databases.createDocument(
        DATABASE_ID,
        COLLECTIONS.broadcasts,
        ID.unique(),
        {
          user_id: user.$id,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        },
      );
      const broadcast = { ...broadcastDoc, id: broadcastDoc.$id };

      setProgress(20);
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        try {
          await Promise.all(
            batch.map((row) =>
              databases.createDocument(DATABASE_ID, COLLECTIONS.broadcastRecipients, ID.unique(), row),
            ),
          );
        } catch (err) {
          await databases.updateDocument(DATABASE_ID, COLLECTIONS.broadcasts, broadcast.id, {
            status: 'failed',
            failed_count: contacts.length,
          });
          throw new Error(
            `Failed to insert recipient batch ${Math.floor(i / INSERT_BATCH_SIZE) + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`,
          );
        }
      }

      setProgress(30);
      const recipientsRes = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.broadcastRecipients,
        [Query.equal('broadcast_id', broadcast.id)],
      );
      const rawRecipients = recipientsRes.documents ?? [];

      const refContactIds = [...new Set(rawRecipients.map((r: any) => r.contact_id).filter(Boolean))] as string[];
      let contactMap = new Map<string, any>();
      if (refContactIds.length > 0) {
        const CONTACT_PAGE = 100;
        for (let i = 0; i < refContactIds.length; i += CONTACT_PAGE) {
          const slice = refContactIds.slice(i, i + CONTACT_PAGE);
          const res = await databases.listDocuments(DATABASE_ID, COLLECTIONS.contacts, [
            Query.equal('$id', slice),
          ]);
          for (const c of res.documents ?? []) {
            contactMap.set(c.$id, { ...c, id: c.$id });
          }
        }
      }

      const recipients = rawRecipients.map((r: any) => ({
        ...r,
        id: r.$id,
        contact: r.contact_id ? (contactMap.get(r.contact_id) ?? null) : null,
      }));

      const contactIds = recipients
        .map((r) => r.contact?.id)
        .filter((id): id is string => Boolean(id));
      const customValueIndex = await fetchCustomValueIndex(contactIds);

      let failedCount = 0;
      const totalRecipients = recipients.length;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => ({
            phone: r.contact!.phone as string,
            params: r.contact
              ? resolveVariables(
                  payload.variables,
                  r.contact,
                  customValueIndex.get(r.contact.id),
                )
              : [],
          }));

        if (apiRecipients.length === 0) continue;

        try {
          const res = await fetch('/api/whatsapp/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recipients: apiRecipients,
              template_name: payload.template.name,
              template_language: payload.template.language ?? 'en_US',
            }),
          });

          const data = await res.json();

          if (!res.ok) {
            throw new Error(data.error || 'Broadcast API request failed');
          }

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of (data.results ?? []) as BroadcastApiResult[]) {
            resultsByPhone.set(r.phone, r);
          }

          for (const recipient of batch) {
            const phone = recipient.contact?.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              failedCount++;
              await databases.updateDocument(
                DATABASE_ID,
                COLLECTIONS.broadcastRecipients,
                recipient.id,
                { status: 'failed', error_message: 'No phone number on contact' },
              );
              continue;
            }

            if (result.status === 'sent') {
              await databases.updateDocument(
                DATABASE_ID,
                COLLECTIONS.broadcastRecipients,
                recipient.id,
                {
                  status: 'sent',
                  sent_at: new Date().toISOString(),
                  whatsapp_message_id: result.whatsapp_message_id ?? null,
                  error_message: null,
                },
              );
            } else {
              failedCount++;
              await databases.updateDocument(
                DATABASE_ID,
                COLLECTIONS.broadcastRecipients,
                recipient.id,
                {
                  status: 'failed',
                  error_message: result.error ?? 'Unknown error',
                },
              );
            }
          }
        } catch (err) {
          for (const recipient of batch) {
            failedCount++;
            await databases.updateDocument(
              DATABASE_ID,
              COLLECTIONS.broadcastRecipients,
              recipient.id,
              {
                status: 'failed',
                error_message: err instanceof Error ? err.message : 'Unknown error',
              },
            );
          }
        }

        const progressPct =
          30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await databases.updateDocument(DATABASE_ID, COLLECTIONS.broadcasts, broadcast.id, {
        status: finalStatus,
      });

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
