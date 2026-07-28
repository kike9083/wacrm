'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

export function SessionsCard() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const onConfirm = async () => {
    setSigningOut(true);
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok) {
        toast.error(t('settings.sessions.signOutFailed'));
        return;
      }
      window.location.href = '/login';
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.sessions.unknownError');
      toast.error(msg);
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <>
      <Card className="bg-slate-900/40 border-slate-800">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white">
            <LogOut className="size-4 text-primary" />
            {t('settings.sessions.title')}
          </CardTitle>
          <CardDescription className="text-slate-400">
            {t('settings.sessions.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(true)}
          >
            <LogOut className="size-4" />
            {t('settings.sessions.signOutAll')}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.sessions.confirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.sessions.confirmDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={signingOut}
            >
              {t('settings.sessions.cancel')}
            </Button>
            <Button type="button" onClick={onConfirm} disabled={signingOut}>
              {signingOut ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('settings.sessions.signingOut')}
                </>
              ) : (
                t('settings.sessions.confirmButton')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
