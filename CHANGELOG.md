# Changelog

## 2.0.0

### Breaking
- MCP is now the only interface. The HTTP endpoints `/context`, `/command`, `/propose-change` and the WebSocket API are removed; `writeFile`, `deleteFile`, `acceptProposal` and `rejectProposal` commands are gone with them.
- The MCP endpoint requires `Authorization: Bearer <token>`. The token is stored in `~/.vscode-context-bridge/token`; copy it with **Editor Relay: Copy Auth Token**.
- Server binds to `127.0.0.1` only and sends no CORS headers.
- Requires VS Code 1.101 or newer.

### Added
- MCP server at `POST /mcp`, auto-registered with VS Code's MCP support, with 20 tools:
  - Editor: `get_context`, `open_file`, `select_text`, `show_notification`, `propose_change`
  - Code intelligence: `go_to_definition`, `find_references`, `hover_info`, `document_symbols`, `workspace_symbol_search`
  - Fixes & refactors: `get_diagnostics`, `get_code_actions`, `apply_code_action`, `rename_symbol` (shown as a diff the user accepts or rejects)
  - Terminal & tasks: `run_in_terminal` (asks for confirmation), `list_tasks`, `run_task`
  - Git & debug: `git_status`, `get_breakpoints`, `get_debug_state`
- Context now includes `workspaceFolders`, `activeNotebook` and `terminalCommands` (toggle via `shareTerminalOutput`); notebook tabs are listed in `openTabs`.

### Added (development)
- Integration tests that drive every MCP tool in a real VS Code instance (`bun run test`); verified against VS Code 1.101 and 1.140.

### Fixed
- `ignoreFiles` is applied consistently (case-insensitive substring) to every context field and tool.
- `openTabs[].isDirty` reflects unsaved state instead of whether the tab is active.
- Settings changes take effect immediately without reloading the window.
- Default port fallback is 3210 everywhere.
- Change-proposal diffs no longer write temporary files into the workspace `.vscode` folder.
- Event listeners are disposed on deactivation.

## 1.0.1
- Initial Marketplace release.
