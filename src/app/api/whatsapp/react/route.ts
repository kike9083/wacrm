import { NextResponse } from 'next/server';
import { createAdminClient, createSessionClient } from '@/lib/appwrite/server';
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db';
import { ID, Query } from 'node-appwrite';
import { createMetaDriver } from '@/lib/whatsapp/driver';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction to Meta and mirrors it into `message_reactions`
 * (delete on empty emoji). Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    const { account } = await createSessionClient();
    let user
    try {
      user = await account.get()
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limit = checkRateLimit(`react:${user.$id}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    const { databases } = createAdminClient()

    // Resolve target message + its conversation; verify ownership.
    let targetMessage
    try {
      targetMessage = await databases.getDocument(
        DATABASE_ID,
        COLLECTIONS.messages,
        message_id,
      )
    } catch {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (!targetMessage.message_id) {
      return NextResponse.json(
        { error: 'Cannot react to a message that has not been sent to WhatsApp' },
        { status: 400 },
      );
    }

    let convList
    try {
      convList = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.conversations,
        [
          Query.equal('$id', targetMessage.conversation_id),
          Query.equal('user_id', user.$id),
        ]
      )
    } catch {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }
    const conversation = convList.documents[0]
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    // Resolve contact phone from conversation
    let contactList
    try {
      contactList = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.contacts,
        [Query.equal('$id', conversation.contact_id)]
      )
    } catch {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }
    const contact = contactList.documents[0]
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }

    // WhatsApp config + access token
    let configList
    try {
      configList = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.whatsappConfig,
        [Query.equal('user_id', user.$id)]
      )
    } catch {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }
    const config = configList.documents[0]
    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    const accessToken = decrypt(config.access_token);
    const sanitizedPhone = sanitizePhoneForMeta(contact.phone);

    const driver = createMetaDriver({ phoneNumberId: config.phone_number_id, accessToken })

    try {
      await driver.sendReaction(sanitizedPhone, {
        targetMessageId: targetMessage.message_id,
        emoji,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown API error';
      console.error('[whatsapp/react] Send failed:', message);
      return NextResponse.json(
        { error: `WhatsApp API error: ${message}` },
        { status: 502 },
      );
    }

    // Mirror into DB. Empty emoji = removal.
    if (emoji === '') {
      let reactions
      try {
        reactions = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.messageReactions,
          [
            Query.equal('message_id', targetMessage.$id),
            Query.equal('actor_type', 'agent'),
            Query.equal('actor_id', user.$id),
          ]
        )
      } catch {
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB query failed' },
          { status: 500 },
        )
      }
      if (reactions.documents.length > 0) {
        try {
          await databases.deleteDocument(
            DATABASE_ID,
            COLLECTIONS.messageReactions,
            reactions.documents[0].$id,
          )
        } catch {
          console.error('[whatsapp/react] DB delete failed');
          return NextResponse.json(
            { error: 'Reaction sent to Meta but DB delete failed' },
            { status: 500 },
          );
        }
      }
    } else {
      // Check for existing reaction, then create or update
      let existing
      try {
        existing = await databases.listDocuments(
          DATABASE_ID,
          COLLECTIONS.messageReactions,
          [
            Query.equal('message_id', targetMessage.$id),
            Query.equal('actor_type', 'agent'),
            Query.equal('actor_id', user.$id),
          ]
        )
      } catch {
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB query failed' },
          { status: 500 },
        )
      }

      try {
        if (existing.documents.length > 0) {
          await databases.updateDocument(
            DATABASE_ID,
            COLLECTIONS.messageReactions,
            existing.documents[0].$id,
            { emoji },
          )
        } else {
          await databases.createDocument(
            DATABASE_ID,
            COLLECTIONS.messageReactions,
            ID.unique(),
            {
              message_id: targetMessage.$id,
              conversation_id: targetMessage.conversation_id,
              actor_type: 'agent',
              actor_id: user.$id,
              emoji,
            },
          )
        }
      } catch {
        console.error('[whatsapp/react] DB upsert failed');
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB upsert failed' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error);
    return NextResponse.json(
      { error: 'Failed to react to message' },
      { status: 500 },
    );
  }
}
