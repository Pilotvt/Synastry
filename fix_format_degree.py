from pathlib import Path
path = Path(r"src/pages/ChartPage.tsx")
text = path.read_text(encoding="utf-8")
old = "function formatDegree(value: number) {\n  const normalized = ((value % 30) + 30) % 30;\n  const deg = Math.floor(normalized);\n  const minutes = Math.round((normalized - deg) * 60);\n  return `${deg}�${minutes.toString().padStart(2, \"0\")}'`;\n}\n\n"
if old not in text:
    raise SystemExit("pattern not found")
new = "function formatDegree(value: number) {\n  const normalized = ((value % 30) + 30) % 30;\n  const deg = Math.floor(normalized);\n  const minutes = Math.round((normalized - deg) * 60);\n  return `${deg}°${minutes.toString().padStart(2, \"0\")}'`;\n}\n\n"
text = text.replace(old, new)
text = text.replace("function getSignDisplay(sign: string) {\n  const label = SIGN_LABELS[sign] ?? sign;\n  const index = SIGN_INDEX[sign];\n  return index ? `${label} (${index})` : label;\n}\n\n", "function getSignDisplay(sign: string) {\n  const label = SIGN_LABELS[sign] ?? sign;\n  const index = SIGN_INDEX[sign];\n  return index ? `${label} (${index})` : label;\n}\n\n")
path.write_text(text, encoding="utf-8")
