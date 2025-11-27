// Numerology: Expression number by date (lecture 140)

export type NumerologyDigit = 1|2|3|4|5|6|7|8|9;
export type DOBInput = string | { day:number; month:number; year?:number };

export function reduce19(n: number): NumerologyDigit {
  let x = Math.abs(n);
  while (x > 9) x = String(x).split("").reduce((s,d)=>s+Number(d),0);
  // In classic reduce19, 0 maps to 9; but per spec here, map 0->1 to avoid zero.
  const normalized = x === 0 ? 1 : x;
  if (normalized < 1 || normalized > 9) {
    throw new Error(`reduce19 produced invalid digit ${normalized}`);
  }
  return normalized as NumerologyDigit;
}

// Parse DOB supporting numeric (DD.MM.YYYY, D/M/YYYY, etc.), ISO (YYYY-MM-DD[T...]), and object {day,month}
export function parseDOB(input: DOBInput): {day:number; month:number} {
  if (typeof input === "string") {
    const s = input.trim();
    // ISO first
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return { day: Number(iso[3]), month: Number(iso[2]) };
    // Numeric with separators
    const m = s.match(/^(\d{1,2})[.\-/\s](\d{1,2})[.\-/\s](\d{2,4})$/);
    if (m) return { day: Number(m[1]), month: Number(m[2]) };
    throw new Error(`Bad DOB format: ${input}`);
  }
  return { day: input.day, month: input.month };
}

export function soulNumber(dob: DOBInput): NumerologyDigit {
  const { day } = parseDOB(dob);
  return reduce19(day);
}

export function month19(dob: DOBInput): NumerologyDigit {
  const { month } = parseDOB(dob);
  if (month < 1 || month > 12) throw new Error(`Bad month: ${month}`);
  return reduce19(month);
}

export function expressionNumberByDate(dob: DOBInput): NumerologyDigit {
  const sn = soulNumber(dob);
  const mm = month19(dob);
  return reduce19(sn + mm);
}
