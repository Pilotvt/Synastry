import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

const SettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState<boolean>(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (!isMounted) return;
        const id = data?.user?.id ?? null;
        setUserId(id);
        if (!id) {
          setLoading(false);
          setStatus("Нужно войти в учётную запись, чтобы управлять уведомлениями.");
        }
      })
      .catch((authError) => {
        console.warn("Не удалось получить данные профиля", authError);
        if (!isMounted) return;
        setLoading(false);
        setError("Не удалось загрузить данные профиля.");
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const fetchSettings = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const { data, error: queryError } = await supabase
        .from("profiles")
        .select("notify_email_messages")
        .eq("id", userId)
        .single();
      if (queryError && queryError.code !== "PGRST116") throw queryError;
      setNotifyEmail(Boolean(data?.notify_email_messages));
    } catch (fetchError) {
      console.warn("Не удалось получить настройки уведомлений", fetchError);
      setError("Не удалось загрузить настройки.");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void fetchSettings();
  }, [userId, fetchSettings]);

  const persistSetting = useCallback(
    async (nextValue: boolean) => {
      if (!userId) return;
      setSaving(true);
      setError(null);
      setStatus(null);
      try {
        const payload = { id: userId, notify_email_messages: nextValue };
        const { error: upsertError } = await supabase.from("profiles").upsert(payload, { onConflict: "id" });
        if (upsertError) throw upsertError;
        setNotifyEmail(nextValue);
        setStatus("Настройка сохранена.");
      } catch (persistError) {
        console.error("Не удалось сохранить настройку уведомлений", persistError);
        setError("Не удалось сохранить настройку. Попробуйте позже.");
      } finally {
        setSaving(false);
      }
    },
    [userId],
  );

  if (!userId) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center px-4 text-center">
        <div className="text-lg font-semibold mb-2">Настройки доступны после входа</div>
        <div className="text-sm text-white/70">Войдите в профиль, чтобы управлять уведомлениями.</div>
        <button
          type="button"
          className="mt-6 px-4 py-2 rounded-lg bg-blue-600 text-sm font-semibold"
          onClick={() => navigate("/auth")}
        >
          Войти / создать
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6">
      <div className="max-w-2xl mx-auto">
        <button type="button" className="text-sm text-white/70 hover:text-white" onClick={() => navigate(-1)}>
          ← Назад
        </button>
        <h1 className="text-2xl font-semibold mt-4 mb-4">Настройки уведомлений</h1>
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <label className="flex items-start gap-3 cursor-default">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-pink-500"
              checked={notifyEmail}
              disabled
              onChange={(event) => persistSetting(event.target.checked)}
            />
            <div>
              <div className="text-base font-semibold">Уведомления на email (в разработке)</div>
              <div className="text-sm text-white/70">
                Почтовые уведомления появятся в одном из ближайших обновлений. Пока доступны уведомления внутри приложения.
              </div>
            </div>
          </label>
        </div>
        {loading ? <div className="text-sm text-white/70 mt-4">Загрузка...</div> : null}
        {saving ? <div className="text-sm text-white/70 mt-2">Сохранение...</div> : null}
        {status ? <div className="text-sm text-green-400 mt-2">{status}</div> : null}
        {error ? <div className="text-sm text-red-400 mt-2">{error}</div> : null}
      </div>
    </div>
  );
};

export default SettingsPage;
