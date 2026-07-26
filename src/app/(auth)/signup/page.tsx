"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { client } from "@/lib/appwrite/client";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MessageSquare } from "lucide-react";

export default function SignupPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("auth.passwordsDoNotMatch"));
      return;
    }

    if (password.length < 6) {
      setError(t("auth.passwordMinLength"));
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name: fullName }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t("auth.signupFailed"));
        setLoading(false);
        return;
      }

      client.setSession(data.secret);
      router.push("/dashboard");
    } catch {
      setError(t("auth.networkError"));
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="fixed right-4 top-4 z-50">
        <LanguageSwitcher />
      </div>
      <Card className="w-full max-w-md border-slate-800 bg-slate-900">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <MessageSquare className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-white">{t("auth.createAccountTitle")}</CardTitle>
          <CardDescription className="text-slate-400">
            {t("auth.getStarted")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-slate-300">
                {t("auth.fullName")}
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder={t("auth.namePlaceholder")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500 focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-slate-300">
                {t("auth.email")}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t("auth.emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500 focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-slate-300">
                {t("auth.password")}
              </Label>
              <Input
                id="password"
                type="password"
                placeholder={t("auth.passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500 focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-slate-300">
                {t("auth.confirmPassword")}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder={t("auth.confirmPasswordPlaceholder")}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500 focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t("auth.creatingAccount") : t("auth.createAccount")}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-400">
            {t("auth.alreadyHaveAccount")}{" "}
            <Link
              href="/login"
              className="text-primary hover:text-primary/80"
            >
              {t("auth.signIn")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
