#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isMain, markdownFiles, packRoot, parseFrontmatter, pendingNames, read, readJSON, skillFolders, urlKeys, validateNames, walk } from "./lib.mjs";

const allowedKeys = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const skillName = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const readmeHosts = new Set(["agentskills.io", "github.com"]);
const namedHosts = new Set(["github.com", "claude.ai"]);
const urlPattern = /\b(?:https?|wss?):\/\/[^\s)'"`<>\]]+/g;
const hostLike = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|tech|dev|app|cloud|local|internal|lan|corp|ru|co|xyz|ai)\b/gi;
const internal = [
  [/\bk8s\w*/i, "cluster name"],
  [/\bsvc\b|\.svc\./i, "service DNS"],
  [/\bcluster\b/i, "cluster reference"],
  [/\blocalhost\b|127\.0\.0\.1|\b10\.\d+\.\d+\.\d+\b|\b192\.168\.\d+\.\d+\b|\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/, "private address"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|\bghp_[A-Za-z0-9]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abp]-[A-Za-z0-9-]{10,}/, "token-like secret"],
  [/\bpassword\s*[:=]/i, "password"],
  [/REPLACE_[A-Z]+/, "unreplaced placeholder"],
];

function inside(root, abs) {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function relativeLinks(text) {
  const out = [];
  const body = text.replace(/```[\s\S]*?```/g, "");
  for (const m of body.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(target.split("#")[0]);
    } catch {
      decoded = null;
    }
    out.push({ target, decoded });
  }
  return out;
}

