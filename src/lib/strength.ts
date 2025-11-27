// Planet strength calculation utilities for Venus and Moon (and generally any planet)
// All inputs are precomputed by the chart builder: we do NOT recompute markers or house groups here.

export type SignFriendLevel = "friend" | "neutral" | "enemy";
export type FuncRole = "++" | "+" | "0" | "-" | "--";

export interface Inputs {
  basePercent: number;           // 0..100, positional strength (bell curve)
  // statuses (precomputed flags from chart layer)
  isExalt: boolean;              // ↑
  isDebil: boolean;              // ↓
  isMoola: boolean;              // Moolatrikona
  isOwn: boolean;                // ⌂
  signFriendLevel: SignFriendLevel;
  isTrikona: boolean;            // 1/5/9
  isKendra: boolean;             // 1/4/7/10
  isUpachaya: boolean;           // 3/6/10/11
  isDusthana8or12: boolean;      // only 8 or 12 apply penalty (6th is not penalized)
  hasDigbala: boolean;           // □ (as provided by chart)
  funcRole: FuncRole;            // ++, +, 0, -, --
  // interactions:
  aspectBonusSum: number;        // total: +2..+6 for benefic precise, -2..-6 for malefic
  conjunctionBonusSum: number;   // total: +2..+6 / -2..-6
  isSuperStrong: boolean;        // ☼ (<1° to Sun)
  isCombust: boolean;            // ● (ignored if ☼)
  lostGrahaYuddha: boolean;      // Ø
  borderPenalty?: number;        // optional -2..-6
}

export function dignityMul(x: Inputs): number {
  if (x.isExalt) return 1.25;
  if (x.isMoola) return 1.15;
  if (x.isOwn)   return 1.10;
  if (x.signFriendLevel === "friend")  return 1.05;
  if (x.signFriendLevel === "enemy")   return 0.90;
  if (x.isDebil) return 0.75;
  return 1.00;
}

export function houseMul(x: Inputs): number {
  let m = 1.00;
  // Take the maximum boost only, do not multiply multiple boosts
  if (x.isTrikona)  m = Math.max(m, 1.10);
  if (x.isKendra)   m = Math.max(m, 1.06);
  if (x.isUpachaya) m = Math.max(m, 1.04);
  // Apply dusthana 8/12 penalty as a cap (min)
  if (x.isDusthana8or12) m = Math.min(m, 0.92);
  return m;
}

export function funcAdd(role: FuncRole): number {
  const map: Record<FuncRole, number> = { "++": 8, "+": 4, "0": 0, "-": -4, "--": -8 };
  return map[role] ?? 0;
}

export function finalStrength(x: Inputs): number {
  // Multipliers
  const M_dignity = dignityMul(x);
  const M_house   = houseMul(x);
  const M_digbala = x.hasDigbala ? 1.10 : 1.00;

  // Additives
  const A_func   = funcAdd(x.funcRole);
  const A_sun    = x.isSuperStrong ? +8 : (x.isCombust ? -8 : 0); // super-strong overrides combustion
  const A_yuddha = x.lostGrahaYuddha ? -8 : 0;
  const A_misc   = (x.aspectBonusSum || 0) + (x.conjunctionBonusSum || 0) + (x.borderPenalty || 0);

  let s = (x.basePercent || 0) * M_dignity * M_house * M_digbala;
  s += A_func + A_sun + A_yuddha + A_misc;

  // Clamp 0..100 and round
  if (!Number.isFinite(s)) s = 0;
  return Math.max(0, Math.min(100, Math.round(s)));
}
