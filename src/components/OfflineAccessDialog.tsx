import type { FC } from "react";

import { BUTTON_PRIMARY, BUTTON_SECONDARY } from "../constants/buttonPalette";

type OfflineAccessDialogProps = {
  open: boolean;
  onClose: () => void;
  onRegister: () => void;
};

const OfflineAccessDialog: FC<OfflineAccessDialogProps> = ({ open, onClose, onRegister }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[720px] border border-black paper-texture-solid p-5 text-black">
        <div className="text-xl font-semibold mb-2">Требуется регистрация</div>
        <div className="text-base leading-snug">
          Для продолжения требуется регистрация. В офлайн-режиме доступна только страница {"<"}Модули Джйотиш{">"}.
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" className={`${BUTTON_SECONDARY} px-4 py-2 text-sm`} onClick={onClose}>
            Отмена
          </button>
          <button type="button" className={`${BUTTON_PRIMARY} px-4 py-2 text-sm`} onClick={onRegister}>
            Зарегистрироваться
          </button>
        </div>
      </div>
    </div>
  );
};

export default OfflineAccessDialog;
