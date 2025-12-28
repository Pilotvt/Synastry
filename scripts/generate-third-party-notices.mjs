import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(process.cwd());
const OUTPUT_PATH = path.join(ROOT, "THIRD_PARTY_NOTICES.txt");

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function normalizeNewlines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function findLicenseFile(dir) {
  const candidates = [
    "LICENSE",
    "LICENSE.txt",
    "LICENSE.md",
    "LICENCE",
    "LICENCE.txt",
    "COPYING",
    "COPYING.txt",
    "NOTICE",
    "NOTICE.txt",
  ];
  for (const name of candidates) {
    const filePath = path.join(dir, name);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
  }

  // Fallback: any LICENSE* file.
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => /^licen[sc]e/i.test(name) || /^copying/i.test(name) || /^notice/i.test(name))
      .map((name) => path.join(dir, name))
      .filter((p) => fs.statSync(p).isFile())
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return files[0] ?? null;
  } catch {
    return null;
  }
}

function getNpmProductionPackageDirs() {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const out = execFileSync(npmCmd, ["ls", "--omit=dev", "--parseable", "--all"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = normalizeNewlines(out)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("npm "));
  // First line is the project root itself.
  return Array.from(new Set(lines.slice(1)));
}

function buildHeader(pkg) {
  const name = pkg?.build?.productName || pkg?.name || "Synastry";
  const version = pkg?.version || "";
  const nowIso = new Date().toISOString();
  return [
    `${name} — Third-Party Notices`,
    version ? `Version: ${version}` : "",
    `Generated: ${nowIso}`,
    "",
    "This product includes third-party open source software.",
    "License texts are reproduced below where available.",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildNpmSection(packageDirs) {
  const blocks = [];
  const missing = [];

  for (const dir of packageDirs) {
    const pkg = readJsonSafe(path.join(dir, "package.json"));
    if (!pkg?.name || !pkg?.version) continue;

    const licenseField = typeof pkg.license === "string" ? pkg.license : Array.isArray(pkg.licenses) ? "multiple" : "";
    const repo =
      typeof pkg.repository === "string"
        ? pkg.repository
        : typeof pkg.repository?.url === "string"
          ? pkg.repository.url
          : "";
    const homepage = typeof pkg.homepage === "string" ? pkg.homepage : "";

    const licenseFile = findLicenseFile(dir);
    if (!licenseFile) {
      missing.push(`${pkg.name}@${pkg.version} (${licenseField || "unknown"})`);
      continue;
    }

    const text = normalizeNewlines(fs.readFileSync(licenseFile, "utf8"));
    const digest = sha1(text);
    blocks.push({
      key: `${pkg.name}@${pkg.version}`,
      name: pkg.name,
      version: pkg.version,
      license: licenseField,
      licenseFile: path.relative(ROOT, licenseFile),
      repo,
      homepage,
      digest,
      text,
    });
  }

  blocks.sort((a, b) => a.name.localeCompare(b.name));

  const out = [];
  out.push("============================================================");
  out.push("JavaScript / Node.js dependencies (npm, production)");
  out.push("============================================================");
  out.push("");

  for (const b of blocks) {
    out.push("------------------------------------------------------------");
    out.push(`${b.key}`);
    out.push(`License: ${b.license || "unknown"}`);
    out.push(`License file: ${b.licenseFile}`);
    if (b.homepage) out.push(`Homepage: ${b.homepage}`);
    if (b.repo) out.push(`Repository: ${b.repo}`);
    out.push(`Digest: ${b.digest}`);
    out.push("------------------------------------------------------------");
    out.push(b.text.trimEnd());
    out.push("");
  }

  if (missing.length) {
    out.push("------------------------------------------------------------");
    out.push("Packages with no license file found locally:");
    for (const item of missing.sort()) out.push(`- ${item}`);
    out.push("------------------------------------------------------------");
    out.push("");
  }

  return out.join("\n");
}

function buildPythonSection() {
  const requirementsPath = path.join(ROOT, "requirements.txt");
  const pythonEmbedLicensePath = path.join(ROOT, "electron", "resources", "python-embed", "LICENSE.txt");
  const requirements = fs.existsSync(requirementsPath) ? normalizeNewlines(fs.readFileSync(requirementsPath, "utf8")).trim() : "";
  const pythonLicense = fs.existsSync(pythonEmbedLicensePath)
    ? normalizeNewlines(fs.readFileSync(pythonEmbedLicensePath, "utf8")).trim()
    : "";

  const out = [];
  out.push("============================================================");
  out.push("Bundled Python runtime and packages");
  out.push("============================================================");
  out.push("");
  out.push("Bundled requirements (requirements.txt):");
  out.push(requirements ? requirements : "(missing)");
  out.push("");
  if (pythonLicense) {
    out.push("------------------------------------------------------------");
    out.push("Python License (electron/resources/python-embed/LICENSE.txt)");
    out.push("------------------------------------------------------------");
    out.push(pythonLicense);
    out.push("");
  }
  return out.join("\n");
}

function buildDataSection() {
  return [
    "============================================================",
    "Data files",
    "============================================================",
    "",
    "The file data/profanity_ru_ua.txt is a project-maintained profanity dictionary.",
    "",
    "Profanity transliteration/obfuscation extension:",
    "- DeepSafe safetext (MIT License)",
    "  https://github.com/viddexa/safetext",
    "  (used as a filtered additional word source; see the header inside data/profanity_ru_ua.txt)",
    "",
    "------------------------------------------------------------",
    "DeepSafe safetext — MIT License",
    "------------------------------------------------------------",
    "MIT License",
    "",
    "Copyright (c) 2023 DeepSafe",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'of this software and associated documentation files (the "Software"), to deal',
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
    "",
  ].join("\n");
}

function main() {
  const rootPkg = readJsonSafe(path.join(ROOT, "package.json")) ?? {};
  const dirs = getNpmProductionPackageDirs();

  const content = [
    buildHeader(rootPkg),
    buildDataSection(),
    buildNpmSection(dirs),
    buildPythonSection(),
  ].join("\n");

  fs.writeFileSync(OUTPUT_PATH, content.replace(/\n/g, "\r\n"), "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
}

main();
