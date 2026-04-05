# React Forge (MCP Server Extension for Zed)

React Forge is a Model Context Protocol (MCP) server packaged as a Zed extension. It helps you scaffold and maintain component ecosystems in React projects with a plan-first workflow.

The recommended install method is via Zed’s Extensions UI. The source code is public for transparency and contributions, but end users should install through Zed rather than cloning the repository.

## Core Features

- Plan scaffolding for a component (tests, stories, barrel exports)
- Apply the plan and return per-action statuses
- Estimate impact using a local import graph (direct and transitive dependents)

## Installation

### Zed Extensions

Install the extension from Zed (Extensions view). After installation, go to Agent Panel → Settings → Context Servers and ensure `react-forge` shows “Server is active”.

### Local Development

Use Zed: Extensions → Install Dev Extension, then select this repository folder.

## Using the Tools

In the Agent chat, ask the model to call a tool by name and provide arguments. Examples below are shown as structured input; paste them into chat and adjust paths.

Plan only (dry run):

```text
Call react_forge_ecosystem_plan with:
projectRoot: "E:\\path\\to\\my-app"
componentFile: "src/components/Button.tsx"
exportName: "Button"
barrelFile: "src/components/index.ts"
include: { test: true, story: true, barrel: true }
computeImpact: true
dryRun: true
```

Apply changes:

```text
Call react_forge_ecosystem_plan with the same arguments, but set dryRun: false. Return the applied array.
```

## Available Tools

- `react_forge_ecosystem_plan`: plans scaffolding, optionally applies it (`dryRun: false`), returns impact by default
- `react_forge_find_dependents`: returns direct and transitive dependents for a file within a project root
- `react_forge_list_source_files`: lists JS/TS source files under a project root (with ignores and limits)
- `react_forge_file_imports`: shows relative imports in a file and their resolved targets
- `react_forge_import_graph_stats`: returns import graph stats (file count, edge count, ignored directories)

## Configuration (Optional)

React Forge does not require configuration. Zed exposes optional settings:

- `logLevel`: `"off"` or `"debug"`
- `ignoredDirNames`: extra directory names to ignore during scans
- `maxResults`: default cap for dependent graph results
- `impactMaxResults`: cap used for impact computation

## Development

```bash
cargo fmt --check
cargo check
cargo clippy -- -D warnings
```