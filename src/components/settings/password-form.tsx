'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { account } from '@/lib/appwrite/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

const MIN_PASSWORD = 8;

export function PasswordForm() {
  const { profile } = useAuth();
  const { t } = useTranslation();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.email) {
      toast.error(t('settings.password.noEmail'));
      return;
    }
    if (next.length < MIN_PASSWORD) {
      setConfirmError(t('settings.password.tooShort', { min: MIN_PASSWORD }));
      return;
    }
    if (next !== confirm) {
      setConfirmError(t('settings.password.mismatch'));
      return;
    }
    setConfirmError(null);
    setSaving(true);

    try {
      // Verify current password by creating a session. If it fails, the
      // password is wrong — we abort before calling updatePassword.
      try {
        await account.createEmailPasswordSession(profile.email, current);
      } catch {
        toast.error(t('settings.password.incorrect'));
        return;
      }

      try {
        await account.updatePassword(next);
      } catch (err) {
        const msg = err instanceof Error ? err.message : t('settings.password.updateFailed');
        toast.error(`${t('settings.password.updateFailed')}: ${msg}`);
        return;
      }

      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success(t('settings.password.updated'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.password.unknownError');
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="bg-slate-900/40 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-white">
          <KeyRound className="size-4 text-primary" />
          {t('settings.password.title')}
        </CardTitle>
        <CardDescription className="text-slate-400">
          {t('settings.password.description', { min: MIN_PASSWORD })}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password" className="text-slate-200">
              {t('settings.password.current')}
            </Label>
            <Input
              id="current-password"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              disabled={saving}
              required
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="new-password" className="text-slate-200">
                {t('settings.password.new')}
              </Label>
              <Input
                id="new-password"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                disabled={saving}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password" className="text-slate-200">
                {t('settings.password.confirm')}
              </Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                disabled={saving}
                required
              />
            </div>
          </div>

          {confirmError && (
            <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
              {confirmError}
            </p>
          )}

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={saving || !current || !next || !confirm}
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('settings.password.updating')}
                </>
              ) : (
                t('settings.password.updateButton')
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
