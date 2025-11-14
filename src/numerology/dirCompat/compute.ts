import { soulNumber, destinyNumber } from "./baseNumbers";
import { signOf, valOf, Sign } from "./table";

export type DirectionReport = {
  from: { soul: number; dest: number };   // ЧД/ЧС от «from»
  to:   { soul: number; dest: number };   // ЧД/ЧС у «to»
  arrows: { s2s: Sign; s2d: Sign; d2s: Sign; d2d: Sign };
  dirSum: number;          // [-8..+8]
  dirPercent: number;      // 0..100 (0 баллов = 50%)
};

export type PairReport = {
  AtoB: DirectionReport;
  BtoA: DirectionReport;
};

export function computeDirection(dobFrom: string, dobTo: string): DirectionReport {
  const sFrom = soulNumber(dobFrom);
  const dFrom = destinyNumber(dobFrom);
  const sTo   = soulNumber(dobTo);
  const dTo   = destinyNumber(dobTo);

  const s2s: Sign = signOf(sFrom, sTo);
  const s2d: Sign = signOf(sFrom, dTo);
  const d2s: Sign = signOf(dFrom, sTo);
  const d2d: Sign = signOf(dFrom, dTo);

  const dirSum = valOf(s2s) + valOf(s2d) + valOf(d2s) + valOf(d2d); // [-8..+8]
  const dirPercent = ((dirSum + 8) / 16) * 100;

  return {
    from: { soul: sFrom, dest: dFrom },
    to:   { soul: sTo,   dest: dTo   },
    arrows: { s2s, s2d, d2s, d2d },
    dirSum,
    dirPercent: Math.round(dirPercent * 1000) / 1000
  };
}

export function computePair(dobA: string, dobB: string): PairReport {
  return {
    AtoB: computeDirection(dobA, dobB),
    BtoA: computeDirection(dobB, dobA),
  };
}
