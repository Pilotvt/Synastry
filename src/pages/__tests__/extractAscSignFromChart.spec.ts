import { describe, expect, it } from "vitest";
import { extractAscSignFromChart } from "../../lib/extractAscSignFromChart";

describe("extractAscSignFromChart", () => {
  it("returns Russian label from ascendant block when available", () => {
    const chart = { ascendant: { sign: "Li" } };
    expect(extractAscSignFromChart(chart)).toBe("Весы");
  });

  it("falls back to houses array when ascendant is missing", () => {
    const chart = {
      houses: [
        { house: 2, sign: "Ge" },
        { house: 1, sign: "Ta" },
      ],
    };
    expect(extractAscSignFromChart(chart)).toBe("Телец");
  });

  it("falls back to north indian layout boxes", () => {
    const chart = {
      north_indian_layout: {
        boxes: [
          { house: 12, sign: "Sc" },
          { house: 1, sign: "Sg" },
        ],
      },
    };
    expect(extractAscSignFromChart(chart)).toBe("Стрелец");
  });

  it("returns null when no ascendant data exists", () => {
    expect(extractAscSignFromChart({})).toBeNull();
  });
});
