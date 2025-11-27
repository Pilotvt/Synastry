import { useContext } from "react";
import { NetStatusContext, type NetStatusContextValue } from "./NetStatusContextValue";

export function useNetStatus(): NetStatusContextValue {
  return useContext(NetStatusContext);
}
