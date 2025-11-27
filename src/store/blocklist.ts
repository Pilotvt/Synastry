import { create } from "zustand";

export type BlockedProfileSummary = {
  id: string;
  personName: string;
  lastName: string;
  cityName: string;
  mainPhoto: string | null;
  blockedAt: string;
};

type BlocklistState = {
  entries: Record<string, BlockedProfileSummary>;
  initialized: boolean;
  loading: boolean;
  error: string | null;
  lastLoadedAt: number | null;
  setEntries: (list: BlockedProfileSummary[]) => void;
  addEntry: (entry: BlockedProfileSummary) => void;
  removeEntry: (userId: string) => void;
  setLoading: (flag: boolean) => void;
  setError: (message: string | null) => void;
  reset: () => void;
};

export const useBlocklistStore = create<BlocklistState>((set) => ({
  entries: {},
  initialized: false,
  loading: false,
  error: null,
  lastLoadedAt: null,
  setEntries: (list) => {
    const nextEntries = list.reduce<Record<string, BlockedProfileSummary>>((acc, entry) => {
      acc[entry.id] = entry;
      return acc;
    }, {});
    set({ entries: nextEntries, initialized: true, loading: false, error: null, lastLoadedAt: Date.now() });
  },
  addEntry: (entry) => {
    set((state) => ({
      entries: { ...state.entries, [entry.id]: entry },
      initialized: true,
    }));
  },
  removeEntry: (userId) => {
    set((state) => {
      if (!state.entries[userId]) {
        return state;
      }
      const next = { ...state.entries };
      delete next[userId];
      return { entries: next };
    });
  },
  setLoading: (flag) => set({ loading: flag }),
  setError: (message) => set({ error: message }),
  reset: () => set({ entries: {}, initialized: false, loading: false, error: null, lastLoadedAt: null }),
}));
