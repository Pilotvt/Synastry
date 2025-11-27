import React from "react";
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from "../constants/buttonPalette";

type NewChartConfirmDialogProps = {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

const overlayClass = "fixed inset-0 z-[2000] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4";
const dialogClass =
  "w-full max-w-lg rounded-2xl border border-black/10 bg-[#fdf9f2] p-6 text-black shadow-[0_25px_80px_rgba(0,0,0,0.65)]";

const NewChartConfirmDialog: React.FC<NewChartConfirmDialogProps> = ({ open, busy = false, onCancel, onConfirm }) => {
  if (!open) return null;

  return (
    <div className={overlayClass} role="dialog" aria-modal="true" aria-labelledby="new-chart-confirm-title">
      <div className={dialogClass}>
        <h3 id="new-chart-confirm-title" className="text-xl font-semibold mb-3">
          Построить новую карту?
        </h3>
        <p className="text-sm text-black/70 leading-relaxed">
          Это действие полностью удалит текущую натальную карту и анкету. Перед продолжением вы можете сохранить данные
          в файл.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" className={`${BUTTON_SECONDARY} px-4 py-2 text-sm`} onClick={onCancel} disabled={busy}>
            Отмена
          </button>
          <button type="button" className={`${BUTTON_PRIMARY} px-4 py-2 text-sm`} onClick={onConfirm} disabled={busy}>
            {busy ? "Удаляем…" : "Удалить"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewChartConfirmDialog;
