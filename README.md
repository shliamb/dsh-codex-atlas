# dsh-codex-atlas — Atlas for DSH

**English** | [Русский](README.ru.md)

**Spec-Driven Development for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a single project map, strict local specifications, and a unified journal.**

The plugin gives both the agent and the human a single source of truth about the project architecture without forcing them to read the entire codebase. Only `MEMORY.md` is injected into the System Prompt; `JOURNAL.md` is never injected. Everything related to a specific module lives right next to the module in `SPEC.md`.

## Features

- **Less context.** The agent sees a short project map, not the whole codebase.
- **Predictable changes.** Before editing code, the agent must read the module's `SPEC.md`.
- **Up-to-date contracts.** Changes in logic or data formats are recorded in `SPEC.md` during the same session.
- **Noise-free history.** `JOURNAL.md` grows append-only and doesn't consume System Prompt tokens.
- **Safe migration.** An old `MEMORY.md` from another plugin is not overwritten silently.

## Project Files

| File | Location | Role | In System Prompt |
|---|---|---|---|
| `MEMORY.md` | project root | Map: overview, modules, scenarios, roadmap, rules, style | Yes, up to 6000 chars |
| `SPEC.md` | each module's folder | Static module specification | No; read on demand |
| `JOURNAL.md` | project root | Append-only session journal | No, never |

The `MEMORY.md` structure is strictly fixed:

```md
# MEMORY.md — Atlas

## Overview
## Modules
## Scenarios
## Roadmap
## Rules
## User Style
```

`SPEC.md` also has fixed sections:

```md
## Purpose
## Input Data
## Output Data
## Logic (Variations)
## Error Handling
```

`JOURNAL.md` contains only entries in this format:

```md
[2026-10-28 16:10] [auth] Added JWT validation
```

## Tools

| Tool | Arguments | Description |
|---|---|---|
| `update_memory` | no args | Reads `MEMORY.md` |
| | `section`, `content`, `mode` | Replaces a section (`replace`) or appends to it (`append`) |
| | `module`, `spec`, `summary` | Adds a module to `## Modules`; `spec` must exist |
| `update_spec` | `module` | Reads the module's `SPEC.md` |
| | `module`, `section`, `content`, `mode` | Modifies a section; creates `SPEC.md` from a template if the file doesn't exist |
| `log_session` | `module`, `summary` | Appends a single line to `JOURNAL.md`; called at the end of the session |
| `sync_atlas` | `action: "check"` | Report only: file status, number of `SPEC.md` files, invalid specs |
| | `action: "init"` | Creates missing `MEMORY.md` and `JOURNAL.md` |
| | `action: "migrate"`, `confirm: true` | After user approval, backs up the old `MEMORY.md` to `.atlas/backup/`, adds missing headers while preserving the text |

`section` for `update_memory`: `overview`, `modules`, `scenarios`, `roadmap`, `rules`, `style`.
`section` for `update_spec`: `purpose`, `input`, `output`, `logic`, `errors`.

Usage examples:

```json
{ "section": "roadmap", "content": "- [x] Auth is complete", "mode": "append" }
```

```json
{ "module": "src/auth", "section": "input", "content": "`LoginRequest { email, password }`" }
```

```json
{ "module": "auth", "summary": "Added JWT validation" }
```

```json
{ "action": "migrate", "confirm": true }
```

## What the Agent Sees

The plugin injects a System Prompt section `dsh-codex-atlas:atlas` with the following rules:

> Study `MEMORY.md`. Follow the scenarios and rules. Before changing code, find the module and read its `SPEC.md`. Any change in logic or data formats MUST be recorded in `SPEC.md`. At the end of the session, call `log_session`. The file `JOURNAL.md` exists, but reading it without explicit necessity is forbidden.

If `MEMORY.md` is missing, the agent receives instructions to call `sync_atlas` with `action="init"`. If the file structure is foreign, the agent must stop and ask the user:

> I see an old memory file. May I scan the project, study the old files, and rewrite them according to the new Atlas structure?

Only after permission is granted, `sync_atlas` is called with `action="migrate"` and `confirm=true`: the old file is copied to `.atlas/backup/`, and missing canonical headers are added to the new one without losing the original text.

## Installation

### Option 1. From npm (Recommended)

```sh
dsh plugin --profile web add dsh-codex-atlas
```

### Option 2. From a Local Folder

```sh
cd /path/to/dsh-codex-atlas
dsh plugin --profile web add "$PWD"
```
*(Note: `lib/` is already committed to the repository, so `pnpm install` and `pnpm build` are not required just to use the plugin.)*

### Option 3. From Git Repository

```sh
dsh plugin --profile web add https://github.com/shliamb/dsh-codex-atlas.git
```

After installation, **restart `dsh web`**. The plugin is added to the `web` profile as a separate bundle-layer.

### Verification

1. Make sure the package is in your profile:
   ```sh
   grep -n "dsh-codex-atlas" ~/.dsh/profiles/web/package.json
   ```
2. Open a new session and ask the agent:
   > Check Atlas: call `sync_atlas` with `action="check"`.
3. In a newly created project, the agent will suggest `action="init"`. In a project with an old `MEMORY.md`, it will first ask for migration permission.

### Removal

```sh
dsh plugin --profile web remove dsh-codex-atlas
```
Restart `dsh web` after removal.

## Development

```sh
pnpm install
pnpm check        # tsc --noEmit
pnpm build        # tsc (d.ts) + tsdown (lib/index.js)
pnpm test         # builds lib/ and runs node:test smoke tests
```

`lib/` is committed to the repository: users don't need a local build, and `dsh plugin add` reads the ready-made `lib/index.js`.

Repository structure:

```text
dsh-codex-atlas/
├── src/
│   ├── index.ts        # the entire plugin
│   └── SPEC.md         # specification of this module
├── lib/
│   ├── index.js        # compiled runtime (committed)
│   └── types/index.d.ts
├── tests/
│   └── atlas.test.mjs  # node:test smoke tests
├── MEMORY.md           # map of the plugin itself
├── JOURNAL.md          # development journal of the plugin
├── cordis.patch.yml    # bundle patch for dsh plugin add
├── package.json
├── tsconfig.json
├── tsdown.config.ts
└── README.md
```

## Package Name

The package is named `dsh-codex-atlas`. The short name `dsh-codex` is already taken on npm by another DSH plugin (ChatGPT OAuth / Codex models), so this project uses the `-atlas` suffix. Local installation and `dsh plugin add` work with the current name without additional configuration.

## Privacy and Limitations

- **No network requests.** The plugin works only with local files via `node:fs`; child processes (including `git`) are not spawned.
- **Single working directory.** Files live in the root of the session's workspace and are not aggregated across projects.
- **System Prompt truncation.** No more than 6000 characters of `MEMORY.md` are injected into the context; if the map is longer, the agent reads the file in full using standard tools.
- **Concurrent sessions.** Two sessions in the same workspace may overwrite each other's changes: writing follows a last-write-wins principle.
- **Limited `sync_atlas` scan.** Up to 20,000 entries are scanned; `node_modules`, `.git`, `dist`, `lib`, `build`, and similar directories are skipped.
- **Journal auto-entry.** If the agent forgets to call `log_session`, the plugin will append one line with the `atlas` module when the top-level session ends. There is no auto-entry for subagent sessions.
- **`MEMORY.md` is not created "on read".** Use `sync_atlas` with `action="init"` for initial creation.

## License

[MIT](LICENSE)