from pathlib import Path
text = Path(r"src/pages/ChartPage.tsx").read_text(encoding="utf-8")
start = text.index("function formatDegree")
print(repr(text[start:text.index("export default", start)]))
