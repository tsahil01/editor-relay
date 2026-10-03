# Editor Relay

```sh
code --install-extension SahilTiwaskar.vscode-context-bridge
```

The extension runs a local [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server inside VS Code. AI agents like Claude Code, GitHub Copilot or any other MCP client can use it to see what you're working on, and to use VS Code's language servers, terminal, tasks, git and debugger.

## Table of Contents
- [Features](#features)
- [Installation](#installation)
- [Connecting an MCP Client](#connecting-an-mcp-client)
- [Tools](#tools)
- [Examples](#examples)
- [Configuration](#configuration)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

## Features

- **Editor context**: Active file, selection, open tabs, notebooks, workspace folders, git diffs, diagnostics and recent terminal output
- **Code intelligence**: Go to definition, find references, hover info and symbol search, powered by whichever language servers you have installed
- **Fixes & refactors**: Quick fixes, code actions and project-wide renames, shown as a diff you accept or reject
- **Change proposals**: Agents propose edits as a diff you accept or reject
- **Terminal & tasks**: Run commands in a visible terminal (after you confirm) and run tasks from `tasks.json` or package scripts
- **Git & debug**: Branch and change status, breakpoints, and call stack and variables while paused
- **Private by default**: Listens on `127.0.0.1` only, requires a token, and respects `ignoreFiles`

## Installation

### Prerequisites

- Visual Studio Code 1.101.0 or higher
- [Bun](https://bun.sh) 1.1.39 or higher (for building from source)

### Building from Source

```bash
git clone https://github.com/tsahil01/vscode-context-bridge
cd vscode-context-bridge
bun install
bun run compile   # typecheck + bundle into dist/extension.js
bun run package   # produce a .vsix
bun run test      # integration tests in a throwaway VS Code (set VSCODE_TEST_VERSION to pick a version)
```

Install the `.vsix` via **Extensions: Install from VSIX** in the command palette, or try it without installing via `code --extensionDevelopmentPath=$PWD`.

## Connecting an MCP Client

The server starts automatically on `http://127.0.0.1:3210/mcp` (Streamable HTTP). Every request needs the auth token, which the extension creates on first run at `~/.vscode-context-bridge/token`. Run **Editor Relay: Copy Auth Token** to copy it.

- **VS Code (Copilot agent mode)**: registered automatically while the server is running.
- **Claude Code**:
  ```bash
  claude mcp add --transport http editor-relay http://127.0.0.1:3210/mcp \
    --header "Authorization: Bearer $(cat ~/.vscode-context-bridge/token)"
  ```
- **Other clients**: point them at `http://127.0.0.1:3210/mcp` with the header `Authorization: Bearer <token>`.

`GET /health` is the only unauthenticated endpoint.

## Tools

Line and character positions are **0-based** everywhere. Tools that take a position accept `filePath` and `line`, plus either `symbol` (the name on that line, used to find the column) or `character`.

### Editor

| Tool | Description |
| --- | --- |
| `get_context` | Workspace folders, active file and selection, active notebook, open tabs, git diffs, diagnostics, recent terminal commands |
| `open_file` | Open a file in the editor |
| `select_text` | Select a range in the active editor |
| `show_notification` | Show an info, warning or error notification |
| `propose_change` | Show a diff of proposed edits and wait for the user to accept or reject it |

### Code intelligence

| Tool | Description |
| --- | --- |
| `go_to_definition` | Where the symbol at a position is defined |
| `find_references` | All references to the symbol at a position |
| `hover_info` | Type information and docs for the symbol at a position |
| `document_symbols` | Outline of the classes, functions and variables in a file |
| `workspace_symbol_search` | Find symbols by name across the workspace |

### Fixes & refactors

| Tool | Description |
| --- | --- |
| `get_diagnostics` | Errors and warnings, optionally for one file and above a minimum severity |
| `get_code_actions` | Quick fixes and refactorings available for a line range |
| `apply_code_action` | Apply one of them by title; you review the diff and accept or reject it |
| `rename_symbol` | Rename a symbol across the workspace; you review the diff and accept or reject it |

### Terminal & tasks

| Tool | Description |
| --- | --- |
| `run_in_terminal` | Run a command in a visible terminal after the user confirms; returns output and exit code |
| `list_tasks` | Tasks from `tasks.json`, package scripts and extensions |
| `run_task` | Run a task by name and wait for its exit code |

### Git & debug

| Tool | Description |
| --- | --- |
| `git_status` | Branch, upstream, ahead/behind, and staged, unstaged, untracked and conflicted files |
| `get_breakpoints` | Breakpoints currently set |
| `get_debug_state` | Active debug session; when paused, the call stack and current frame's variables |

## Examples

### What you can ask your agent

| You say | Tools the agent uses |
| --- | --- |
| "Fix the error I'm looking at" | `get_context` → `get_code_actions` → `apply_code_action` (you review the diff) |
| "Who calls this function?" | `get_context` → `find_references` |
| "Rename `getUser` to `fetchUser` everywhere" | `rename_symbol` (you review the diff) |
| "Why did my last command fail?" | `get_context` (terminal output and exit code) |
| "Run the tests" | `list_tasks` → `run_task` |
| "I'm paused at a breakpoint, why is `total` NaN?" | `get_debug_state` |
| "What's uncommitted?" | `git_status` |

### Tool calls

Example calls against the test fixture project (paths shortened, responses abridged).

**`hover_info`** for `add` on line 2 of `src/main.ts`:

```json
// arguments
{ "filePath": "/project/src/main.ts", "line": 2, "symbol": "add" }

// result
{ "contents": ["```typescript\n(alias) add(a: number, b: number): number\nimport add\n```"] }
```

**`find_references`**:

```json
// arguments
{ "filePath": "/project/src/math.ts", "line": 0, "symbol": "add" }

// result
{
  "total": 3,
  "locations": [
    { "filePath": "/project/src/math.ts", "range": { "start": { "line": 0, "character": 16 }, "end": { "line": 0, "character": 19 } }, "preview": "export function add(a: number, b: number): number {" },
    { "filePath": "/project/src/main.ts", "range": { "start": { "line": 0, "character": 9 }, "end": { "line": 0, "character": 12 } }, "preview": "import { add } from './math';" },
    { "filePath": "/project/src/main.ts", "range": { "start": { "line": 2, "character": 21 }, "end": { "line": 2, "character": 24 } }, "preview": "export const total = add(1, 2);" }
  ]
}
```

**`get_diagnostics`**:

```json
// arguments
{ "filePath": "/project/src/main.ts", "minSeverity": "error" }

// result
[{
  "filePath": "/project/src/main.ts",
  "fileName": "main.ts",
  "diagnostics": [{
    "message": "Cannot find name 'multiply'.",
    "severity": "error",
    "range": { "start": { "line": 3, "character": 23 }, "end": { "line": 3, "character": 31 } },
    "source": "ts",
    "code": 2304
  }]
}]
```

**`rename_symbol`**, after you click **Accept Changes** in the diff:

```json
// arguments
{ "filePath": "/project/src/rename.ts", "line": 0, "symbol": "greet", "newName": "welcome" }

// result
{ "applied": true, "files": ["/project/src/rename.ts"], "edits": 2 }
```

**`run_in_terminal`**, after you click **Run**:

```json
// arguments
{ "command": "echo bridge-ok" }

// result
{ "ran": true, "exitCode": 0, "output": "bridge-ok\r\n" }
```

**`git_status`**:

```json
{
  "repositories": [{
    "root": "/project",
    "branch": "main",
    "commit": "3f2c1ab…",
    "upstream": null,
    "ahead": null,
    "behind": null,
    "staged": [{ "filePath": "/project/staged.txt", "status": "INDEX_MODIFIED" }],
    "unstaged": [{ "filePath": "/project/notes.txt", "status": "MODIFIED" }],
    "untracked": [{ "filePath": "/project/new.txt", "status": "UNTRACKED" }],
    "conflicts": []
  }]
}
```

**`get_debug_state`** while paused at a `debugger;` statement:

```json
{
  "active": true,
  "name": "fixture",
  "type": "pwa-node",
  "paused": true,
  "threadId": 0,
  "stackFrames": [{ "id": 1, "name": "<anonymous>", "filePath": "/project/debug/app.js", "line": 5 }],
  "currentFrameId": 1,
  "variables": [{ "scope": "Local", "variables": [{ "name": "total", "value": "6", "type": "number" }] }]
}
```

## Configuration

Open settings and search for `Editor Relay`, or click the `Editor Relay` status bar item.

| Setting | Default | Description |
| --- | --- | --- |
| `vscodeContextBridge.port` | `3210` | Port the server listens on (always `127.0.0.1`) |
| `vscodeContextBridge.shareDiagnostics` | `true` | Share diagnostics (`get_context`, `get_diagnostics`) |
| `vscodeContextBridge.shareDiffs` | `true` | Include git working-tree diffs in `get_context` |
| `vscodeContextBridge.shareTerminalOutput` | `true` | Include recent terminal commands and output in `get_context` |
| `vscodeContextBridge.ignoreFiles` | `["node_modules", ".env"]` | Case-insensitive substrings; matching paths are never shared or accepted as tool input |

## Security

1. **Token auth**: Every MCP request needs the token in `~/.vscode-context-bridge/token` (readable only by your user). Treat it like a password. To rotate it, delete the file and reload VS Code.
2. **Local only**: The server listens on `127.0.0.1` and sends no CORS headers, so web pages can't call it.
3. **You stay in control**: `propose_change`, `apply_code_action` and `rename_symbol` only change files after you approve them. `run_in_terminal` asks before running anything.
4. **Information sharing**: Use the `share*` settings and `ignoreFiles` to limit what is exposed. Terminal output can contain secrets; turn off `shareTerminalOutput` if that's a concern.

## Troubleshooting

1. **Port already in use**: Change the port in settings. Only one VS Code window can own a port at a time.
2. **401 Unauthorized**: Send the token from `~/.vscode-context-bridge/token` as `Authorization: Bearer <token>`.
3. **Connection refused**: Make sure the server is running (status bar item or **Editor Relay: Start Editor Relay Server**).
4. **No terminal output**: Terminal shell integration must be enabled (`terminal.integrated.shellIntegration.enabled`).
5. **Empty code intelligence results**: The file's language needs a language server or extension installed in VS Code.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes and run `bun run test`
4. Submit a pull request

## License

This project is licensed under the ISC License - see the LICENSE file for details.

## Support

For issues and feature requests, please use the GitHub issue tracker.
