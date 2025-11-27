import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

const MIN_PASSWORD_LENGTH = 8;

const PasswordRecoveryPage: React.FC = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
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
          console.warn("Не удалось получить пользователя для восстановления", authError);
          setError("Не удалось загрузить данные восстановления.");
        }
        setUser(data?.user ?? null);
        setLoading(false);
      })
      .catch((authError) => {
        if (!active) return;
        console.warn("Не удалось загрузить пользователя", authError);
        setError("Не удалось загрузить данные восстановления.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setStatus(null);
      if (!user) {
        setError("Ссылка восстановления больше не активна. Запросите новую из приложения.");
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

      setSaving(true);
      try {
        const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
        if (updateError) {
          throw updateError;
        }
        setStatus("Пароль обновлен. Сейчас откроется приложение.");
        setNewPassword("");
        setConfirmPassword("");
        setTimeout(() => {
          navigate("/app", { replace: true });
        }, 600);
      } catch (submitError) {
        const message = submitError instanceof Error ? submitError.message : String(submitError);
        setError(message || "Не удалось обновить пароль.");
      } finally {
        setSaving(false);
      }
    },
    [confirmPassword, navigate, newPassword, user],
  );

  return (
    <div className="min-h-screen bg-slate-950 text-white px-4 py-10">
      <div className="max-w-lg mx-auto">
        <button type="button" className="text-sm text-white/70 hover:text-white" onClick={() => navigate(-1)}>
          ← Назад
        </button>
        <h1 className="text-2xl font-semibold mt-4 mb-3">Сброс пароля</h1>
        <p className="text-sm text-white/70 mb-6">
          Установите новый пароль для входа. Ссылка восстановления действует ограниченное время, поэтому завершите процесс
          сразу после открытия письма.
        </p>

        {loading ? <div className="text-sm text-white/70">Проверяем ссылку...</div> : null}
        {!loading && !user ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-2">
            <div className="text-base font-semibold">Ссылка устарела</div>
            <div className="text-sm text-white/70">
              Запросите новое письмо в приложении Synastry (кнопка «Забыли пароль?» на экране входа).
            </div>
            <button
              type="button"
              className="mt-2 inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold"
              onClick={() => navigate("/")}
            >
              Вернуться на страницу входа
            </button>
          </div>
        ) : null}

        {user ? (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4 rounded-2xl border border-white/10 bg-white/5 p-4">
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
              <li>Минимум {MIN_PASSWORD_LENGTH} символов</li>
              <li>Желательно добавлять цифры и символы</li>
            </ul>
            {error ? <div className="text-sm text-red-400">{error}</div> : null}
            {status ? <div className="text-sm text-emerald-400">{status}</div> : null}
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

export default PasswordRecoveryPage;
