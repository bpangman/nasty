#!/usr/bin/env node
"use strict";
/*
 * NASTY v0.15 engine extraction — the SINGLE source of truth for the rules is the block of
 * index.html between the "NASTY ENGINE EXTRACT: BEGIN" / "END" comment markers (§ LAYOUT,
 * § STATE, § ENGINE, § TURN DECISIONS, § AI — see the markers themselves in index.html for the
 * full explanation). This script extracts that text VERBATIM and generates two build
 * artifacts from it, wrapped two different ways for two different module systems:
 *
 *   server/engine.js       — Node / CommonJS (require()), used by server/server.js
 *   server/cloud/engine.js — Deno / ESM (import), used by server/cloud/server.ts
 *
 * There is exactly ONE extraction pass; the two output files differ only in their module
 * boilerplate (require/module.exports vs. import-free ESM export), never in the extracted
 * body itself.
 *
 * Regenerate after ANY change to index.html's extracted block:
 *   cd server && npm run build-engine
 *
 * server/test-engine-sync.js re-runs this same extraction in memory and diffs it against the
 * checked-in generated files, so `npm test` catches "someone edited the engine and forgot to
 * regenerate" — but only if that test actually gets run. Don't skip it.
 *
 * ---- Design notes ----
 * The extracted body declares its own module-scope `let G=null;` and `let LAY=null;` (as part
 * of § STATE / § LAYOUT) and a family of top-level `function` declarations that all close over
 * those two variables by bare reference (legalMoves(), applyMove(), chooseAI(), etc.). The
 * SERVER needs to run many rooms' games concurrently, so a single pair of module-level G/LAY
 * globals won't do — instead, this script wraps the ENTIRE extracted body inside a
 * `createEngine()` factory function. Each call to createEngine() gets its own private,
 * closure-scoped G/LAY (and every function that touches them), so one room = one createEngine()
 * instance = fully isolated game state, with ZERO changes to the extracted text itself — this
 * is a textual wrap around the body, not a rewrite of it.
 *
 * The extracted body also depends on one thing defined OUTSIDE its own span: `rand` (§ UTIL,
 * one line: `const rand=a=>a[Math.floor(Math.random()*a.length)];`). The wrapper supplies a
 * byte-identical copy of that one line at module scope (stateless, safe to share across every
 * room instance) rather than pulling in the rest of § UTIL (which touches `document`/
 * `AudioContext`/`matchMedia`/`localStorage` — none of that exists in Node/Deno).
 *
 * One line inside the extracted span, `window.entryIdx=entryIdx; window.loopIdx=loopIdx;`, is a
 * browser-only test-exposure convenience (mirrors entryIdx/loopIdx onto `window` so a Playwright
 * soak-test script can call them) with no behavioral meaning and no `window` global in
 * Node/Deno — it is stripped by this script during extraction, not left in as dead code that
 * would throw.
 */
const fs = require("fs");
const path = require("path");

const BEGIN_MARKER = "NASTY ENGINE EXTRACT: BEGIN";
const END_MARKER = "NASTY ENGINE EXTRACT: END";
const ROOT = path.join(__dirname, "..");
const INDEX_HTML = path.join(ROOT, "index.html");

function extractEngineBody(html) {
  const beginIdx = html.indexOf(BEGIN_MARKER);
  const endIdx = html.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(`Could not find both engine extract markers in ${INDEX_HTML} (BEGIN@${beginIdx}, END@${endIdx})`);
  }
  // Start right after the BEGIN marker's own comment block closes (the next "*/"), so the
  // marker's own explanatory comment isn't duplicated into the generated file's body.
  const afterBeginCommentClose = html.indexOf("*/", beginIdx);
  if (afterBeginCommentClose === -1) throw new Error("BEGIN marker comment never closes with */");
  let body = html.slice(afterBeginCommentClose + 2, endIdx);
  // Strip the trailing "/* ===== NASTY ENGINE EXTRACT: END ===== */" comment opener if it
  // leaked in (it shouldn't, since endIdx points at the marker text itself, before the comment
  // starts on the same line in source — defensive trim in case of future reformatting).
  const endCommentOpen = body.lastIndexOf("/*");
  if (endCommentOpen !== -1 && body.slice(endCommentOpen).indexOf(END_MARKER) === -1 && endCommentOpen > body.length - 60) {
    body = body.slice(0, endCommentOpen);
  }
  // Strip the one browser-only line documented above (test-exposure convenience, no behavior).
  body = body.replace(/^\s*window\.entryIdx=entryIdx;\s*window\.loopIdx=loopIdx;\s*$/m, "");
  return body.trim() + "\n";
}

const GENERATED_HEADER = `/*
 * GENERATED FILE — do not hand-edit. Produced by server/build-engine.js from the text between
 * index.html's "NASTY ENGINE EXTRACT: BEGIN"/"END" markers (§ LAYOUT, § STATE, § ENGINE,
 * § TURN DECISIONS, § AI). Edit the rules in index.html, then run:
 *   cd server && npm run build-engine
 * server/test-engine-sync.js fails if this file is stale relative to index.html — run it (or
 * \`npm test\`) after any engine change, before deploying/testing server changes.
 */
`;

const EXPORT_NAMES = [
  "newGame", "freshDeck", "buildLayout", "computeViewSeat", "entryIdx", "loopIdx", "stepPos",
  "partnerOf", "sameTeam", "allHome", "trackOccupant", "homeOcc", "isSnug",
  "pathForward", "pathBack", "actingOwner", "legalMoves", "applyMove", "ImpossibleStateError",
  "dangerAt", "kickVal", "scoreMove", "chooseAI",
  "seatsWithCards", "handOver", "needsReshuffle", "dealDecision", "passDecision", "advanceTurn",
  "COLORS4", "COLORS6", "SCHEDULES", "HOME_N",
];

function indent(text, spaces) {
  const pad = " ".repeat(spaces);
  return text.split("\n").map(l => (l.length ? pad + l : l)).join("\n");
}

function buildNodeFile(body) {
  const exportsList = EXPORT_NAMES.map(n => "    " + n).join(",\n");
  return GENERATED_HEADER + `"use strict";
const rand=a=>a[Math.floor(Math.random()*a.length)];

function createEngine(){
${indent(body, 2)}
  return {
${exportsList},
    getG:()=>G, setG:(g)=>{G=g;}, getLAY:()=>LAY, setLAY:(l)=>{LAY=l;},
  };
}

module.exports = { createEngine, rand };
`;
}

function buildDenoFile(body) {
  const exportsList = EXPORT_NAMES.map(n => "    " + n).join(",\n");
  return GENERATED_HEADER + `const rand=a=>a[Math.floor(Math.random()*a.length)];

function createEngine(){
${indent(body, 2)}
  return {
${exportsList},
    getG:()=>G, setG:(g)=>{G=g;}, getLAY:()=>LAY, setLAY:(l)=>{LAY=l;},
  };
}

export { createEngine, rand };
`;
}

function main() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const body = extractEngineBody(html);

  const nodeOut = buildNodeFile(body);
  const denoOut = buildDenoFile(body);

  const nodePath = path.join(__dirname, "engine.js");
  const denoPath = path.join(__dirname, "cloud", "engine.js");
  fs.writeFileSync(nodePath, nodeOut);
  fs.writeFileSync(denoPath, denoOut);
  console.log(`wrote ${nodePath} (${nodeOut.length} bytes)`);
  console.log(`wrote ${denoPath} (${denoOut.length} bytes)`);
}

if (require.main === module) main();

module.exports = { extractEngineBody, buildNodeFile, buildDenoFile, INDEX_HTML };
