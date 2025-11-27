from pathlib import Path
text = Path("app/jyotish.py").read_text(encoding="utf-8")
start = text.index('# coarse scan')
end = text.index('# filter roots by azimuth window', start)
print(text[start:end])
