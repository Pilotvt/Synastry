import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function readText(filePath) {
  return readFileSync(filePath, "utf-8");
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return "";
}

function resolveIsccPath() {
  const envPath = process.env.ISCC_PATH || process.env.ISCC;
  if (envPath && existsSync(envPath)) return envPath;

  const where = spawnSync("where", ["iscc"], { encoding: "utf-8", shell: true });
  if (where.status === 0) {
    const candidate = String(where.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (candidate && existsSync(candidate)) return candidate;
  }

  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    localAppData ? path.join(localAppData, "Programs", "Inno Setup 6", "ISCC.exe") : "",
    "C:\\\\Program Files (x86)\\\\Inno Setup 6\\\\ISCC.exe",
    "C:\\\\Program Files\\\\Inno Setup 6\\\\ISCC.exe",
    "C:\\\\Program Files (x86)\\\\Inno Setup 5\\\\ISCC.exe",
    "C:\\\\Program Files\\\\Inno Setup 5\\\\ISCC.exe",
  ];
  return firstExisting(candidates);
}

function findWinUnpackedDir(outputDir, productName) {
  const direct = path.join(outputDir, "win-unpacked");
  if (existsSync(direct)) return direct;

  // Fallback: scan output dir for a folder that contains <productName>.exe
  const entries = readdirSync(outputDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(outputDir, e.name));

  const exeName = `${productName}.exe`;
  for (const dir of entries) {
    try {
      if (existsSync(path.join(dir, exeName))) return dir;
    } catch {
      // ignore
    }
  }
  return "";
}

function extractOutputBaseFromVersionIss(versionIssPath) {
  try {
    const raw = readText(versionIssPath);
    const match = raw.match(/#define\s+MyAppOutputBase\s+"([^"]+)"/i);
    return match?.[1] ? String(match[1]) : "";
  } catch {
    return "";
  }
}

function safeUnlink(filePath) {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}


function main() {
  const pkg = readJson(path.join(ROOT, "package.json"));
  const version = String(pkg.version || "").trim();
  if (!version) {
    throw new Error("package.json version is empty");
  }

  const build = pkg.build || {};
  const productName = String(build.productName || "Synastry");
  const outputDir = path.join(ROOT, String(build.directories?.output || "release"));
  const fallbackOutDir = path.join(outputDir, "inno");

  if (!existsSync(outputDir) || !statSync(outputDir).isDirectory()) {
    throw new Error(`electron-builder output dir not found: ${outputDir}`);
  }

  const winUnpacked = findWinUnpackedDir(outputDir, productName);
  if (!winUnpacked) {
    throw new Error(
      `Could not find unpacked app directory in ${outputDir}. Expected ${path.join(
        outputDir,
        "win-unpacked"
      )} or a folder containing ${productName}.exe`
    );
  }

  const iscc = resolveIsccPath();
  if (!iscc) {
    throw new Error(
      'Inno Setup compiler (ISCC.exe) not found. Install Inno Setup 6, or set env var ISCC_PATH="C:\\\\Path\\\\to\\\\ISCC.exe".'
    );
  }

  const issPath = path.join(ROOT, "setup.iss");
  if (!existsSync(issPath)) {
    throw new Error(`setup.iss not found: ${issPath}`);
  }

  // Prefer icon2 if present (non-destructive A/B testing for setup icon).
  const icon2 = path.join(ROOT, "build", "icons", "icon2.ico");
  if (existsSync(icon2)) {
    process.env.SYN_SETUP_ICON = icon2;
  }

  const versionIssPath = path.join(ROOT, "build", "version.iss");
  const outputBase = extractOutputBaseFromVersionIss(versionIssPath) || `Synastry-${version}-setup`;
  const expectedExeName = `${outputBase}.exe`;
  const expectedPrimaryPath = path.join(outputDir, expectedExeName);
  const expectedFallbackPath = path.join(fallbackOutDir, expectedExeName);

  const compileTo = (outDir) => {
    const args = [
      "/Qp",
      // Do not add manual quotes here; Node will quote args as needed on Windows.
      // Manual quotes may end up inside the preprocessor value and break paths in setup.iss.
      `/DMyAppSourceDir=${winUnpacked}`,
      `/O${outDir}`,
      issPath,
    ];
    return spawnSync(iscc, args, { stdio: "inherit", windowsHide: false, cwd: ROOT });
  };

  // Prefer building directly into `release/` so there's only one installer.
  safeUnlink(expectedPrimaryPath);
  let res = compileTo(outputDir);

  // If output folder is locked (Explorer/AV), retry into `release/inno/`.
  if (res.status !== 0) {
    mkdirSync(fallbackOutDir, { recursive: true });
    safeUnlink(expectedFallbackPath);
    res = compileTo(fallbackOutDir);
  }

  if (res.status !== 0) {
    process.exit(res.status || 1);
  }

  const installerPath = existsSync(expectedPrimaryPath)
    ? expectedPrimaryPath
    : existsSync(expectedFallbackPath)
      ? expectedFallbackPath
      : "";

  console.log(`[inno] OK: ${productName} ${version}`);
  if (installerPath) {
    console.log(`[inno] installer: ${installerPath}`);
  } else {
    console.log(`[inno] WARNING: installer path not found (check output folders)`);
  }
}

main();
