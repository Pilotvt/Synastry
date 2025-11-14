import texts from "./expr_texts_ru.json";
import { expressionNumberByDate } from "./date_expr";
import { scoreFromText } from "./scoring";

export type ExprByDateResult = {
  exprA: number; exprB: number;
  pairKey: string;
  text: string;
  score: number;
  tier: string;
};

export function getExpressionCompatByDate(
  dobA: string | {day:number; month:number; year?:number},
  dobB: string | {day:number; month:number; year?:number}
): ExprByDateResult {
  const a = expressionNumberByDate(dobA as any);
  const b = expressionNumberByDate(dobB as any);
  const key = `${a}+${b}`;
  const mirr = `${Math.min(a,b)}+${Math.max(a,b)}`;
  const text = (texts as any)[key] ?? (texts as any)[mirr] ?? "Нет данных в лекции 140";
  const { score, tier } = scoreFromText(text);
  return { exprA: a, exprB: b, pairKey: (texts as any)[key] ? key : mirr, text, score, tier };
}
