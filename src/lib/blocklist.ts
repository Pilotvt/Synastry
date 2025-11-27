import { supabase } from "./supabase";
import { BlockedProfileSummary, useBlocklistStore } from "../store/blocklist";

const BLOCKS_TABLE = "profile_blocks";

type ProfileRow = {
  id: string;
  data?: Record<string, unknown> | null;
};

type BlockRow = {
  blocked_id: string;
  blocked_at?: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeString = (value: unknown): string => (typeof value === "string" ? value : "");

function snapshotToSummary(
  profileId: string,
  blockedAtIso: string,
  snapshot: Record<string, unknown> | null,
  hint?: Partial<BlockedProfileSummary>,
): BlockedProfileSummary {
  const personName = safeString(snapshot?.personName) || hint?.personName || "";
  const lastName = safeString(snapshot?.lastName) || hint?.lastName || "";
  const mainPhoto = safeString(snapshot?.mainPhoto) || hint?.mainPhoto || null;
  const cityNameRu = safeString(snapshot?.cityNameRu);
  const selectedCity = safeString(snapshot?.selectedCity);
  const residenceCity = safeString(snapshot?.residenceCityName) || safeString(snapshot?.residenceCity);
  const fallbackCity = hint?.cityName ?? "";
  const cityName = cityNameRu || residenceCity || selectedCity || fallbackCity;
  return {
    id: profileId,
    personName,
    lastName,
    cityName,
    mainPhoto,
    blockedAt: blockedAtIso,
  };
}

function normalizeBlockedEntry(
  row: BlockRow,
  profileRow: ProfileRow | null,
  hint?: Partial<BlockedProfileSummary>,
): BlockedProfileSummary {
  const profileId = safeString(row.blocked_id);
  const blockedAt = typeof row.blocked_at === "string" ? row.blocked_at : new Date().toISOString();
  const snapshot = profileRow && isRecord(profileRow.data) ? (profileRow.data as Record<string, unknown>) : null;
  return snapshotToSummary(profileId, blockedAt, snapshot, hint);
}

async function fetchProfileRow(userId: string): Promise<ProfileRow | null> {
  try {
    const { data, error } = await supabase.from("profiles").select("id,data").eq("id", userId).maybeSingle();
    if (error && error.code !== "PGRST116") throw error;
    if (data && typeof data.id === "string") {
      return { id: data.id, data: isRecord(data.data) ? (data.data as Record<string, unknown>) : null };
    }
    return null;
  } catch (error) {
    console.warn("Не удалось получить профиль для чёрного списка", error);
    return null;
  }
}

export async function fetchBlockedProfiles(blockerId: string): Promise<BlockedProfileSummary[]> {
  const { data, error } = await supabase
    .from(BLOCKS_TABLE)
    .select("blocked_id,blocked_at")
    .eq("blocker_id", blockerId)
    .order("blocked_at", { ascending: false });
  if (error) throw error;
  const rows = Array.isArray(data) ? (data as BlockRow[]) : [];
  if (rows.length === 0) {
    return [];
  }
  const ids = rows
    .map((row) => (typeof row.blocked_id === "string" ? row.blocked_id : null))
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return [];
  const { data: profilesData, error: profilesError } = await supabase
    .from("profiles")
    .select("id,data")
    .in("id", ids);
  if (profilesError && profilesError.code !== "PGRST116") {
    throw profilesError;
  }
  const profileMap = new Map<string, ProfileRow>();
  if (Array.isArray(profilesData)) {
    for (const row of profilesData) {
      if (row && typeof row.id === "string") {
        profileMap.set(row.id, { id: row.id, data: isRecord(row.data) ? (row.data as Record<string, unknown>) : null });
      }
    }
  }
  return rows
    .map((row) => {
      if (typeof row.blocked_id !== "string") return null;
      const profileRow = profileMap.get(row.blocked_id) ?? null;
      return normalizeBlockedEntry(row, profileRow);
    })
    .filter((entry): entry is BlockedProfileSummary => Boolean(entry));
}

export async function blockUser(
  blockerId: string,
  targetId: string,
  hint?: Partial<BlockedProfileSummary>,
): Promise<BlockedProfileSummary> {
  const { data, error } = await supabase
    .from(BLOCKS_TABLE)
    .upsert({ blocker_id: blockerId, blocked_id: targetId }, { onConflict: "blocker_id,blocked_id" })
    .select("blocked_id,blocked_at")
    .single();
  if (error) throw error;
  const profileRow = hint?.personName || hint?.lastName || hint?.cityName || hint?.mainPhoto ? null : await fetchProfileRow(targetId);
  return normalizeBlockedEntry((data as BlockRow) ?? { blocked_id: targetId }, profileRow, hint);
}

export async function unblockUser(blockerId: string, targetId: string): Promise<boolean> {
  const { error } = await supabase
    .from(BLOCKS_TABLE)
    .delete()
    .eq("blocker_id", blockerId)
    .eq("blocked_id", targetId);
  if (error) throw error;
  return true;
}

export async function refreshBlocklistForUser(userId: string): Promise<void> {
  const entries = await fetchBlockedProfiles(userId);
  useBlocklistStore.getState().setEntries(entries);
}
