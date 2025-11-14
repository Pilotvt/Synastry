// Сведение к 1..9 по модулю 9, 0 -> 9
export function reduce19(n: number): 1|2|3|4|5|6|7|8|9 {
  let x = n;
  while (x > 9) x = [...String(x)].reduce((s,d)=>s+Number(d),0);
  return (x === 0 ? 9 : x) as 1|2|3|4|5|6|7|8|9;
}
