// Packages addon/ into dist/reading-partner-<version>.xpi and records the
// version in update.json, which installed copies poll (via manifest.json's
// update_url) to find new releases.
// An .xpi is just a zip file — Zotero's "Install Plugin From File" picker
// accepts it directly.

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(process.cwd());
const ADDON = resolve(ROOT, "addon");
const DIST = resolve(ROOT, "dist");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const OUT = resolve(DIST, `reading-partner-${pkg.version}.xpi`);

const manifest = JSON.parse(readFileSync(resolve(ADDON, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  console.error(
    `Version mismatch: package.json ${pkg.version}, addon/manifest.json ${manifest.version}`
  );
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });
// zip adds to an existing archive rather than replacing it.
if (existsSync(OUT)) rmSync(OUT);

// Use system `zip` if available — it's the cleanest cross-platform-ish path.
// Fall back to a Node implementation if not.
try {
  execFileSync("zip", ["--version"], { stdio: "ignore" });
  // -r recurse, -X strip extra attrs, -9 max compression
  // Run inside addon/ so the manifest is at the archive root.
  execFileSync(
    "zip",
    ["-r", "-X", "-9", OUT, ".", "-x", "*.DS_Store", "-x", "__MACOSX/*"],
    { cwd: ADDON, stdio: "inherit" }
  );
  console.log(`packaged: ${OUT}`);
} catch {
  console.error(
    "system `zip` not found. Install it (apt/brew/choco install zip) and retry.\n" +
    "Alternative: zip the contents of addon/ manually so manifest.json is at the archive root, " +
    "and rename to .xpi"
  );
  process.exit(1);
}

writeUpdateManifest();

// Prepends this version to update.json. Its update_link points at the asset
// on the GitHub release tagged v<version>, so the release must be published
// (with the .xpi attached) before update.json is pushed to main.
function writeUpdateManifest() {
  const id = manifest.applications.zotero.id;
  const repo = manifest.homepage_url.replace(/\/$/, "");
  const file = `reading-partner-${pkg.version}.xpi`;
  const hash = createHash("sha256").update(readFileSync(OUT)).digest("hex");

  const path = resolve(ROOT, "update.json");
  const data = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { addons: { [id]: { updates: [] } } };
  const updates = data.addons[id].updates.filter((u) => u.version !== pkg.version);
  updates.unshift({
    version: pkg.version,
    update_link: `${repo}/releases/download/v${pkg.version}/${file}`,
    update_hash: `sha256:${hash}`,
    applications: {
      zotero: {
        strict_min_version: manifest.applications.zotero.strict_min_version,
        strict_max_version: manifest.applications.zotero.strict_max_version,
      },
    },
  });
  data.addons[id].updates = updates;
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`update.json: ${pkg.version} sha256:${hash}`);
}
