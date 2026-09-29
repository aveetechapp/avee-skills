#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isMain, loadSpec, markdownFiles, operations, packRoot, read, readJSON } from "./lib.mjs";

const apiExtras = new Set(["/openapi.yml", "/llms.txt"]);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tmpl = (p) => p.replace(/\{[^}]+\}/g, "{}");
const isAstraPath = (p) => /^\/(v1|v2|api|ws|live|ready)(\/|$)/.test(p);

function matcher(path) {
  return new RegExp(`^${tmpl(path).split("{}").map(escapeRegExp).join("[^/]+")}$`);
}

function findOp(ops, method, path) {
  const byMethod = (o) => !method || o.method === method;
  const exact = ops.find((o) => byMethod(o) && tmpl(o.path) === tmpl(path));
  if (exact) return exact;
  const probe = /[{<]/.test(path) ? path.replace(/<[^>]+>/g, "x") : path;
  return ops.find((o) => byMethod(o) && o.re.test(probe));
}

export function syncCheck({ root = packRoot, apiSpec, astraSpec, tools: toolsPath }) {
  const problems = [];
  const fail = (file, msg) => problems.push(`${relative(root, file)}: ${msg}`);
  const skillsDir = join(root, "skills");

  const names = readJSON(join(root, "names.json"));
  const apiOps = operations(loadSpec(apiSpec));
  const astraOps = operations(loadSpec(astraSpec));
  for (const op of [...apiOps, ...astraOps]) op.re = matcher(op.path);
  const toolList = readJSON(toolsPath);
  if (!Array.isArray(toolList) || toolList.some((t) => typeof t?.name !== "string")) throw new Error(`${toolsPath}: expected an array of tools with a name`);
  const tools = new Set(toolList.map((t) => t.name));
  const toolVerbs = [...new Set([...tools].map((n) => n.split("_")[0]))].map(escapeRegExp).join("|");
  const toolPattern = new RegExp(`(?<![\\w/.])((?:${toolVerbs})_[a-z0-9_]+)\\b`, "g");

  const mentioned = new Set();
  const mentionedTools = new Map();

  const checkQuery = (file, op, query, where) => {
    if (!query) return;
    for (const part of query.split("&")) {
      let key;
      try {
        key = decodeURIComponent(part.split("=")[0]);
      } catch {
        key = part.split("=")[0];
      }
      if (!key) continue;
      const ok = op.query.has(key) || op.query.has(key.replace(/\[\]$/, "")) || op.query.has(`${key}[]`);
      if (!ok) fail(file, `${where}: ${op.method} ${op.path} has no query parameter "${key}"`);
    }
  };

  const bases = [
    [names.apiBase, false],
    [names.astraHost, true],
    [names.astraWs.replace(/\/ws$/, ""), true],
  ];

  for (const file of markdownFiles(skillsDir)) {
    const text = read(file);

    for (const m of text.matchAll(/\b(GET|POST) (\/[A-Za-z0-9_{}.\-/[\]<>]*)(\?[^\s`'"|)]*)?/g)) {
      const [, method, rawPath, q] = m;
      const path = rawPath.replace(/[.,;:]+$/, "");
      const astra = isAstraPath(path);
      if (!astra && apiExtras.has(path)) continue;
      const op = findOp(astra ? astraOps : apiOps, method, path);
      if (!op) {
        fail(file, `${method} ${path} is not in the ${astra ? "Astra" : "api"} spec`);
        continue;
      }
      mentioned.add(`${astra ? "astra" : "api"} ${op.method} ${op.path}`);
      checkQuery(file, op, q?.slice(1), `${method} ${path}`);
    }

    const vars = new Map();
    for (const m of text.matchAll(/\b([A-Z])='([^']+)'/g)) vars.set(m[1], m[2]);
    for (const m of text.matchAll(/(?:https?|wss?):\/\/[^\s'"`<>)]+|\$([A-Z])(\/[^\s'"`<>)]*)/g)) {
      let url = m[0];
      if (m[1]) {
        if (!vars.has(m[1])) continue;
        url = vars.get(m[1]) + m[2];
      }
      url = url.replace(/[.,;:]+$/, "");
      for (const [base, astra] of bases) {
        if (!(url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`))) continue;
        const rest = url.slice(base.length);
        if (rest === "") break;
        const q = rest.indexOf("?");
        const path = q < 0 ? rest : rest.slice(0, q);
        if (!astra && apiExtras.has(path)) break;
        const ops = astra ? astraOps : apiOps;
        const op = findOp(ops, "GET", path) ?? findOp(ops, null, path);
        if (!op) fail(file, `${url} is not a route in the ${astra ? "Astra" : "api"} spec`);
        else {
          mentioned.add(`${astra ? "astra" : "api"} ${op.method} ${op.path}`);
          checkQuery(file, op, q < 0 ? "" : rest.slice(q + 1), url);
        }
        break;
      }
    }

    for (const m of text.matchAll(toolPattern)) {
      if (!tools.has(m[1])) fail(file, `MCP tool ${m[1]} is not in tools.json`);
      if (!mentionedTools.has(file)) mentionedTools.set(file, new Set());
      mentionedTools.get(file).add(m[1]);
    }
  }

  const routesRef = join(skillsDir, "avee-data-api", "references", "routes.md");
  const routesText = existsSync(routesRef) ? read(routesRef) : "";
  for (const op of apiOps) {
    const re = new RegExp(`\\b${op.method} ${escapeRegExp(tmpl(op.path)).replaceAll("\\{\\}", "\\{[^}]+\\}")}(?![\\w/{])`);
    if (!re.test(routesText)) fail(routesRef, `does not list ${op.method} ${op.path} (${op.operationId}) from the api spec`);
  }
  for (const op of astraOps) {
    if (!mentioned.has(`astra ${op.method} ${op.path}`)) fail(join(skillsDir, "astra-oracle"), `no reference mentions ${op.method} ${op.path} (${op.operationId}) from the Astra spec`);
  }
  const toolsRef = join(skillsDir, "avee-mcp", "references", "tools.md");
  const listed = mentionedTools.get(toolsRef) ?? new Set();
  for (const name of tools) if (!listed.has(name)) fail(toolsRef, `does not list MCP tool ${name} from tools.json`);

  return { problems, apiOps: apiOps.length, astraOps: astraOps.length, tools: tools.size };
}

function arg(flag, env, candidates) {
  const i = process.argv.indexOf(flag);
  if (i > 0 && process.argv[i + 1] === undefined) throw new Error(`${flag} needs a path`);
  const chosen = i > 0 ? [process.argv[i + 1]] : process.env[env] ? [process.env[env]] : candidates;
  const found = chosen.map((c) => resolve(packRoot, c)).find((p) => existsSync(p));
  if (!found) throw new Error(`none of ${chosen.join(", ")} exists; pass ${flag} or set ${env}`);
  return found;
}

if (isMain(import.meta.url)) {
  try {
    const sources = {
      apiSpec: arg("--api-spec", "API_SPEC", ["../api/v1/openapi.yml", "../api/v1/openapi.json"]),
      tools: arg("--tools", "TOOLS_SPEC", ["../internal/transport/mcp/testdata/tools.json"]),
      astraSpec: arg("--astra-spec", "ASTRA_SPEC", ["../../dex-scan/docs/price/astra.openapi.yml", "../client-sdk/spec/astra/astra.yml"]),
    };
    const r = syncCheck(sources);
    for (const p of r.problems) console.error(`sync-check: ${p}`);
    if (r.problems.length > 0) {
      console.error(`sync-check: ${r.problems.length} drift problem(s)`);
      process.exit(1);
    }
    console.log(
      `sync-check: ${r.apiOps} api operations, ${r.astraOps} Astra operations, ${r.tools} MCP tools; ` +
        `sources ${[sources.apiSpec, sources.astraSpec, sources.tools].map((p) => relative(packRoot, p)).join(", ")}; no drift`,
    );
  } catch (err) {
    console.error(`sync-check: ${err.message}`);
    process.exit(2);
  }
}
