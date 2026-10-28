// Bundles src/index.ts to addon/content/index.js as a classic script.
// Zotero loads this via Services.scriptloader.loadSubScript, which expects
// non-module JS in the bootstrap sandbox.

import * as esbuild from "esbuild";
import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());
const ENTRY = resolve(ROOT, "src/index.ts");
const OUT = resolve(ROOT, "addon/content/index.js");

const watch = process.argv.includes("--watch");

const config = {
  entryPoints: [ENTRY],
  bundle: true,
  outfile: OUT,
  format: "iife",
  globalName: "ReadingPartnerBundle",
  platform: "browser",
  target: ["firefox115"], // Zotero 7 ships a Firefox-115-derived runtime
  sourcemap: "inline",
  logLevel: "info",
  // Zotero, Cc, Ci, Services, ChromeUtils are runtime globals.
  external: [],
};

mkdirSync(resolve(ROOT, "addon/content"), { recursive: true });

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log("esbuild: watching for changes...");
} else {
  await esbuild.build(config);
  console.log(`esbuild: built ${OUT}`);
}