export function validate(root = packRoot) {
  const problems = [];
  const fail = (file, msg) => problems.push(`${relative(root, file) || "."}: ${msg}`);
  const skillsDir = join(root, "skills");

  const names = validateNames(readJSON(join(root, "names.json")));
  let lock = null;
  try {
    lock = readJSON(join(root, "names.lock.json"));
  } catch (err) {
    fail(join(root, "names.lock.json"), `unreadable: ${err.message}`);
  }
  if (lock) for (const k of pendingNames(names, lock)) fail(join(root, "names.lock.json"), `${k} not applied: run node scripts/rename.mjs`);

  const org = names.skillsRepo.split("/")[0];
  const baseUrls = urlKeys.map((k) => names[k]);
  const ownHosts = new Set(baseUrls.map((u) => new URL(u).host));

  const folders = skillFolders(root);
  const lockFile = join(root, "skills.lock");
  if (!existsSync(lockFile)) fail(lockFile, "missing: it lists every published skill name, one per line");
  else {
    const locked = read(lockFile).split("\n").map((l) => l.trim()).filter(Boolean);
    const present = new Set(folders);
    const listed = new Set(locked);
    for (const name of locked) {
      if (!present.has(name)) fail(lockFile, `skill "${name}" was published and its folder is gone: a skill name is never removed or renamed`);
    }
    for (const folder of folders) if (!listed.has(folder)) fail(lockFile, `skill "${folder}" is not listed: append it, the list only grows`);
  }
  for (const folder of folders) {
    const file = join(skillsDir, folder, "SKILL.md");
    if (!existsSync(file)) {
      fail(join(skillsDir, folder), "missing SKILL.md");
      continue;
    }
    const text = read(file);
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    if (!m) {
      fail(file, "no YAML frontmatter between --- lines at the top");
      continue;
    }
    let fm;
    try {
      fm = parseFrontmatter(m[1]);
    } catch (err) {
      fail(file, `frontmatter: ${err.message}`);
      continue;
    }
    for (const k of Object.keys(fm)) if (!allowedKeys.has(k)) fail(file, `frontmatter key "${k}" is not in the Agent Skills spec`);
    const { name, description } = fm;
    if (typeof name !== "string") fail(file, "name is required");
    else {
      if (name !== folder) fail(file, `name "${name}" does not match its folder "${folder}"`);
      if (name.length > 64 || !skillName.test(name)) fail(file, `name "${name}" must be kebab-case, 1-64 chars`);
    }
    if (typeof description !== "string" || description.trim() === "") fail(file, "description is required");
    else {
      if (description.length > 1024) fail(file, `description is ${description.length} chars, the limit is 1024`);
      if (/[<>]/.test(description)) fail(file, "description must not contain < or >");
      if (!/\buse (it )?when\b/i.test(description)) fail(file, 'description must say when to use the skill ("Use when …")');
    }
    if (fm.compatibility !== undefined && (typeof fm.compatibility !== "string" || fm.compatibility.length > 500)) {
      fail(file, "compatibility must be a string of at most 500 chars");
    }
    if (fm.metadata !== undefined) {
      if (!fm.metadata || typeof fm.metadata !== "object") fail(file, "metadata must be a map");
      else for (const [k, v] of Object.entries(fm.metadata)) if (typeof v !== "string") fail(file, `metadata.${k} must be a string`);
    }
    const lines = text.split("\n").length;
    if (lines > 500) fail(file, `${lines} lines; keep SKILL.md under 500 and move detail to references/`);

    const linked = new Set(relativeLinks(text).filter((l) => l.decoded !== null).map((l) => resolve(dirname(file), l.decoded)));
    for (const sub of ["references", "scripts", "assets"]) {
      const dir = join(skillsDir, folder, sub);
      if (!existsSync(dir)) continue;
      for (const f of walk(dir)) {
        if (relative(dir, f).includes("/")) fail(f, "keep references one level deep");
        if (!linked.has(f)) fail(f, "not linked from SKILL.md, so no agent will read it");
      }
    }
  }

  const urlAllowed = (url, isReadme) => {
    const clean = url.replace(/[.,;:]+$/, "");
    let u;
    try {
      u = new URL(clean);
    } catch {
      return false;
    }
    if (baseUrls.some((b) => clean === b || clean.startsWith(`${b}/`) || clean.startsWith(`${b}?`))) return true;
    if (u.host === "github.com" && u.pathname.startsWith(`/${org}/`)) return true;
    return isReadme && readmeHosts.has(u.host);
  };

  const textFiles = [...markdownFiles(root), join(root, "names.json"), join(root, "LICENSE")].filter((f) => existsSync(f));
  for (const file of textFiles) {
    const text = read(file);
    const isReadme = basename(file) === "README.md" && dirname(file) === root;
    for (const [re, what] of internal) {
      if (basename(file) === "names.json" && what === "unreplaced placeholder") continue;
      const hit = re.exec(text);
      if (hit) fail(file, `${what}: "${hit[0]}"`);
    }
    for (const u of text.matchAll(urlPattern)) {
      if (!urlAllowed(u[0], isReadme)) fail(file, `URL is not on a public avee host: ${u[0]}`);
    }
    const withoutUrls = text.replace(urlPattern, "").replace(/cursor:\/\/\S+/g, "");
    for (const h of withoutUrls.matchAll(hostLike)) {
      const host = h[0].toLowerCase();
      if (ownHosts.has(host) || (isReadme && readmeHosts.has(host)) || namedHosts.has(host)) continue;
      fail(file, `host name outside the public avee hosts: ${host}`);
    }
    for (const d of text.matchAll(/cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?[^\s)'"`<>]+/g)) {
      let config;
      try {
        config = JSON.parse(Buffer.from(new URL(d[0]).searchParams.get("config") ?? "", "base64").toString("utf8"));
      } catch {
        config = undefined;
      }
      if (typeof config?.url !== "string") fail(file, "Cursor deeplink config is not base64 JSON with a url");
      else if (config.url !== names.mcpUrl) fail(file, `Cursor deeplink points at ${config.url}, not ${names.mcpUrl}: run node scripts/rename.mjs`);
    }
    if (file.endsWith(".md")) {
      for (const { target, decoded } of relativeLinks(text)) {
        if (decoded === null) {
          fail(file, `malformed link: ${target}`);
          continue;
        }
        const abs = resolve(dirname(file), decoded);
        if (!inside(root, abs)) fail(file, `link leaves the pack: ${target}`);
        else if (!existsSync(abs)) fail(file, `broken link: ${target}`);
        else if (statSync(abs).isDirectory() && !existsSync(join(abs, "SKILL.md"))) fail(file, `link to a folder with no SKILL.md: ${target}`);
      }
    }
  }

  for (const f of walk(root)) {
    if (!/\.(md|mjs|json)$|^LICENSE$|^skills\.lock$/.test(basename(f))) fail(f, "unexpected file type in the pack");
  }

  return { problems, skills: folders.length, files: textFiles.length };
}

if (isMain(import.meta.url)) {
  try {
    const { problems, skills, files } = validate();
    for (const p of problems) console.error(`validate: ${p}`);
    if (problems.length > 0) {
      console.error(`validate: ${problems.length} problem(s)`);
      process.exit(1);
    }
    console.log(`validate: ${skills} skills, ${files} files checked, all good`);
  } catch (err) {
    console.error(`validate: ${err.message}`);
    process.exit(1);
  }
}
