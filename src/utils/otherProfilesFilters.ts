export const OTHER_PROFILES_FILTERS_KEY = "synastry_other_profiles_filters_v1";

export type GenderFilterValue = "all" | "male" | "female";

export type StoredOtherProfilesFilters = {
  userId: string | null;
  gender: GenderFilterValue;
  ageMin: number | null;
  ageMax: number | null;
  religion: string;
  country: string;
  city: string;
  compatibilityRange: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function parseStoredOtherProfilesFilters(raw: string): StoredOtherProfilesFilters | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;

    const userId = typeof parsed.userId === "string" ? parsed.userId : parsed.userId === null ? null : null;
    const genderRaw = parsed.gender;
    const gender: GenderFilterValue | null =
      genderRaw === "all" || genderRaw === "male" || genderRaw === "female"
        ? genderRaw
        : isRecord(genderRaw) && typeof genderRaw.male === "boolean" && typeof genderRaw.female === "boolean"
          ? genderRaw.male && genderRaw.female
            ? "all"
            : genderRaw.male
              ? "male"
              : genderRaw.female
                ? "female"
                : null
          : null;

    if (!gender) return null;

    return {
      userId,
      gender,
      ageMin: typeof parsed.ageMin === "number" ? parsed.ageMin : null,
      ageMax: typeof parsed.ageMax === "number" ? parsed.ageMax : null,
      religion: typeof parsed.religion === "string" ? parsed.religion : "",
      country: typeof parsed.country === "string" ? parsed.country : "",
      city: typeof parsed.city === "string" ? parsed.city : "",
      compatibilityRange: typeof parsed.compatibilityRange === "string" ? parsed.compatibilityRange : "",
    };
  } catch {
    return null;
  }
}

export function escapeIlike(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

