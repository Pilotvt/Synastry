import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
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

function main() {
  const pkg = readJson(path.join(ROOT, "package.json"));
  const version = String(pkg.version || "").trim();
  if (!version) {
    throw new Error("package.json version is empty");
  }

  const build = pkg.build || {};
  const productName = String(build.productName || "Synastry");
  const outputDir = path.join(ROOT, String(build.directories?.output || "release"));

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

  const args = [
    "/Qp",
    `/DMyAppSourceDir=${winUnpacked}`,
    `/O${outputDir}`,
    issPath,
  ];

  const res = spawnSync(iscc, args, { stdio: "inherit", windowsHide: false });
  if (res.status !== 0) {
    process.exit(res.status || 1);
  }

  console.log(`[inno] OK: ${productName} ${version}`);
}

main();
