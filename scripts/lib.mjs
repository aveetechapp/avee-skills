import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const packRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const nameKeys = [
  "skillsRepo", "apiBase", "astraHost", "astraWs", "mcpUrl", "docsHost",
  "npmPackage", "pypiPackage", "goModule",
];
export const urlKeys = ["apiBase", "astraHost", "astraWs", "mcpUrl", "docsHost"];

export function isMain(moduleUrl) {
  return process.argv[1] !== undefined && process.argv[1] === fileURLToPath(moduleUrl);
}

export function* walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) yield* walk(path);
    else if (st.isFile()) yield path;
  }
}

export function markdownFiles(root) {
  return [...walk(root)].filter((p) => p.endsWith(".md"));
}

export function skillFolders(root) {
  const dir = join(root, "skills");
  return readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory())
    .sort();
}

export function read(path) {
  return readFileSync(path, "utf8");
}

export function readJSON(path) {
  return JSON.parse(read(path));
}

export function validateNames(names, label = "names.json") {
  if (!names || typeof names !== "object" || Array.isArray(names)) throw new Error(`${label}: must be a JSON object`);
  for (const k of nameKeys) {
    if (typeof names[k] !== "string" || names[k].trim() === "") throw new Error(`${label}: "${k}" must be a non-empty string`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(names.skillsRepo)) throw new Error(`${label}: skillsRepo must be owner/repo`);
  for (const k of urlKeys) {
    let u;
    try {
      u = new URL(names[k]);
    } catch {
      throw new Error(`${label}: ${k} is not a URL`);
    }
    if (!["https:", "wss:"].includes(u.protocol)) throw new Error(`${label}: ${k} must be https or wss`);
    if (names[k].endsWith("/")) throw new Error(`${label}: ${k} must not end with /`);
  }
  const values = nameKeys.map((k) => names[k]);
  if (new Set(values).size !== values.length) throw new Error(`${label}: two names share one value`);
  return names;
}

export function pendingNames(names, lock) {
  return nameKeys.filter((k) => lock?.[k] !== names[k]);
}

function frontmatterScalar(raw, where) {
  const s = raw.trim();
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      throw new Error(`${where}: malformed double-quoted string`);
    }
  }
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) throw new Error(`${where}: malformed single-quoted string`);
    return s.slice(1, -1).replaceAll("''", "'");
  }
  if (/^([[{&*!%@`|>]|-( |$))/.test(s)) throw new Error(`${where}: unsupported YAML value "${s.slice(0, 40)}"`);
  const plain = s.replace(/\s+#.*$/, "");
  if (plain === "" || plain === "~" || plain === "null") return null;
  if (/^(true|false)$/i.test(plain)) return plain.toLowerCase() === "true";
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(plain)) return Number(plain);
  return plain;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  let parent = null;
  let childIndent = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const where = `line ${n + 1}`;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (line.includes("\t")) throw new Error(`${where}: tabs are not allowed`);
    const m = /^( *)([A-Za-z0-9_-]+):(?: +(.*))?$/.exec(line);
    if (!m) throw new Error(`${where}: expected "key: value", got "${line.trim().slice(0, 40)}"`);
    const [, indent, key, rest = ""] = m;
    if (indent === "") {
      parent = null;
      childIndent = null;
    } else if (parent === null) {
      throw new Error(`${where}: "${key}" is indented under a key that has a value`);
    } else if (childIndent !== null && indent.length !== childIndent) {
      throw new Error(`${where}: only one level of nesting is supported`);
    }
    const target = indent === "" ? out : (out[parent] ??= {});
    if (indent !== "") childIndent = indent.length;
    if (Object.hasOwn(target, key)) throw new Error(`${where}: duplicate key "${key}"`);
    const block = /^([|>])[-+]?$/.exec(rest.trim());
    if (block) {
      const body = [];
      while (n + 1 < lines.length && (lines[n + 1].trim() === "" || indentOf(lines[n + 1]) > indent.length)) body.push(lines[++n].trim());
      const joined = body.join("\n").trim();
      target[key] = block[1] === "|" ? joined : joined.replace(/([^\n])\n(?!\n)/g, "$1 ").replace(/\n\n/g, "\n");
    } else if (rest.trim() === "" && indent === "") {
      target[key] = null;
      parent = key;
    } else {
      target[key] = frontmatterScalar(rest, where);
    }
  }
  return out;
}

function yamlModule() {
  for (const base of [import.meta.url, join(packRoot, "..", "client-sdk", "node", "package.json")]) {
    try {
      return createRequire(base)("yaml");
    } catch {}
  }
  throw new Error("reading a YAML spec needs the yaml package: run npm ci in client-sdk/node, or pass the spec as JSON");
}

export function loadSpec(path) {
  const text = read(path);
  return path.endsWith(".json") ? JSON.parse(text) : yamlModule().parse(text);
}

export function operations(spec) {
  const out = [];
  const params = spec?.components?.parameters ?? {};
  const resolve = (p) => (p && p.$ref ? params[p.$ref.split("/").pop()] : p);
  for (const [path, item] of Object.entries(spec?.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = item?.[method];
      if (!op) continue;
      const names = new Set();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const r = resolve(p);
        if (r?.name && r.in === "query") names.add(r.name);
      }
      out.push({ method: method.toUpperCase(), path, operationId: op.operationId, query: names });
    }
  }
  return out;
}
