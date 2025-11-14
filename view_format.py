from pathlib import Path
text = Path(r"src/pages/ChartPage.tsx").read_text(encoding="utf-8")
start = text.index("function formatDegree")
end = text.index("function getSignDisplay", start) if "function getSignDisplay" in text[start:] else text.index("export default", start)
print(repr(text[start:end]))
