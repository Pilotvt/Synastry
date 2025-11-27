import React from "react";
import { useNavigate } from "react-router-dom";
import { useBlocklistController } from "../hooks/useBlocklistController";
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from "../constants/buttonPalette";

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const BlacklistSettingsPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    userId,
    entries,
    loading,
    initialized,
    storeError,
    localError,
    refreshing,
    busyId,
    handleRefresh,
    handleUnblock,
  } = useBlocklistController();

  if (!userId) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center px-4 text-center">
        <div className="text-lg font-semibold mb-2">Нужна авторизация</div>
        <div className="text-sm text-white/70">
          Войдите в аккаунт, чтобы управлять чёрным списком и скрывать профили из выдачи.
        </div>
        <button
          type="button"
          className={`${BUTTON_PRIMARY} mt-6 px-6 py-2 text-sm font-semibold`}
          onClick={() => navigate("/auth")}
        >
          Перейти к входу
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <button type="button" className={`${BUTTON_SECONDARY} px-3 py-1.5 text-sm`} onClick={() => navigate(-1)}>
          ← Назад
        </button>
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <h1 className="text-2xl font-semibold">Чёрный список</h1>
          <button
            type="button"
            className={`${BUTTON_SECONDARY} px-3 py-1 text-xs`}
            onClick={handleRefresh}
            disabled={refreshing || loading}
          >
            {refreshing ? "Обновляем…" : "Обновить"}
          </button>
        </div>
        <p className="text-sm text-white/70 max-w-2xl">
          Заблокированные пользователи не смогут писать вам сообщения и не будут попадаться в выдаче анкет. Вы можете
          разблокировать их в любой момент.
        </p>

        {loading && !initialized ? <div className="text-sm text-white/70">Загружаем список…</div> : null}
        {storeError ? <div className="text-sm text-red-400">{storeError}</div> : null}
        {localError ? <div className="text-sm text-red-400">{localError}</div> : null}

        {entries.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/20 bg-white/5 p-6 text-sm text-white/70">
            Чёрный список пуст. Чтобы скрыть пользователя, заблокируйте его из чата или карточки анкеты.
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => {
              const fullName = [entry.personName, entry.lastName].filter(Boolean).join(" ") || "Без имени";
              const city = entry.cityName || "Город не указан";
              const blockedLabel = dateFormatter.format(new Date(entry.blockedAt));
              return (
                <div
                  key={entry.id}
                  className="flex flex-col md:flex-row md:items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/5 p-4"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    {entry.mainPhoto ? (
                      <img src={entry.mainPhoto} alt={fullName} className="w-14 h-14 rounded-2xl object-cover border border-white/20" />
                    ) : (
                      <div className="w-14 h-14 rounded-2xl border border-white/20 bg-white/10 flex items-center justify-center text-sm text-white/60">
                        нет фото
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-base font-semibold truncate">{fullName}</div>
                      <div className="text-sm text-white/70 truncate">{city}</div>
                      <div className="text-xs text-white/50">Заблокирован {blockedLabel}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`${BUTTON_SECONDARY} self-start md:self-auto px-4 py-2 text-sm font-semibold`}
                    onClick={() => handleUnblock(entry.id)}
                    disabled={busyId === entry.id}
                  >
                    {busyId === entry.id ? "Разблокируем…" : "Разблокировать"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default BlacklistSettingsPage;
