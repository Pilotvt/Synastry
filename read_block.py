from pathlib import Path
text = Path(r"src/pages/ChartPage.tsx").read_text(encoding="utf-8")
start = text.index("const SIGN_LABELS")
end = text.index("const SIGN_INDEX", start)
print(text[start:end])
