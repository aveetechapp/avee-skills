import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { loadSpec, operations, packRoot, parseFrontmatter, readJSON } from "./lib.mjs";
import { pending, rename } from "./rename.mjs";
import { syncCheck } from "./sync-check.mjs";
import { validate } from "./validate.mjs";

const names = readJSON(join(packRoot, "names.json"));
const scratch = mkdtempSync(join(tmpdir(), "agent-skills-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const cursorLink = (url) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=avee&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url })).toString("base64"))}`;

const skill = (name, body) =>
  `---\nname: ${name}\ndescription: >\n  Teaches ${name}.\n  Use when the user asks about ${name}.\nlicense: MIT\nmetadata:\n  author: avee\n  version: "0.1.0"\n---\n\n${body}\n`;

function fixture(edit = {}) {
  const root = mkdtempSync(join(scratch, "pack-"));
  const files = {
    "names.json": `${JSON.stringify(names, null, 2)}\n`,
    "names.lock.json": `${JSON.stringify(names, null, 2)}\n`,
    LICENSE: "MIT License\n",
    "skills.lock": "astra-oracle\navee-data-api\navee-mcp\n",
    "README.md": "# pack\n\nSee [astra](skills/astra-oracle/SKILL.md).\n",
    "skills/astra-oracle/SKILL.md": skill(
      "astra-oracle",
      `Read [streaming](references/streaming.md). Call \`${names.astraHost}/v1/feeds?category=crypto\` or GET /v1/status?feed=x.`,
    ),
    "skills/astra-oracle/references/streaming.md": `Stream from \`${names.astraWs}\`.\n`,
    "skills/avee-data-api/SKILL.md": skill("avee-data-api", "Read [routes](references/routes.md)."),
    "skills/avee-data-api/references/routes.md": "- GET /pairs\n- GET /chains/{chain}/pairs/{address}\n",
    "skills/avee-mcp/SKILL.md": skill("avee-mcp", `Read [tools](references/tools.md). Install with [this link](${cursorLink(names.mcpUrl)}).`),
    "skills/avee-mcp/references/tools.md": "- `find_asset`\n- `get_pair`\n",
    ...edit,
  };
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function specs(extra = {}) {
  const dir = mkdtempSync(join(scratch, "specs-"));
  const q = (name) => ({ name, in: "query" });
  const api = {
    paths: {
      "/pairs": { get: { operationId: "pairs", parameters: [q("chain")] } },
      "/chains/{chain}/pairs/{address}": { get: { operationId: "pair" } },
      ...extra.api,
    },
  };
  const astra = {
    components: { parameters: { Feed: q("feed") } },
    paths: {
      "/v1/feeds": { get: { operationId: "feeds", parameters: [q("category")] } },
      "/v1/status": { get: { operationId: "status", parameters: [{ $ref: "#/components/parameters/Feed" }] } },
      "/ws": { get: { operationId: "ws" } },
      ...extra.astra,
    },
  };
  const tools = [{ name: "find_asset" }, { name: "get_pair" }, ...(extra.tools ?? [])];
  writeFileSync(join(dir, "api.json"), JSON.stringify(api));
  writeFileSync(join(dir, "astra.json"), JSON.stringify(astra));
  writeFileSync(join(dir, "tools.json"), JSON.stringify(tools));
  return { apiSpec: join(dir, "api.json"), astraSpec: join(dir, "astra.json"), tools: join(dir, "tools.json") };
}

const problemsOf = (root) => validate(root).problems;
const driftOf = (root, extra) => syncCheck({ root, ...specs(extra) }).problems;
const hasProblem = (problems, re) => assert.ok(problems.some((p) => re.test(p)), `no problem matches ${re}:\n${problems.join("\n")}`);

describe("parseFrontmatter", () => {
  it("reads scalars, quotes, a folded block and one nested map", () => {
    const fm = parseFrontmatter(
      [
        "name: astra-oracle",
        "description: >-",
        "  first line",
        "  second line",
        "",
        "  new paragraph",
        "quoted: \"a: b # c\"",
        "single: 'it''s'",
        "plain: value # comment",
        "flag: true",
        "count: 3",
        "empty:",
        "metadata:",
        "  author: avee",
        "  version: \"0.1.0\"",
      ].join("\n"),
    );
    assert.deepEqual(fm, {
      name: "astra-oracle",
      description: "first line second line\nnew paragraph",
      quoted: "a: b # c",
      single: "it's",
      plain: "value",
      flag: true,
      count: 3,
      empty: null,
      metadata: { author: "avee", version: "0.1.0" },
    });
  });

  it("keeps a literal block's line breaks", () => {
    assert.deepEqual(parseFrontmatter("text: |\n  a\n  b\nnext: x"), { text: "a\nb", next: "x" });
  });

  it("parses the real skills' frontmatter", () => {
    for (const folder of ["astra-oracle", "avee-data-api", "avee-mcp", "avee-sdk"]) {
      const text = readFileSync(join(packRoot, "skills", folder, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(/^---\n([\s\S]*?)\n---\n/.exec(text)[1]);
      assert.equal(fm.name, folder);
      assert.equal(typeof fm.description, "string");
      assert.equal(typeof fm.metadata.version, "string");
    }
  });

  for (const [what, text] of [
    ["a list", "tools:\n  - a"],
    ["a flow map", "metadata: {a: b}"],
    ["a flow list", "tools: [a, b]"],
    ["a duplicate key", "name: a\nname: b"],
    ["a tab", "name:\ta"],
    ["two levels of nesting", "metadata:\n  a:\n    b: c"],
    ["a child under a scalar", "name: a\n  b: c"],
    ["a broken quote", 'name: "a'],
    ["a line without a key", "just text"],
  ]) {
    it(`refuses ${what}`, () => assert.throws(() => parseFrontmatter(text)));
  }
});

describe("validate", () => {
  it("passes a clean pack", () => assert.deepEqual(problemsOf(fixture()), []));

  it("passes the real pack", () => assert.deepEqual(problemsOf(packRoot), []));

  it("fails a URL on a foreign host", () => {
    hasProblem(problemsOf(fixture({ "skills/avee-mcp/references/tools.md": "- `find_asset`\n- `get_pair`\n\nhttps://evil.example.com/x\n" })), /URL is not on a public avee host/);
  });

  it("fails a URL that only starts like an avee host", () => {
    hasProblem(problemsOf(fixture({ "skills/avee-mcp/references/tools.md": `${names.astraHost}.evil.com/x\n` })), /not on a public avee host/);
  });

  it("fails a bare internal host name and a private address", () => {
    const problems = problemsOf(fixture({ "skills/avee-mcp/references/tools.md": "db at pg.internal and 10.0.0.12\n" }));
    hasProblem(problems, /host name outside the public avee hosts: pg\.internal/);
    hasProblem(problems, /private address/);
  });

  it("fails a name that does not match its folder, and a description without when", () => {
    const problems = problemsOf(fixture({ "skills/avee-sdk/SKILL.md": "---\nname: other\ndescription: SDKs.\n---\n" }));
    hasProblem(problems, /does not match its folder/);
    hasProblem(problems, /description must say when/);
  });

  it("fails frontmatter it cannot read", () => {
    hasProblem(problemsOf(fixture({ "skills/avee-sdk/SKILL.md": "---\nname: avee-sdk\ntools:\n  - a\n---\n" })), /frontmatter: line 3/);
  });

  it("fails a reference no SKILL.md links", () => {
    hasProblem(problemsOf(fixture({ "skills/avee-mcp/references/orphan.md": "x\n" })), /orphan\.md: not linked from SKILL\.md/);
  });

  it("fails a link that leaves the pack, a broken link and a malformed one", () => {
    const problems = problemsOf(fixture({ "README.md": "[a](../outside.md) [b](missing.md) [c](bad%E0%A4.md)\n" }));
    hasProblem(problems, /link leaves the pack: \.\.\/outside\.md/);
    hasProblem(problems, /broken link: missing\.md/);
    hasProblem(problems, /malformed link/);
  });

  it("fails names not applied to the lock", () => {
    hasProblem(problemsOf(fixture({ "names.lock.json": JSON.stringify({ ...names, astraHost: "https://old.avee.tech" }) })), /astraHost not applied/);
  });

  it("fails a Cursor deeplink to another MCP URL or with a broken config", () => {
    const problems = problemsOf(
      fixture({ "README.md": `[a](${cursorLink("https://mcp.avee.tech/other")}) [b](cursor://anysphere.cursor-deeplink/mcp/install?name=x&config=bnVsbA==)\n` }),
    );
    hasProblem(problems, /Cursor deeplink points at https:\/\/mcp\.avee\.tech\/other/);
    hasProblem(problems, /not base64 JSON with a url/);
  });

  it("fails a published skill whose folder is gone", () => {
    hasProblem(problemsOf(fixture({ "skills/avee-mcp/SKILL.md": null, "skills/avee-mcp/references/tools.md": null })), /skill "avee-mcp" was published and its folder is gone/);
  });

  it("fails a skill folder the lock does not list, and a pack without a lock", () => {
    hasProblem(problemsOf(fixture({ "skills/avee-new/SKILL.md": "---\nname: avee-new\ndescription: New. Use when needed.\n---\n" })), /skill "avee-new" is not listed/);
    hasProblem(problemsOf(fixture({ "skills.lock": null })), /skills\.lock: missing/);
  });

  it("fails a file type that does not belong in the pack", () => {
    hasProblem(problemsOf(fixture({ "skills/avee-sdk/run.sh": "echo\n" })), /run\.sh: unexpected file type/);
  });
});

describe("sync-check", () => {
  it("passes a pack that matches its contracts", () => assert.deepEqual(driftOf(fixture()), []));

  it("fails a route the spec does not have", () => {
    const root = fixture({ "skills/avee-mcp/references/tools.md": "- `find_asset`\n- `get_pair`\n\nGET /v1/nope\n" });
    hasProblem(driftOf(root), /GET \/v1\/nope is not in the Astra spec/);
  });

  it("fails a host URL to a route the spec does not have, and an unknown query parameter", () => {
    const root = fixture({ "skills/avee-mcp/references/tools.md": `- \`find_asset\`\n- \`get_pair\`\n\n${names.astraHost}/v2/gone\nGET /v1/feeds?bogus=1\n` });
    const problems = driftOf(root);
    hasProblem(problems, /\/v2\/gone is not a route in the Astra spec/);
    hasProblem(problems, /has no query parameter "bogus"/);
  });

  it("resolves a $ref query parameter", () => {
    assert.deepEqual(driftOf(fixture()).filter((p) => /feed/.test(p)), []);
  });

  it("fails an MCP tool that tools.json does not have", () => {
    const root = fixture({ "skills/avee-mcp/references/tools.md": "- `find_asset`\n- `get_pair`\n- `get_bogus`\n" });
    hasProblem(driftOf(root), /MCP tool get_bogus is not in tools\.json/);
  });

  it("fails a route, tool or Astra operation the references do not list", () => {
    const problems = driftOf(fixture(), {
      api: { "/tokens": { get: { operationId: "tokens" } } },
      astra: { "/v1/candles": { get: { operationId: "candles" } } },
      tools: [{ name: "search_pairs" }],
    });
    hasProblem(problems, /routes\.md: does not list GET \/tokens/);
    hasProblem(problems, /no reference mentions GET \/v1\/candles/);
    hasProblem(problems, /tools\.md: does not list MCP tool search_pairs/);
  });

  it("catches a planted tool with a verb only a new tool uses", () => {
    const root = fixture({ "skills/avee-mcp/references/tools.md": "- `find_asset`\n- `get_pair`\n- `search_pairs`\n- `search_bogus`\n" });
    hasProblem(driftOf(root, { tools: [{ name: "search_pairs" }] }), /MCP tool search_bogus is not in tools\.json/);
  });

  it("refuses a tools file that is not a list of named tools", () => {
    const s = specs();
    writeFileSync(s.tools, JSON.stringify({ tools: [] }));
    assert.throws(() => syncCheck({ root: fixture(), ...s }), /array of tools/);
  });
});

describe("loadSpec", () => {
  it("reads the real YAML specs with a YAML parser", (t) => {
    const path = join(packRoot, "..", "client-sdk", "spec", "astra", "astra.yml");
    let spec;
    try {
      spec = loadSpec(path);
    } catch (err) {
      if (/yaml package/.test(err.message)) return t.skip(err.message);
      throw err;
    }
    const status = operations(spec).find((o) => o.path === "/v1/status");
    assert.deepEqual([...status.query], ["feed"]);
    assert.deepEqual(spec.security, []);
  });
});

describe("rename", () => {
  it("rewrites a changed host everywhere, re-encodes the Cursor link and records the lock", () => {
    const root = fixture();
    const moved = { ...names, mcpUrl: "https://mcp.avee.tech/mcp", astraHost: "https://astra.avee.tech", astraWs: "wss://astra.avee.tech/ws" };
    writeFileSync(join(root, "names.json"), JSON.stringify(moved));
    assert.deepEqual(pending(root).keys, ["astraHost", "astraWs", "mcpUrl"]);
    hasProblem(problemsOf(root), /not applied/);

    const changed = rename(root);
    assert.ok(changed.includes(join("skills", "astra-oracle", "SKILL.md")));
    assert.deepEqual(pending(root).keys, []);
    const mcp = readFileSync(join(root, "skills", "avee-mcp", "SKILL.md"), "utf8");
    assert.ok(mcp.includes(cursorLink(moved.mcpUrl)));
    assert.ok(readFileSync(join(root, "skills", "astra-oracle", "references", "streaming.md"), "utf8").includes("wss://astra.avee.tech/ws"));
    assert.deepEqual(problemsOf(root), []);
    assert.deepEqual(rename(root), []);
  });

  it("refuses names that are not valid", () => {
    const root = fixture({ "names.json": JSON.stringify({ ...names, apiBase: "http://api.avee.tech/" }) });
    assert.throws(() => pending(root), /apiBase must be https or wss/);
  });
});
