const { contextBridge } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const readJsonSafe = (filePath) => {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readTextSafe = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
};

const resolveAppMeta = () => {
  const pkgPath = path.join(__dirname, "../package.json");
  const pkg = readJsonSafe(pkgPath);
  const version = typeof pkg?.version === "string" ? pkg.version : "";
  const name =
    typeof pkg?.build?.productName === "string"
      ? pkg.build.productName
      : typeof pkg?.name === "string"
        ? pkg.name
        : "Synastry";
  return { appName: name || "Synastry", version: version || "" };
};

const resolveNoticesPath = () => {
  // In production, the file is copied to process.resourcesPath via electron-builder extraResources.
  const resourcesPath = process.resourcesPath || "";
  const prod = resourcesPath ? path.join(resourcesPath, "THIRD_PARTY_NOTICES.txt") : "";
  if (prod && fs.existsSync(prod)) return prod;

  // Some installers may place the file next to the executable.
  const exeDir = process.execPath ? path.dirname(process.execPath) : "";
  const besideExe = exeDir ? path.join(exeDir, "THIRD_PARTY_NOTICES.txt") : "";
  if (besideExe && fs.existsSync(besideExe)) return besideExe;

  // Dev fallback: repo root file.
  const dev = path.join(__dirname, "../THIRD_PARTY_NOTICES.txt");
  if (fs.existsSync(dev)) return dev;

  // Last resort: current working directory (useful for custom packagers).
  const cwd = process.cwd ? process.cwd() : "";
  const fromCwd = cwd ? path.join(cwd, "THIRD_PARTY_NOTICES.txt") : "";
  if (fromCwd && fs.existsSync(fromCwd)) return fromCwd;
  return prod || dev;
};

contextBridge.exposeInMainWorld("licensesAPI", {
  getNotices: async () => {
    const meta = resolveAppMeta();
    const filePath = resolveNoticesPath();
    const text = readTextSafe(filePath);
    return {
      ...meta,
      filePath,
      text,
    };
  },
});
