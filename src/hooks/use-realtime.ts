"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { client } from "@/lib/appwrite/client";
import { DATABASE_ID, COLLECTIONS } from "@/lib/appwrite/db";
import type { Message, Conversation } from "@/types";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const unsubRef = useRef<(() => void) | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Store latest callbacks in refs to avoid re-subscribing when the
  // parent re-renders with fresh closures. Assigned inside an effect
  // so the mutation doesn't happen during render (React 19's refs
  // rule) — subscribers only read `.current` inside async Realtime
  // callbacks, which always run after the render that updates it.
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    const messagesChannel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.messages}.documents`;
    const conversationsChannel = `databases.${DATABASE_ID}.collections.${COLLECTIONS.conversations}.documents`;

    const unsub = client.subscribe(
      [messagesChannel, conversationsChannel],
      (response) => {
        const event = response.events[0] ?? "";
        const isInsert = event.includes(".create");
        const isUpdate = event.includes(".update");
        const isDelete = event.includes(".delete");
        let eventType: RealtimeEvent<Message>["eventType"] | null = null;
        if (isInsert) eventType = "INSERT";
        else if (isUpdate) eventType = "UPDATE";
        else if (isDelete) eventType = "DELETE";

        if (!eventType) return;

        const isMessages = event.startsWith(messagesChannel);
        const isConversations = event.startsWith(conversationsChannel);

        if (isMessages) {
          onMessageRef.current?.({
            eventType,
            new: response.payload as Message,
            old: {},
          });
        }

        if (isConversations) {
          onConversationRef.current?.({
            eventType,
            new: response.payload as Conversation,
            old: {},
          });
        }
      },
    );

    setIsConnected(true);
    unsubRef.current = unsub;

    return () => {
      unsub();
      unsubRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, enabled]);

  const unsubscribe = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
