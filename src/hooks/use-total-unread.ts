"use client";

import { useEffect, useRef, useState } from "react";
import { client, databases } from "@/lib/appwrite/client";
import { DATABASE_ID, COLLECTIONS } from "@/lib/appwrite/db";

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Lives on its own realtime channel (distinct from the inbox page's
 * "inbox-realtime") so both can coexist without sharing state.
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);

  // Keep a live local mirror of {id: unread_count} so INSERT/UPDATE/DELETE
  // events can adjust the total in O(1) without refetching.
  const countsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;

    // Initial load.
    (async () => {
      const response = await databases.listDocuments(
        DATABASE_ID,
        COLLECTIONS.conversations,
      );
      if (cancelled) return;

      const map = new Map<string, number>();
      let sum = 0;
      for (const row of response.documents as unknown as {
        $id: string;
        unread_count: number;
      }[]) {
        const n = row.unread_count ?? 0;
        map.set(row.$id, n);
        if (n > 0) sum += 1;
      }
      countsRef.current = map;
      setTotal(sum);
    })();

    const unsubscribe = client.subscribe(
      `databases.${DATABASE_ID}.collections.${COLLECTIONS.conversations}.documents`,
      (response) => {
        const map = countsRef.current;
        const event = response.events[0] ?? "";
        const payload = response.payload as {
          $id: string;
          unread_count: number;
        };

        if (event.includes(".delete")) {
          map.delete(payload.$id);
        } else {
          map.set(payload.$id, payload.unread_count ?? 0);
        }
        let sum = 0;
        for (const n of map.values()) if (n > 0) sum += 1;
        setTotal(sum);
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return total;
}
