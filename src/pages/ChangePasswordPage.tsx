import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

const MIN_PASSWORD_LENGTH = 8;

const ChangePasswordPage: React.FC = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    supabase.auth
      .getUser()
      .then(({ data, error: authError }) => {
        if (!active) return;
        if (authError) {
          console.warn("Не удалось получить информацию о пользователе", authError);
          setError("Не удалось загрузить данные пользователя.");
        }
        setUser(data?.user ?? null);
        setLoading(false);
      })
      .catch((authError) => {
        if (!active) return;
        console.warn("Не удалось загрузить пользователя", authError);
        setError("Не удалось загрузить данные пользователя.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const passwordHint = useMemo(
    () => [
      `Минимум ${MIN_PASSWORD_LENGTH} символов`,
      "Желательно смешивать буквы разных регистров и цифры",
      "Новый пароль не должен совпадать с текущим",
    ],
    [],
  );

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setStatus(null);
      if (!user?.email) {
        setError("Войдите в аккаунт, чтобы сменить пароль.");
        return;
      }
      if (!currentPassword.trim()) {
        setError("Введите текущий пароль.");
        return;
      }
      if (!newPassword.trim()) {
        setError("Введите новый пароль.");
        return;
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setError(`Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`);
        return;
      }
      if (newPassword !== confirmPassword) {
        setError("Подтверждение пароля не совпадает.");
        return;
      }
      if (newPassword === currentPassword) {
        setError("Новый пароль должен отличаться от текущего.");
        return;
      }

      setSaving(true);
      try {
        const { error: verifyError } = await supabase.auth.signInWithPassword({
          email: user.email,
          password: currentPassword,
        });
        if (verifyError) {
          throw new Error("Текущий пароль указан неверно.");
        }

        const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
        if (updateError) {
          throw updateError;
        }

        setStatus("Пароль обновлён. Используйте его при следующем входе.");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } catch (submitError) {
        const message = submitError instanceof Error ? submitError.message : String(submitError);
        setError(message || "Не удалось обновить пароль.");
      } finally {
        setSaving(false);
      }
    },
    [confirmPassword, currentPassword, newPassword, user?.email],
  );

  return (
    <div className="min-h-screen bg-slate-950 text-white px-4 py-10">
      <div className="max-w-xl mx-auto">
        <button type="button" className="text-sm text-white/70 hover:text-white" onClick={() => navigate(-1)}>
          ← Назад
        </button>
        <h1 className="text-2xl font-semibold mt-4 mb-3">Смена пароля</h1>
        <p className="text-sm text-white/70 mb-6">
          Пароль используется для входа через Supabase. Он хранится в зашифрованном виде. Здесь можно подтвердить текущий
          пароль и задать новый.
        </p>

        {loading ? <div className="text-sm text-white/70">Загрузка...</div> : null}
        {!loading && !user ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="text-base font-semibold mb-2">Нужно войти</div>
            <div className="text-sm text-white/70">
              Чтобы сменить пароль, сначала войдите в приложение.
            </div>
            <button
              type="button"
              className="mt-4 inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold"
              onClick={() => navigate("/")}
            >
              Перейти на страницу входа
            </button>
          </div>
        ) : null}

        {user ? (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
            <div>
              <label className="block text-sm text-white/70 mb-1">Текущий пароль</label>
              <input
                type="password"
                className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div>
              <label className="block text-sm text-white/70 mb-1">Новый пароль</label>
              <input
                type="password"
                className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="block text-sm text-white/70 mb-1">Подтверждение</label>
              <input
                type="password"
                className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 outline-none"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
              />
            </div>
            <ul className="text-xs text-white/50 list-disc pl-5 space-y-1">
              {passwordHint.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {error ? <div className="text-sm text-red-400">{error}</div> : null}
            {status ? (
              <div className="text-sm text-emerald-400">
                <strong>{status}</strong>
              </div>
            ) : null}
            <button
              type="submit"
              disabled={saving}
              className="w-full rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 px-3 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {saving ? "Сохраняем..." : "Обновить пароль"}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
};

export default ChangePasswordPage;
