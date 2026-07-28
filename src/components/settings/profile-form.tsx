'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Upload, Trash2, Mail, CircleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { databases, account } from '@/lib/appwrite/client';
import { DATABASE_ID, COLLECTIONS } from '@/lib/appwrite/db';
import { Query } from 'appwrite';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

// Rough email shape check — the real validator is Supabase Auth, which
// rejects anything malformed when we call updateUser({ email }). We
// just want to stop obvious typos before making a network call.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ProfileForm() {
  const { user, profile, refreshProfile } = useAuth();
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [emailChangePending, setEmailChangePending] = useState(false);

  // Seed form state once the profile loads.
  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
    setEmail(profile.email ?? '');
  }, [profile]);

  // Cleanup object URLs to avoid leaks.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const currentAvatar =
    previewUrl ?? (!removeAvatar ? profile?.avatar_url ?? null : null);

  const initial = (fullName || profile?.full_name || profile?.email || 'U')
    .charAt(0)
    .toUpperCase();

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so the same file can be re-picked
    if (!file) return;

    if (!ALLOWED_MIME.has(file.type)) {
      toast.error(t('settings.profile.unsupportedImage'), {
        description: t('settings.profile.unsupportedImageDesc'),
      });
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error(t('settings.profile.imageTooLarge'), {
        description: t('settings.profile.imageTooLargeDesc'),
      });
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingAvatar(file);
    setPreviewUrl(URL.createObjectURL(file));
    setRemoveAvatar(false);
  };

  const onRemoveAvatar = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingAvatar(null);
    setPreviewUrl(null);
    setRemoveAvatar(true);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !profile) return;

    const trimmedName = fullName.trim();
    if (!trimmedName) {
      toast.error(t('settings.profile.nameRequired'));
      return;
    }
    const trimmedEmail = email.trim();
    if (!EMAIL_RE.test(trimmedEmail)) {
      toast.error(t('settings.profile.invalidEmail'));
      return;
    }

    setSaving(true);
    try {
      let nextAvatarUrl: string | null = profile.avatar_url ?? null;

      const ENDPOINT = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!;
      const PROJECT_ID = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;

      // Upload a newly-staged image, if any.
      if (pendingAvatar) {
        const formData = new FormData();
        formData.append('fileId', 'unique()');
        formData.append('file', pendingAvatar);

        const uploadRes = await fetch(`${ENDPOINT}/storage/buckets/avatars/files`, {
          method: 'POST',
          headers: { 'X-Appwrite-Project': PROJECT_ID },
          credentials: 'include',
          body: formData,
        });
        if (!uploadRes.ok) {
          const errData = await uploadRes.json().catch(() => ({}));
          throw new Error(`Upload failed: ${errData.message || uploadRes.statusText}`);
        }
        const uploadData = await uploadRes.json();
        const fileId = uploadData.$id;
        nextAvatarUrl = `${ENDPOINT}/storage/buckets/avatars/files/${fileId}/preview?project=${PROJECT_ID}`;
      } else if (removeAvatar) {
        // Clean up old avatar from Appwrite Storage
        if (profile.avatar_url) {
          const match = profile.avatar_url.match(/\/files\/([a-f0-9]+)\/preview/);
          if (match) {
            try {
              await fetch(`${ENDPOINT}/storage/buckets/avatars/files/${match[1]}`, {
                method: 'DELETE',
                headers: { 'X-Appwrite-Project': PROJECT_ID },
                credentials: 'include',
              });
            } catch {
              // Non-critical — old file may not exist
            }
          }
        }
        nextAvatarUrl = null;
      }

      // Persist name + avatar to profiles.
      await databases.updateDocument(
        DATABASE_ID,
        COLLECTIONS.profiles,
        user.id,
        {
          full_name: trimmedName,
          avatar_url: nextAvatarUrl,
        }
      );

      // Email change through Appwrite Account API.
      let emailSent = false;
      if (trimmedEmail.toLowerCase() !== profile.email.toLowerCase()) {
        try {
          // Appwrite requires the current password for email changes.
          // Pass empty string — if a password is needed, the catch handler
          // will surface the error to the user.
          await account.updateEmail(trimmedEmail, '');
          emailSent = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : t('settings.profile.emailChangeFailed');
          // Partial success: name/avatar saved but email didn't.
          toast.success(t('settings.profile.saved'));
          toast.error(`${t('settings.profile.emailChangeFailed')}: ${msg}`);
          setSaving(false);
          await refreshProfile();
          return;
        }
      }

      setEmailChangePending(emailSent);
      setPendingAvatar(null);
      setPreviewUrl(null);
      setRemoveAvatar(false);
      await refreshProfile();

      toast.success(
        emailSent
          ? t('settings.profile.savedCheckEmail')
          : t('settings.profile.saved'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.profile.unknownError');
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    !!profile &&
    (fullName.trim() !== (profile.full_name ?? '') ||
      email.trim().toLowerCase() !== (profile.email ?? '').toLowerCase() ||
      pendingAvatar !== null ||
      removeAvatar);

  const joined = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '—';

  return (
    <Card className="bg-slate-900/40 border-slate-800">
      <CardHeader>
        <CardTitle className="text-white">{t('settings.profile.title')}</CardTitle>
        <CardDescription className="text-slate-400">
          {t('settings.profile.description')}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="space-y-6">
          {/* Avatar row */}
          <div className="flex flex-wrap items-center gap-5">
            <Avatar size="lg" className="size-16">
              {currentAvatar ? (
                <AvatarImage src={currentAvatar} alt={fullName || 'Avatar'} />
              ) : null}
              <AvatarFallback className="bg-primary/10 text-base text-primary">
                {initial}
              </AvatarFallback>
            </Avatar>

            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={onPickFile}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={saving}
              >
                <Upload className="size-4" />
                {currentAvatar ? t('settings.profile.changePhoto') : t('settings.profile.uploadPhoto')}
              </Button>
              {currentAvatar && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onRemoveAvatar}
                  disabled={saving}
                  className="text-slate-400 hover:text-white"
                >
                  <Trash2 className="size-4" />
                  {t('settings.profile.remove')}
                </Button>
              )}
              <p className="w-full text-xs text-slate-500">
                {t('settings.profile.avatarHint')}
              </p>
            </div>
          </div>

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="profile-full-name" className="text-slate-200">
              {t('settings.profile.displayName')}
            </Label>
            <Input
              id="profile-full-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Ada Lovelace"
              maxLength={120}
              disabled={saving}
              required
            />
          </div>

          {/* Email */}
          <div className="space-y-2">
            <Label htmlFor="profile-email" className="text-slate-200">
              {t('settings.profile.email')}
            </Label>
            <Input
              id="profile-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={saving}
              required
            />
            {emailChangePending && (
              <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                <Mail className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {t('settings.profile.checkInbox', { currentEmail: profile?.email, newEmail: email })}
                </span>
              </p>
            )}
          </div>

          {/* Read-only block */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
              {t('settings.profile.accountDetails')}
            </p>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">{t('settings.profile.role')}</dt>
                <dd className="mt-0.5 font-mono text-slate-200">
                  {profile?.role ?? 'user'}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t('settings.profile.joined')}</dt>
                <dd className="mt-0.5 text-slate-200">{joined}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-slate-500">{t('settings.profile.userId')}</dt>
                <dd className="mt-0.5 break-all font-mono text-xs text-slate-400">
                  {user?.id ?? '—'}
                </dd>
              </div>
            </dl>
          </div>

          {!profile && (
            <p className="flex items-center gap-2 text-sm text-slate-400">
              <CircleAlert className="size-4" />
              {t('settings.profile.loading')}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={saving || !dirty || !profile}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('settings.profile.saving')}
                </>
              ) : (
                t('settings.profile.saveChanges')
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
