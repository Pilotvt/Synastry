import texts from "./expr_texts_ru.json";
import { expressionNumberByDate, type DOBInput } from "./date_expr";
import { scoreFromText } from "./scoring";

export type ExprByDateResult = {
  exprA: number; exprB: number;
  pairKey: string;
  text: string;
  score: number;
  tier: string;
};

const expressionTexts: Record<string, string> = texts as Record<string, string>;

export function getExpressionCompatByDate(dobA: DOBInput, dobB: DOBInput): ExprByDateResult {
  const a = expressionNumberByDate(dobA);
  const b = expressionNumberByDate(dobB);
  const key = `${a}+${b}`;
  const mirr = `${Math.min(a,b)}+${Math.max(a,b)}`;
  const text = expressionTexts[key] ?? expressionTexts[mirr] ?? "Нет данных в лекции 140";
  const { score, tier } = scoreFromText(text);
  return { exprA: a, exprB: b, pairKey: expressionTexts[key] ? key : mirr, text, score, tier };
}
