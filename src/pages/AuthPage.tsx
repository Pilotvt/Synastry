import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

const AUTH_REDIRECT_URI = "synastry://auth-callback";

export default function AuthPage() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let unsub: { unsubscribe?: () => void } | null = null;
    (async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      const sub = supabase.auth.onAuthStateChange((_evt, s) => {
        setSession(s ?? null);
      });
      unsub = sub?.data?.subscription ?? null;
    })();
    return () => {
      try {
        unsub?.unsubscribe?.();
      } catch (cleanupError) {
        console.warn("Не удалось отписаться от канала auth", cleanupError);
      }
    };
  }, []);

  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    (async () => {
      try {
        const uid = session.user.id;
        const { data, error } = await supabase
          .from('profiles')
          .select('id')
          .eq('id', uid)
          .maybeSingle();
        if (cancelled) return;
        if (!error && data && data.id) {
          navigate(`/user/${uid}`, { replace: true });
          return;
        }
        navigate('/app', { replace: true });
      } catch {
        navigate('/app', { replace: true });
      }
    })();
    return () => { cancelled = true; };
  }, [session?.user, navigate]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password: pass,
          options: { emailRedirectTo: AUTH_REDIRECT_URI },
        });
        if (error) throw error;
        alert("Мы отправили письмо для подтверждения. Проверьте почту.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password: pass,
        });
        if (error) throw error;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErr(message || "Ошибка входа/регистрации");
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-950 to-black text-white">
      <div className="mx-auto max-w-md px-4 py-12">
        <h1 className="text-2xl font-semibold mb-4">Вход / Регистрация</h1>
        <p className="text-sm text-white/60 mb-6">
          Укажите e-mail и пароль. После регистрации подтвердите e-mail по ссылке из письма.
        </p>

        <div className="mb-3 flex gap-2 text-xs">
          <button
            type="button"
            onClick={() => setMode("signup")}
            className={`px-3 py-1 rounded ${mode === "signup" ? "bg-white/20" : "bg-white/10"}`}
          >
            Регистрация
          </button>
          <button
            type="button"
            onClick={() => setMode("login")}
            className={`px-3 py-1 rounded ${mode === "login" ? "bg-white/20" : "bg-white/10"}`}
          >
            Вход
          </button>
        </div>

        <form onSubmit={onSubmit} className="rounded-2xl bg-white/5 border border-white/10 p-4 space-y-3">
          <div>
            <label className="block text-sm mb-1 text-white/70">E-mail</label>
            <input
              type="email"
              required
              className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-sm mb-1 text-white/70">Пароль</label>
            <input
              type="password"
              required
              className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="********"
            />
          </div>
          {err && <div className="text-xs text-red-400">{err}</div>}
          <button
            type="submit"
            className="w-full rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 px-3 py-2"
          >
            {mode === "signup" ? "Зарегистрироваться" : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
