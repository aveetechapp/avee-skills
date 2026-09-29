#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain, packRoot, pendingNames, read, readJSON, validateNames, walk } from "./lib.mjs";

const textExt = new Set([".md", ".mjs", ".json", ".txt", ".sh", ".py", ".ts", ""]);
const self = fileURLToPath(import.meta.url);

function cursorConfig(mcpUrl) {
  return encodeURIComponent(Buffer.from(JSON.stringify({ url: mcpUrl })).toString("base64"));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pending(root = packRoot) {
  const names = validateNames(readJSON(join(root, "names.json")));
  const applied = validateNames(readJSON(join(root, "names.lock.json")), "names.lock.json");
  return { names, applied, keys: pendingNames(names, applied) };
}

export function rename(root = packRoot) {
  const { names, applied, keys } = pending(root);
  if (keys.length === 0) return [];
  const namesPath = join(root, "names.json");
  const lockPath = join(root, "names.lock.json");
  const mapping = new Map(keys.map((k) => [applied[k], names[k]]));
  const pattern = new RegExp([...mapping.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"), "g");
  const changed = [];
  for (const path of walk(root)) {
    if (relative(root, path).startsWith("scripts/") || path === namesPath || path === lockPath || path === self || !textExt.has(extname(path))) continue;
    const before = read(path);
    const after = before
      .replace(pattern, (m) => mapping.get(m))
      .replace(/(cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=[^&\s)]+&config=)[^\s)'"`<>]+/g, (_, head) => head + cursorConfig(names.mcpUrl));
    if (after !== before) {
      writeFileSync(path, after);
      changed.push(relative(root, path));
    }
  }
  writeFileSync(lockPath, `${JSON.stringify(names, null, 2)}\n`);
  return changed;
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.includes("--check")) {
      const { keys } = pending();
      for (const k of keys) console.error(`rename --check: ${k} not applied: run node scripts/rename.mjs`);
      if (keys.length > 0) process.exit(1);
      console.log("rename --check: names are applied");
    } else {
      const changed = rename();
      for (const f of changed) console.log(`rewrote ${f}`);
      console.log(`rename: ${changed.length} files rewritten`);
    }
  } catch (err) {
    console.error(`rename: ${err.message}`);
    process.exit(1);
  }
}
