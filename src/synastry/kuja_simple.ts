// Простой пост-штраф Куджа-доши без спорных факторов
type Mitig = { jupiter?: boolean; venusStrong?: boolean; moonStrong?: boolean };

export function applyKujaPenaltySimple(
  totalBefore: number,
  opts: {
    hasA: boolean;
    hasB: boolean;
    mitigA?: Mitig;
    mitigB?: Mitig;
    baseSingle?: number; // по умолчанию −16
    baseBoth?: number;   // по умолчанию −9
  }
){
  const baseSingle = opts.baseSingle ?? -16;
  const baseBoth   = opts.baseBoth   ?? -9;

  // нет Куджи — нет штрафа
  if (!opts.hasA && !opts.hasB) {
    return { totalAfter: clamp01(totalBefore), penalty: 0, label: "штраф за Куджа-дошу: −0%" };
  }

  // выбираем базу: одиночная или у обоих
  const p = (!opts.hasA || !opts.hasB) ? baseSingle : baseBoth; // p < 0

  // собираем смягчители по обоим (берём среднее влияние)
  const reduce = (m?: Mitig) => {
    let f = 1;
    if (m?.jupiter)     f *= 0.70; // −30%
    if (m?.venusStrong) f *= 0.85; // −15%
    if (m?.moonStrong)  f *= 0.85; // −15%
    return f;
  };
  const fA = reduce(opts.mitigA);
  const fB = reduce(opts.mitigB);
  const f  = (!opts.hasA || !opts.hasB) ? (opts.hasA ? fA : fB) : (fA + fB)/2;

  // не позволяем полностью обнулить штраф (минимум 35% от базы)
  const fClamped = Math.max(f, 0.35);

  const penalty = Math.round(p * fClamped); // всё ещё отрицательное число
  const totalAfter = clamp01(totalBefore + penalty);

  const label = `штраф за Куджа-дошу: ${penalty}%`;
  return { totalAfter, penalty, label };
}

function clamp01(x:number){ return Math.max(0, Math.min(100, Math.round(x))); }
