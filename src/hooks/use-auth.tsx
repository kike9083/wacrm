"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { account, databases, client } from "@/lib/appwrite/client";
import { getClientSessionSecret, clearClientSession } from "@/lib/appwrite/client-session";
import { DATABASE_ID, COLLECTIONS } from "@/lib/appwrite/db";

interface AppwriteUser {
  $id: string;
  id: string;
  email: string;
  name: string;
  created_at?: string;
  [key: string]: unknown;
}

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[];
}

interface AuthContextValue {
  user: AppwriteUser | null;
  profile: Profile | null;
  loading: boolean;
  profileLoading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppwriteUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);

  const fetchProfile = useCallback(async (userId: string) => {
    setProfileLoading(true);
    try {
      const doc = await databases.getDocument(
        DATABASE_ID,
        COLLECTIONS.profiles,
        userId
      );
      if (doc) {
        setProfile({
          id: doc.$id,
          full_name: (doc as any).full_name ?? null,
          email: (doc as any).email ?? "",
          avatar_url: (doc as any).avatar_url ?? null,
          role: (doc as any).role ?? null,
          beta_features: Array.isArray((doc as any).beta_features) ? (doc as any).beta_features : [],
        });
      }
    } catch {
      console.warn("[AuthProvider] profile not found for user", userId);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const safetyTimer = setTimeout(() => {
      if (mounted) {
        console.warn("[AuthProvider] session check timed out after 3s");
        setLoading(false);
        setProfileLoading(false);
      }
    }, 3000);

    const checkSession = async () => {
      try {
        // Re-attach the session secret persisted by the server-side login
        // (the SDK cannot read the httpOnly cookie, and Appwrite 1.8.1
        // suppresses X-Fallback-Cookies for same-registerable-domain origins).
        const sessionSecret = getClientSessionSecret();
        if (sessionSecret) client.setSession(sessionSecret);

        const raw = await account.get();
        if (!mounted) return;
        const currentUser = { ...raw, id: raw.$id } as unknown as AppwriteUser;
        setUser(currentUser);
        fetchProfile(currentUser.$id);
      } catch {
        if (mounted) {
          setUser(null);
          setProfile(null);
          setProfileLoading(false);
        }
      } finally {
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    checkSession();

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
    };
  }, []);

  const signOut = useCallback(async () => {
    // Delete the Appwrite session, clear the SDK secret and the server
    // cookie, then redirect.
    await account.deleteSession("current").catch(() => {});
    clearClientSession();
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setProfile(null);
    window.location.href = "/login";
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user?.$id) return;
    await fetchProfile(user.$id);
  }, [user?.$id, fetchProfile]);

  return (
    <AuthContext.Provider
      value={{ user, profile, loading, profileLoading, signOut, refreshProfile }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => { window.location.href = "/login"; },
      refreshProfile: async () => {},
    };
  }
  return ctx;
}
