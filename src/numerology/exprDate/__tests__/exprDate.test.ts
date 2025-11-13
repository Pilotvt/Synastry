/// <reference types="vitest/globals" />
import { expressionNumberByDate } from "../date_expr";
import { getExpressionCompatByDate } from "../getExpressionByDate";

test("ЧЭ по дате: 21.02.1987 → 5 (3 + 2 → 5)", ()=>{
  expect(expressionNumberByDate("21.02.1987")).toBe(5);
});

test("ЧЭ по дате: 07.12.1986 → ЧД=7, месяц 12→3, 7+3=10 → reduce 1", ()=>{
  expect(expressionNumberByDate("07.12.1986")).toBe(1);
});

test("Трактовка пары 1+9 должна содержать 'идеал'", ()=>{
  // 07.12.1986 → ЧЭ=1 (7 + 12→3 => 10 → 1)
  // 24.12.1980 → ЧЭ=9 (6 + 3 => 9)
  const r = getExpressionCompatByDate("07.12.1986","24.12.1980");
  expect(r.pairKey === "1+9" || r.pairKey === "9+1").toBe(true);
  expect(r.text.toLowerCase()).toMatch(/идеал/);
  expect(r.score).toBeGreaterThanOrEqual(86);
});
