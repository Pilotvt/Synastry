import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const TARGET_PATH = path.join(ROOT, "data", "profanity_ru_ua.txt");
const SAFETEXT_URL =
  "https://raw.githubusercontent.com/viddexa/safetext/main/safetext/languages/ru/words.txt";

function normalizeNewlines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeKey(word) {
  return String(word ?? "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
}

// Strict allow-list: only words that clearly contain core obscene roots (ru + translit/leet).
const ALLOW_ROOTS = [
  // Cyrillic roots (мат)
  /бля/i,
  /бляд/i,
  /пизд/i,
  /хуй/i,
  /хуе/i,
  /хуё/i,
  /еб/i,
  /ёб/i,
  /пидор/i,
  /пидарас/i,
  /пидорас/i,
  /сука/i,
  /муд/i,
  /манд/i,
  /гонд/i,
  /шлюх/i,
  /дроч/i,
  /уеб/i,
  /уёб/i,
  /долбо/i,
  // Latin/translit/leet roots
  /\b(?:blya|blyad|blyat|6lya|6lyad|6lyat)\b/i,
  /(?:pizd|p1zd|p!zd|pzd)/i,
  /(?:huy|xuy|hui|xui|hu[iy]j|xy[iy]|\bhui\b)/i,
  /(?:yeb|jeb|ebat|eban|yoban|joban|yo?b)/i,
  /(?:pidor|pidr|pidar|pida?ras)/i,
  /(?:suka|cyka|su4k)/i,
  /(?:mudak|mudil|gondon|shlyu|shlu|droch|ueban|u?yob)/i,
];

// Extra safety: exclude known non-obscene medical/neutral terms that might still match loose patterns.
const BLOCK_EXACT = new Set(
  [
    "вагина",
    "влагалище",
    "аборт",
    "буфер",
    "бомж",
    "болван",
  ].map((w) => normalizeKey(w)),
);

function isAllowedWord(word) {
  const original = String(word ?? "").trim();
  if (!original) return false;
  if (original.startsWith("#")) return false;
  const key = normalizeKey(original);
  if (!key) return false;
  if (BLOCK_EXACT.has(key)) return false;
  // Avoid adding very short fragments.
  if (key.length < 3) return false;
  return ALLOW_ROOTS.some((re) => re.test(original));
}

async function main() {
  if (!fs.existsSync(TARGET_PATH)) {
    throw new Error(`Missing target dictionary: ${TARGET_PATH}`);
  }

  const baseRaw = normalizeNewlines(fs.readFileSync(TARGET_PATH, "utf8"));
  const baseLines = baseRaw.split("\n");
  const existing = new Set(
    baseLines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => normalizeKey(l)),
  );

  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this Node runtime");
  }

  const res = await fetch(SAFETEXT_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} when downloading ${SAFETEXT_URL}`);
  const text = await res.text();
  const remoteLines = normalizeNewlines(text).split("\n").map((l) => l.trim());

  const toAppend = [];
  for (const word of remoteLines) {
    if (!isAllowedWord(word)) continue;
    const key = normalizeKey(word);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    toAppend.push(word);
  }

  toAppend.sort((a, b) => a.localeCompare(b, "ru"));

  const out = [];
  out.push(baseRaw.trimEnd());
  out.push("");
  out.push("# Extended transliteration/obfuscation list (filtered from DeepSafe safetext, MIT)");
  out.push(`# Source: ${SAFETEXT_URL}`);
  out.push("# License: https://raw.githubusercontent.com/viddexa/safetext/main/LICENSE");
  out.push("# NOTE: filtered to include only obvious obscene roots (to reduce false positives).");
  out.push("");
  out.push(...toAppend);
  out.push("");

  fs.writeFileSync(TARGET_PATH, out.join("\r\n"), "utf8");
  // eslint-disable-next-line no-console
  console.log(`Merged ${toAppend.length} words into ${path.relative(ROOT, TARGET_PATH)}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to merge safetext profanity list:", err);
  process.exitCode = 1;
});

