/// <reference types="vitest/globals" />
import { computePair, computeDirection } from "../compute";
import { soulNumber, destinyNumber } from "../baseNumbers";

// Анна 25.02.1992 ; Михаил 19.01.1985
test("Анна↔Михаил (ЧД/ЧС) направленно", ()=>{
  const A = "25.02.1992";
  const B = "19.01.1985";
  // контроль базовых чисел из ТЗ
  expect(soulNumber(A)).toBe(7);
  expect(destinyNumber(A)).toBe(3);
  expect(soulNumber(B)).toBe(1);
  expect(destinyNumber(B)).toBe(7);

  const r = computePair(A,B);

  // Анна→Михаил: 7→1(+), 7→7(0), 3→1(+), 3→7(0) => sum=4 => 75%
  expect(r.AtoB.dirSum).toBe(4);
  expect(r.AtoB.dirPercent).toBeCloseTo(75, 6);

  // Михаил→Анна: 1→7(0), 1→3(+), 7→7(0), 7→3(*) => sum=3 => 68.75%
  expect(r.BtoA.dirSum).toBe(3);
  expect(r.BtoA.dirPercent).toBeCloseTo(68.75, 6);
});

// Виталий 21.02.1987 ; Лейла 07.03.1986
test("Виталий↔Лейла (ЧД/ЧС) направленно", ()=>{
  const V = "21.02.1987";
  const L = "07.03.1986";

  expect(soulNumber(V)).toBe(3);
  expect(destinyNumber(V)).toBe(3);
  expect(soulNumber(L)).toBe(7);
  expect(destinyNumber(L)).toBe(7);

  const v2l = computeDirection(V,L);
  const l2v = computeDirection(L,V);

  // Виталий→Лейла: 3→7 четыре раза = 0 => sum=0 => 50%
  expect(v2l.dirSum).toBe(0);
  expect(v2l.dirPercent).toBeCloseTo(50, 6);

  // Лейла→Виталий: 7→3 четыре раза = "*" => sum=4 => 75%
  expect(l2v.dirSum).toBe(4);
  expect(l2v.dirPercent).toBeCloseTo(75, 6);
});
