from pathlib import Path
path = Path(r"src/pages/ChartPage.tsx")
text = path.read_text(encoding="utf-8")
old = "const SIGN_LABELS: Record<string, string> = {\n  Ar: \"����\",\n  Ta: \"�����\",\n  Ge: \"��������\",\n  Cn: \"���\",\n  Le: \"���\",\n  Vi: \"����\",\n  Li: \"����\",\n  Sc: \"���௨��\",\n  Sg: \"��५��\",\n  Cp: \"����ண\",\n  Aq: \"�������\",\n  Pi: \"���\",\n};\n\nfunction formatDegree(value: number) {\n  const normalized = ((value % 30) + 30) % 30;\n  const deg = Math.floor(normalized);\n  const minutes = Math.round((normalized - deg) * 60);\n  return `${deg}�${minutes.toString().padStart(2, \"0\")}'`;\n}\n"
if old not in text:
    raise SystemExit('old block not found')
new = "const SIGN_ORDER = [\"Ar\", \"Ta\", \"Ge\", \"Cn\", \"Le\", \"Vi\", \"Li\", \"Sc\", \"Sg\", \"Cp\", \"Aq\", \"Pi\"] as const;\n\nconst SIGN_LABELS: Record<string, string> = {\n  Ar: \"Овен\",\n  Ta: \"Телец\",\n  Ge: \"Близнецы\",\n  Cn: \"Рак\",\n  Le: \"Лев\",\n  Vi: \"Дева\",\n  Li: \"Весы\",\n  Sc: \"Скорпион\",\n  Sg: \"Стрелец\",\n  Cp: \"Козерог\",\n  Aq: \"Водолей\",\n  Pi: \"Рыбы\",\n};\n\nconst SIGN_INDEX: Record<string, number> = SIGN_ORDER.reduce((acc, sign, idx) => {\n  acc[sign] = idx + 1;\n  return acc;\n}, {} as Record<string, number>);\n\nfunction formatDegree(value: number) {\n  const normalized = ((value % 30) + 30) % 30;\n  const deg = Math.floor(normalized);\n  const minutes = Math.round((normalized - deg) * 60);\n  return `${deg}°${minutes.toString().padStart(2, \"0\")}'`;\n}\n\nfunction getSignDisplay(sign: string) {\n  const name = SIGN_LABELS[sign] ?? sign;\n  const index = SIGN_INDEX[sign];\n  return index ? `${name} (${index})` : name;\n}\n"
text = text.replace(old, new)
path.write_text(text, encoding="utf-8")
