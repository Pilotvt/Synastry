import React from "react";
import { useBlocklistController } from "../hooks/useBlocklistController";
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from "../constants/buttonPalette";

const BlocklistPopupPage: React.FC = () => {
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

  const closeWindow = () => {
    try {
      window.close();
    } catch {
      // ignore close errors
    }
  };

  if (!userId) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center px-4 text-center">
        <h2 className="text-xl font-semibold mb-2">Авторизуйтесь</h2>
        <p className="text-sm text-white/70">
          Войдите в основной программе, чтобы посмотреть заблокированных пользователей и управлять списком.
        </p>
        <button type="button" className={`${BUTTON_SECONDARY} mt-4 px-4 py-2 text-sm`} onClick={closeWindow}>
          Закрыть окно
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white px-4 py-6">
      <div className="max-w-md mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Чёрный список</h1>
            <p className="text-xs text-white/60 mt-1">Разблокируйте пользователя, чтобы снова получать сообщения.</p>
          </div>
          <button type="button" className={`${BUTTON_SECONDARY} px-2 py-1 text-xs`} onClick={closeWindow}>
            Закрыть
          </button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-white/70">Всего: {entries.length}</span>
          <button
            type="button"
            className={`${BUTTON_SECONDARY} px-3 py-1 text-xs`}
            onClick={handleRefresh}
            disabled={refreshing || loading}
          >
            {refreshing ? "Обновляем…" : "Обновить"}
          </button>
        </div>
        {loading && !initialized ? <div className="text-sm text-white/70">Загружаем список…</div> : null}
        {storeError ? <div className="text-sm text-red-400">{storeError}</div> : null}
        {localError ? <div className="text-sm text-red-400">{localError}</div> : null}
        {entries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/20 bg-white/5 p-4 text-sm text-white/70">
            Пока никто не заблокирован.
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => {
              const name = [entry.lastName, entry.personName].filter(Boolean).join(" ") || "Без имени";
              return (
                <div key={entry.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{name}</div>
                    {entry.cityName ? <div className="text-xs text-white/50 truncate">{entry.cityName}</div> : null}
                  </div>
                  <button
                    type="button"
                    className={`${BUTTON_PRIMARY} px-3 py-1.5 text-xs`}
                    onClick={() => handleUnblock(entry.id)}
                    disabled={busyId === entry.id}
                  >
                    {busyId === entry.id ? "…" : "Разблокировать"}
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

export default BlocklistPopupPage;
