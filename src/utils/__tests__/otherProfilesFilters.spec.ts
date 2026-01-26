import { describe, expect, it } from "vitest";
import { escapeIlike, parseStoredOtherProfilesFilters } from "../otherProfilesFilters";

describe("parseStoredOtherProfilesFilters", () => {
  it("parses v1 payload", () => {
    const raw = JSON.stringify({
      userId: "u1",
      gender: "male",
      ageMin: 25,
      ageMax: 35,
      religion: "Христианство",
      country: "RU",
      city: "Омск",
      compatibilityRange: "70-80",
    });
    expect(parseStoredOtherProfilesFilters(raw)).toEqual({
      userId: "u1",
      gender: "male",
      ageMin: 25,
      ageMax: 35,
      religion: "Христианство",
      country: "RU",
      city: "Омск",
      compatibilityRange: "70-80",
    });
  });

  it("supports legacy gender shape", () => {
    const raw = JSON.stringify({
      userId: null,
      gender: { male: true, female: false },
      ageMin: null,
      ageMax: null,
      religion: "",
      country: "",
      city: "",
      compatibilityRange: "",
    });
    expect(parseStoredOtherProfilesFilters(raw)?.gender).toBe("male");
  });
});

describe("escapeIlike", () => {
  it("escapes % and _", () => {
    expect(escapeIlike("a%b_c")).toBe("a\\%b\\_c");
  });
});

