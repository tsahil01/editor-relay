import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ContextProvider } from '../provider/contextProvider';
import * as language from '../tools/language';
import * as terminal from '../tools/terminal';
import { gitStatus } from '../tools/git';
import { getBreakpoints, getDebugState } from '../tools/debug';

const SEVERITIES = ['error', 'warning', 'info', 'hint'] as const;

async function respond(fn: () => Promise<unknown> | unknown) {
    try {
        const value: any = await fn();
        const isError = value && typeof value === 'object' && value.success === false;
        return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError: isError || undefined };
    } catch (error) {
        return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
}

const filePath = z.string().describe('Absolute file path');
const line = z.number().int().min(0).describe('0-based line number');
const position = {
    filePath,
    line,
    symbol: z.string().optional().describe('Name of the symbol on that line; used to find the column'),
    character: z.number().int().min(0).optional().describe('0-based column; overrides symbol'),
};
const readOnly = { readOnlyHint: true, openWorldHint: false };

export function createMcpServer(contextProvider: ContextProvider, version: string): McpServer {
    const server = new McpServer({ name: 'editor-relay', version });

    server.registerTool('get_context', {
        description: 'Get the current VS Code editor context: workspace folders, active file and selection, active notebook, open tabs, git diffs, diagnostics and recent terminal commands. All line numbers are 0-based.',
        annotations: readOnly,
    }, () => respond(() => contextProvider.getContext()));

    server.registerTool('open_file', {
        description: 'Open a file in the VS Code editor.',
        inputSchema: { filePath },
    }, ({ filePath }) => respond(() => contextProvider.openFile(filePath)));

    server.registerTool('select_text', {
        description: 'Select a range in the active editor (0-based lines and characters).',
        inputSchema: {
            startLine: z.number().int(),
            startCharacter: z.number().int(),
            endLine: z.number().int(),
            endCharacter: z.number().int(),
        },
    }, ({ startLine, startCharacter, endLine, endCharacter }) =>
        respond(() => contextProvider.selectText(startLine, startCharacter, endLine, endCharacter)));

    server.registerTool('show_notification', {
        description: 'Show a notification to the user in VS Code.',
        inputSchema: {
            message: z.string(),
            type: z.enum(['info', 'warning', 'error']).default('info'),
        },
    }, ({ message, type }) => respond(() => contextProvider.showNotification(message, type)));

    server.registerTool('propose_change', {
        description: 'Show the user a diff of proposed edits to a file and wait for them to accept or reject it. Each change replaces the first exact occurrence of originalContent with proposedContent.',
        inputSchema: {
            title: z.string(),
            filePath,
            changes: z.array(z.object({
                originalContent: z.string(),
                proposedContent: z.string(),
                description: z.string().optional(),
            })).min(1),
        },
    }, (request) => respond(() => contextProvider.proposeChange(request)));

    server.registerTool('get_diagnostics', {
        description: 'Get errors, warnings and hints reported by VS Code language servers and linters, at or above a minimum severity. Language servers usually only check open files; pass filePath to load and check a specific file.',
        inputSchema: {
            filePath: filePath.optional(),
            minSeverity: z.enum(SEVERITIES).default('hint'),
        },
        annotations: readOnly,
    }, ({ filePath, minSeverity }) => respond(async () => {
        if (filePath) {
            await language.loadDiagnostics(filePath);
        }
        const all = await contextProvider.getDiagnosticsInfo();
        if (all === null) {
            throw new Error('Diagnostics sharing is disabled in the Editor Relay settings');
        }
        const maxRank = SEVERITIES.indexOf(minSeverity);
        return all
            .filter(file => !filePath || file.filePath === filePath)
            .map(file => ({ ...file, diagnostics: file.diagnostics.filter(d => SEVERITIES.indexOf(d.severity) <= maxRank) }))
            .filter(file => file.diagnostics.length > 0);
    }));

    server.registerTool('go_to_definition', {
        description: 'Find where the symbol at a position is defined, using VS Code language servers.',
        inputSchema: position,
        annotations: readOnly,
    }, (args) => respond(() => language.goToDefinition(args)));

    server.registerTool('find_references', {
        description: 'Find all references to the symbol at a position across the workspace.',
        inputSchema: position,
        annotations: readOnly,
    }, (args) => respond(() => language.findReferences(args)));

    server.registerTool('hover_info', {
        description: 'Get type information and documentation for the symbol at a position (what VS Code shows on hover).',
        inputSchema: position,
        annotations: readOnly,
    }, (args) => respond(() => language.hoverInfo(args)));

    server.registerTool('document_symbols', {
        description: 'List the classes, functions, variables and other symbols in a file as an outline tree.',
        inputSchema: { filePath },
        annotations: readOnly,
    }, ({ filePath }) => respond(() => language.documentSymbols(filePath)));

    server.registerTool('workspace_symbol_search', {
        description: 'Search for symbols (classes, functions, etc.) by name across the whole workspace.',
        inputSchema: { query: z.string().min(1) },
        annotations: readOnly,
    }, ({ query }) => respond(() => language.workspaceSymbols(query)));

    server.registerTool('get_code_actions', {
        description: 'List quick fixes and refactorings VS Code offers for a line range (e.g. fixes for diagnostics, organize imports).',
        inputSchema: { filePath, startLine: line, endLine: line.optional() },
        annotations: readOnly,
    }, ({ filePath, startLine, endLine }) => respond(() => language.getCodeActions(filePath, startLine, endLine)));

    server.registerTool('apply_code_action', {
        description: 'Apply a code action returned by get_code_actions (matched by exact title). The user reviews the resulting diff and accepts or rejects it.',
        inputSchema: { filePath, title: z.string(), startLine: line, endLine: line.optional() },
    }, ({ filePath, title, startLine, endLine }) => respond(() => language.applyCodeAction(filePath, title, startLine, endLine)));

    server.registerTool('rename_symbol', {
        description: 'Rename the symbol at a position across the workspace using the language server. The user reviews the resulting diff and accepts or rejects it.',
        inputSchema: { ...position, newName: z.string().min(1) },
    }, (args) => respond(() => language.renameSymbol(args)));

    server.registerTool('run_in_terminal', {
        description: 'Run a shell command in a visible VS Code terminal after the user confirms, and return its output and exit code.',
        inputSchema: {
            command: z.string().min(1),
            cwd: z.string().optional().describe('Absolute working directory'),
            timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
        },
        annotations: { destructiveHint: true, openWorldHint: true },
    }, ({ command, cwd, timeoutMs }) => respond(() => terminal.runInTerminal(command, cwd, timeoutMs)));

    server.registerTool('list_tasks', {
        description: 'List the tasks VS Code can run (tasks.json, package.json scripts, and tasks contributed by extensions).',
        annotations: readOnly,
    }, () => respond(() => terminal.listTasks()));

    server.registerTool('run_task', {
        description: 'Run a VS Code task by name and wait for its exit code. Background tasks return once started.',
        inputSchema: {
            name: z.string(),
            source: z.string().optional().describe('Task source from list_tasks, needed when names collide'),
            timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
        },
    }, ({ name, source, timeoutMs }) => respond(() => terminal.runTask(name, source, timeoutMs)));

    server.registerTool('git_status', {
        description: 'Get git branch, upstream, ahead/behind counts and staged, unstaged, untracked and conflicted files for each repository in the workspace.',
        annotations: readOnly,
    }, () => respond(() => gitStatus()));

    server.registerTool('get_breakpoints', {
        description: 'List breakpoints set in VS Code.',
        annotations: readOnly,
    }, () => respond(() => getBreakpoints()));

    server.registerTool('get_debug_state', {
        description: 'Get the active debug session; when paused, includes the call stack and the variables of the current frame.',
        annotations: readOnly,
    }, () => respond(() => getDebugState()));

    return server;
}
