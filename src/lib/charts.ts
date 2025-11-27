import { supabase } from "./supabase";

export type JsonValue = unknown;

export type SavedChart = {
  id: string;
  user_id: string;
  name: string;
  visibility: "private" | "public" | "shared";
  profile: JsonValue;
  chart: JsonValue;
  meta?: JsonValue;
  created_at: string;
  updated_at: string;
};

export async function saveChart(
  userId: string,
  name: string,
  visibility: SavedChart["visibility"],
  profile: JsonValue,
  chart: JsonValue,
  meta?: JsonValue,
) {
  // Check if chart exists for this user
  const { data: existing, error: selectError } = await supabase
    .from("charts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selectError && selectError.code !== "PGRST116") throw selectError;
  if (existing && existing.id) {
    // Update existing chart
    const { data, error } = await supabase
      .from("charts")
      .update({ name, visibility, profile, chart, meta, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw new Error(JSON.stringify(error));
    return data as SavedChart;
  } else {
    // Insert new chart
    const { data, error } = await supabase
      .from("charts")
      .insert([{ user_id: userId, name, visibility, profile, chart, meta }])
      .select("*")
      .single();
    if (error) throw new Error(JSON.stringify(error));
    return data as SavedChart;
  }
}

export async function listUserCharts(userId: string) {
  const { data, error } = await supabase
    .from("charts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as SavedChart[];
}

export async function getChartById(id: string) {
  const { data, error } = await supabase
    .from("charts")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as SavedChart;
}

// Simple helper that finds candidate charts for synastry by date range and visibility
export async function findCandidateChartsForSynastry(userId: string, fromIso?: string, toIso?: string) {
  let query = supabase.from("charts").select("*").or(`visibility.eq.public,visibility.eq.shared`).neq("user_id", userId);
  if (fromIso) query = query.gte("created_at", fromIso);
  if (toIso) query = query.lte("created_at", toIso);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw error;
  return data as SavedChart[];
}
