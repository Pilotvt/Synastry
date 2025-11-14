from pathlib import Path
path = Path(r"src/App.tsx")
lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
updates = {
    395: "    const fallbackMessage = \"Не удалось построить карту.\";\n",
    406: "      setBuildError(message || fallbackMessage);\n"
}
for idx, value in updates.items():
    if idx < len(lines):
        lines[idx] = value
    else:
        raise SystemExit(f"Index {idx} out of range")
path.write_text("".join(lines), encoding="utf-8")
