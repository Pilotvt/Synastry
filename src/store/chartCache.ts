import { create } from "zustand";

export type CachedProfilePayload = Record<string, unknown> | null;
export type CachedChartPayload = Record<string, unknown> | null;
export type CachedMetaPayload = Record<string, unknown> | null;

interface ChartCacheState {
  ownerId: string | null;
  profile: CachedProfilePayload;
  chart: CachedChartPayload;
  meta: CachedMetaPayload;
  cachedAt: number;
  setCache: (params: {
    ownerId: string | null;
    profile: CachedProfilePayload;
    chart: CachedChartPayload;
    meta: CachedMetaPayload;
  }) => void;
  clear: () => void;
}

const initialState: Omit<ChartCacheState, "setCache" | "clear"> = {
  ownerId: null,
  profile: null,
  chart: null,
  meta: null,
  cachedAt: 0,
};

export const useChartCache = create<ChartCacheState>((set) => ({
  ...initialState,
  setCache: ({ ownerId, profile, chart, meta }) => {
    set({
      ownerId: ownerId ?? null,
      profile: profile ?? null,
      chart: chart ?? null,
      meta: meta ?? null,
      cachedAt: Date.now(),
    });
  },
  clear: () => set({ ...initialState }),
}));
