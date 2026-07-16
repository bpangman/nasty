#!/usr/bin/env node
"use strict";
/*
 * v0.15 — catches "someone edited index.html's engine block and forgot to regenerate."
 * Re-runs the extraction fresh (in memory, without touching disk) and diffs the result
 * against the checked-in generated files (server/engine.js, server/cloud/engine.js). Fails
 * loudly (nonzero exit, a readable diff) if they differ.
 *
 * Run: node server/test-engine-sync.js   (or: cd server && npm test)
 */
const fs = require("fs");
const path = require("path");
const { extractEngineBody, buildNodeFile, buildDenoFile, INDEX_HTML } = require("./build-engine.js");

function main() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const body = extractEngineBody(html);
  const freshNode = buildNodeFile(body);
  const freshDeno = buildDenoFile(body);

  const nodePath = path.join(__dirname, "engine.js");
  const denoPath = path.join(__dirname, "cloud", "engine.js");
  const onDiskNode = fs.existsSync(nodePath) ? fs.readFileSync(nodePath, "utf8") : null;
  const onDiskDeno = fs.existsSync(denoPath) ? fs.readFileSync(denoPath, "utf8") : null;

  let fail = false;
  if (onDiskNode !== freshNode) {
    fail = true;
    console.error(`STALE: ${nodePath} does not match a fresh extraction of ${INDEX_HTML}.`);
    console.error(`Run: cd server && npm run build-engine`);
  } else {
    console.log(`OK: ${nodePath} is in sync with index.html.`);
  }
  if (onDiskDeno !== freshDeno) {
    fail = true;
    console.error(`STALE: ${denoPath} does not match a fresh extraction of ${INDEX_HTML}.`);
    console.error(`Run: cd server && npm run build-engine`);
  } else {
    console.log(`OK: ${denoPath} is in sync with index.html.`);
  }
  if (fail) process.exit(1);
}

main();
