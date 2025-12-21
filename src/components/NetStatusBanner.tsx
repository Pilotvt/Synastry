import React from "react";
import { useNetStatus } from "../context/useNetStatus";

const NetStatusBanner: React.FC = () => {
  const { isOnline } = useNetStatus();

  if (isOnline) return null;

  return (
    <div className="fixed left-0 right-0 top-0 z-[2000] flex justify-center">
      <div className="mt-3 max-w-lg rounded-lg border border-gray-400 bg-gray-300 px-4 py-2 text-center text-xs font-semibold text-black shadow-lg">
        Нет подключения к сети. Приложение работает в офлайн-режиме.
      </div>
    </div>
  );
};

export default NetStatusBanner;
