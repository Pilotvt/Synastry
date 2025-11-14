const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function main() {
  const sourcePath = require.resolve("cities.json/cities.json");
  const outputDir = path.resolve(__dirname, "..", "public", "cities-by-country");
  ensureDir(outputDir);

  const raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const byCountry = new Map();

  for (const city of raw) {
    if (!city) continue;
    const countryCode = typeof city.country === "string" && city.country.trim().length > 0
      ? city.country.trim().toUpperCase()
      : null;
    if (!countryCode) continue;

    const name = typeof city.name === "string" ? city.name : null;
    if (!name) continue;

    const lat = typeof city.lat === "number" ? city.lat : parseFloat(String(city.lat ?? ""));
    const lon = typeof city.lng === "number" ? city.lng : parseFloat(String(city.lng ?? city.lon ?? ""));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const geonameid = city.geonameid ?? city.id ?? null;

    const entry = {
      name,
      country: countryCode,
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
    };

    if (geonameid !== null) {
      entry.geonameid = String(geonameid);
    }

    if (!byCountry.has(countryCode)) {
      byCountry.set(countryCode, []);
    }
    byCountry.get(countryCode).push(entry);
  }

  const metadata = [];

  for (const [code, list] of byCountry) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    const filePath = path.join(outputDir, `${code}.json`);
    fs.writeFileSync(filePath, JSON.stringify(list));
    metadata.push({ country: code, count: list.length });
  }

  metadata.sort((a, b) => b.count - a.count);

  const indexPath = path.join(outputDir, "index.json");
  fs.writeFileSync(indexPath, JSON.stringify({ countries: metadata }, null, 2));

  console.log(`Generated ${metadata.length} country files into ${outputDir}`);
}

if (require.main === module) {
  main();
}
