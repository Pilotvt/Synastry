from pathlib import Path
path = Path(r"src/App.tsx")
lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
index = 395
if index < len(lines):
    lines[index] = "    const fallbackMessage = \"Не удалось построить карту.\";\n"
else:
    raise SystemExit("index out of range")
path.write_text("".join(lines), encoding="utf-8")
