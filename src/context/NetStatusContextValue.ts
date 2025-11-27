import { createContext } from "react";

export type NetStatusContextValue = {
  isOnline: boolean;
};

export const NetStatusContext = createContext<NetStatusContextValue>({ isOnline: true });
