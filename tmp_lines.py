with open(r"src/App.tsx", encoding="utf-8") as fh:
    lines = fh.readlines()
for idx in range(392, 404):
    print(f"{idx+1:4}: {lines[idx].rstrip()}" )
