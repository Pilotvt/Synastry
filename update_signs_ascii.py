from pathlib import Path
path = Path(r"src/pages/ChartPage.tsx")
text = path.read_text(encoding="utf-8")
start = text.index("const SIGN_LABELS")
end = text.index("const SIGN_INDEX", start)
new = "const SIGN_LABELS: Record<string, string> = {\n  Ar: \"Овен\",\n  Ta: \"Телец\",\n  Ge: \"Близнецы\",\n  Cn: \"Рак\",\n  Le: \"Лев\",\n  Vi: \"Дева\",\n  Li: \"Весы\",\n  Sc: \"Скорпион\",\n  Sg: \"Стрелец\",\n  Cp: \"Козерог\",\n  Aq: \"Водолей\",\n  Pi: \"Рыбы\",\n};\n\n"
text = text[:start] + new + text[end:]
path.write_text(text, encoding="utf-8")
