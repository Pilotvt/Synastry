import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import https from "node:https";

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

function downloadFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    try {
      const req = https.request(
        url,
        {
          method: "GET",
          headers: {
            "User-Agent": "Synastry build script",
          },
        },
        (res) => {
          const status = Number(res.statusCode || 0);
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              reject(new Error(`Too many redirects while downloading ${url}`));
              return;
            }
            resolve(downloadFile(res.headers.location, destPath, redirectsLeft - 1));
            return;
          }

          if (status < 200 || status >= 300) {
            const chunks = [];
            res.on("data", (d) => chunks.push(d));
            res.on("end", () => {
              reject(
                new Error(
                  `Failed to download ${url}: HTTP ${status} ${(Buffer.concat(chunks).toString("utf-8") || "").slice(0, 200)}`
                )
              );
            });
            return;
          }

          const file = createWriteStream(destPath);
          res.pipe(file);
          file.on("finish", () => {
            try {
              file.close(() => resolve());
            } catch {
              resolve();
            }
          });
          file.on("error", (err) => reject(err));
        }
      );
      req.on("error", (err) => reject(err));
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function ensureBundledVcRedist() {
  const vcUrl = process.env.SYN_VC_REDIST_URL || "https://aka.ms/vc14/vc_redist.x64.exe";
  const redistDir = path.join(ROOT, "build", "redist");
  const destPath = process.env.SYN_VC_REDIST_PATH || path.join(redistDir, "vc_redist.x64.exe");

  mkdirSync(redistDir, { recursive: true });

  if (existsSync(destPath) && statSync(destPath).isFile() && statSync(destPath).size > 1024 * 1024) {
    return destPath;
  }

  console.log(`[inno] downloading VC++ Runtime: ${vcUrl}`);
  safeUnlink(destPath);
  await downloadFile(vcUrl, destPath);

  if (!existsSync(destPath) || statSync(destPath).size <= 1024 * 1024) {
    throw new Error(
      `[inno] failed to download VC++ Runtime to ${destPath} (file missing or too small). ` +
        `You can set SYN_VC_REDIST_PATH to an existing vc_redist.x64.exe.`
    );
  }
  console.log(`[inno] bundled VC++ Runtime: ${destPath}`);
  return destPath;
}

async function main() {
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

  await ensureBundledVcRedist();

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
