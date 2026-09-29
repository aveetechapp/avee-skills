# avee agent skills

[Agent Skills](https://agentskills.io) that teach a coding or chat agent to use avee well: the keyless
DEX data API, the free Hermes-compatible Astra oracle, and the avee MCP server.

| Skill | Teaches |
|---|---|
| [`avee-data-api`](skills/avee-data-api/SKILL.md) | `/api/v1`: pairs, tokens, safety briefs, candles, wallets, leaderboards; limits, backoff, pagination, errors, x402 |
| [`astra-oracle`](skills/astra-oracle/SKILL.md) | Astra: switching a Pyth Hermes client in one line, REST, SSE and WebSocket, feed ids, statuses, what not to liquidate on |
| [`avee-mcp`](skills/avee-mcp/SKILL.md) | connecting an agent to the MCP server, and which tool answers which question |
| [`avee-sdk`](skills/avee-sdk/SKILL.md) | the avee SDKs: one package per language with the data API and Astra clients, with quickstarts |

Each skill is a folder with a `SKILL.md` (YAML frontmatter `name` and `description`, then
instructions) and, where needed, `references/` that the agent reads only when the task calls for it.

## Install

With the [skills CLI](https://github.com/vercel-labs/skills), which detects your agents and installs
into each:

```bash
npx skills add aveetechapp/avee-skills                               # pick skills and agents interactively
npx skills add aveetechapp/avee-skills --list                        # show the skills in this repo
npx skills add aveetechapp/avee-skills --skill astra-oracle -a claude-code -g -y
```

`-g` installs for your user instead of the current project.

### By hand

Copy the skill folders you want into your agent's skills directory:

```bash
git clone https://github.com/aveetechapp/avee-skills
mkdir -p ~/.claude/skills && cp -R avee-skills/skills/* ~/.claude/skills/
```

| Agent | Project directory | User directory |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Cursor | `.agents/skills/` | `~/.cursor/skills/` |
| Codex | `.agents/skills/` | `~/.codex/skills/` |
| Gemini CLI | `.agents/skills/` | `~/.gemini/skills/` |
| GitHub Copilot | `.agents/skills/` | `~/.copilot/skills/` |
| Windsurf | `.windsurf/skills/` | `~/.codeium/windsurf/skills/` |

Claude Code picks up a new skill in the next session; ask "what skills are available?" to check.
For claude.ai, upload a skill folder as a zip under Settings → Capabilities → Skills.

Skills teach the agent how to call avee; for tool access without HTTP code, also connect the MCP
server (see [`avee-mcp`](skills/avee-mcp/SKILL.md)).

## Hosts

The skills point at these hosts, taken from `names.json`; today they are the preview hosts, which serve the current contracts:

- data API `https://api.preview.avee.tech/api/v1`
- Astra `https://astra.preview.avee.tech`
- MCP `https://mcp.preview.avee.tech/mcp`
- docs https://docs.preview.avee.tech

## Maintaining

Public names and hosts live only in `names.json`. To change one, edit it and run
`node scripts/rename.mjs`, which rewrites every file and records what it applied in
`names.lock.json`.

```bash
node scripts/validate.mjs      # frontmatter, links, hosts, names applied, skills.lock
node scripts/sync-check.mjs    # routes and tools named in the skills exist in the current contracts
node --test scripts/scripts.test.mjs   # the scripts themselves, on fixture packs
```

Skill names are the public surface: installs and agent prompts refer to them. `skills.lock` lists
every published name, one per line, and only grows: `validate.mjs` fails when a listed skill's folder
is gone and when a folder is not listed yet. Retire a skill by keeping its folder and saying so in
its description, never by deleting or renaming it.

`sync-check.mjs` reads the contracts from the avee source tree (`--api-spec`, `--tools`,
`--astra-spec`, or the matching `*_SPEC` environment variables) and fails on drift: a route or tool the skills
name that no longer exists, or a route or tool the contracts added that the references do not list.
It reads a YAML contract with the `yaml` package from `client-sdk/node` (`npm ci` there first). It runs where the sources are; the public mirror runs `validate.mjs`.

## License

MIT, see [LICENSE](LICENSE).
