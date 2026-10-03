import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const PORT = 38999;
const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
const file = (relative: string) => path.join(workspace, relative);
const read = (relative: string) => fs.readFileSync(file(relative), 'utf8');
let token = '';

async function rpc(method: string, params: object, auth = true) {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(auth ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    const data = text.split('\n').find(l => l.startsWith('data:'));
    return { status: res.status, body: JSON.parse(data ? data.slice(5) : text) };
}

async function callTool(name: string, args: object = {}) {
    const { body } = await rpc('tools/call', { name, arguments: args });
    assert.ok(!body.error, `${name} failed: ${JSON.stringify(body.error)}`);
    const text: string = body.result.content[0].text;
    return { isError: !!body.result.isError, text, json: () => JSON.parse(text) };
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const value = await fn();
            if (value) {
                return value;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError}` : ''}`);
}

// Stands in for the user clicking through a notification or the refactor preview while a tool call is pending.
async function whilePending<T>(promise: Promise<T>, ...commands: string[]): Promise<T> {
    let settled = false;
    promise.finally(() => { settled = true; }).catch(() => undefined);
    while (!settled) {
        await new Promise(r => setTimeout(r, 500));
        for (const command of commands) {
            if (!settled) {
                await vscode.commands.executeCommand(command).then(undefined, () => undefined);
            }
        }
    }
    return promise;
}
const acceptNotification = ['notifications.focusFirstToast', 'notification.acceptPrimaryAction'];

before(async function () {
    // The first document open waits for the workbench and TypeScript to start, which can take well over a minute on CI.
    this.timeout(180_000);
    await waitFor(() => fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.ok), 'server to start', 120_000);
    token = fs.readFileSync(path.join(os.homedir(), '.vscode-context-bridge', 'token'), 'utf8').trim();
    await vscode.workspace.openTextDocument(file('src/math.ts'));
});

describe('MCP server', () => {
    it('rejects requests without the token', async () => {
        assert.strictEqual((await rpc('tools/list', {}, false)).status, 401);
    });

    it('lists all tools', async () => {
        const { body } = await rpc('tools/list', {});
        assert.strictEqual(body.result.tools.length, 20);
    });

    it('refuses files matched by ignoreFiles', async () => {
        const result = await callTool('document_symbols', { filePath: file('.env') });
        assert.ok(result.isError);
        assert.match(result.text, /ignoreFiles/);
    });
});

describe('editor tools', () => {
    it('opens a file, selects text and reports it in get_context', async () => {
        assert.ok(!(await callTool('open_file', { filePath: file('src/math.ts') })).isError);
        assert.ok(!(await callTool('select_text', { startLine: 0, startCharacter: 16, endLine: 0, endCharacter: 19 })).isError);
        const context = (await callTool('get_context')).json();
        assert.strictEqual(context.activeFile.name, 'math.ts');
        assert.strictEqual(context.textSelection.text, 'add');
        assert.strictEqual(fs.realpathSync(context.workspaceFolders[0].path), fs.realpathSync(workspace));
        assert.ok(context.openTabs.some((t: any) => t.name === 'math.ts'));
    });

    it('applies an accepted change proposal', async () => {
        const result = await whilePending(callTool('propose_change', {
            title: 'Fix answer',
            filePath: file('src/proposal.ts'),
            changes: [{ originalContent: 'answer = 41', proposedContent: 'answer = 42' }],
        }), ...acceptNotification);
        assert.strictEqual(result.json().accepted, true, result.text);
        assert.match(read('src/proposal.ts'), /answer = 42/);
    });
});

describe('code intelligence tools', () => {
    it('loads a closed file to report its diagnostics', async () => {
        const files = (await callTool('get_diagnostics', { filePath: file('src/main.ts'), minSeverity: 'error' })).json();
        assert.strictEqual(files.length, 1, JSON.stringify(files));
        assert.match(files[0].diagnostics[0].message, /Cannot find name 'multiply'/);
    });

    it('lists document symbols', async () => {
        const { symbols } = await waitFor(async () => {
            const result = (await callTool('document_symbols', { filePath: file('src/math.ts') })).json();
            return result.symbols.length > 0 && result;
        }, 'document symbols');
        assert.deepStrictEqual(symbols.map((s: any) => s.name).sort(), ['add', 'multiply']);
        assert.strictEqual(symbols[0].kind, 'Function');
    });

    it('returns hover info for a symbol', async () => {
        const { contents } = (await callTool('hover_info', { filePath: file('src/main.ts'), line: 2, symbol: 'add' })).json();
        assert.match(contents.join('\n'), /add\(a: number, b: number\): number/);
    });

    it('goes to a definition', async () => {
        const { locations } = (await callTool('go_to_definition', { filePath: file('src/main.ts'), line: 2, symbol: 'add' })).json();
        assert.ok(locations[0].filePath.endsWith(path.join('src', 'math.ts')));
        assert.strictEqual(locations[0].range.start.line, 0);
    });

    it('finds references across files', async () => {
        const { locations } = (await callTool('find_references', { filePath: file('src/math.ts'), line: 0, symbol: 'add' })).json();
        assert.ok(locations.some((l: any) => l.filePath.endsWith('main.ts') && l.preview === 'export const total = add(1, 2);'));
    });

    it('searches workspace symbols', async () => {
        const { symbols } = await waitFor(async () => {
            const result = (await callTool('workspace_symbol_search', { query: 'multiply' })).json();
            return result.symbols.length > 0 && result;
        }, 'workspace symbols');
        assert.ok(symbols.some((s: any) => s.name.startsWith('multiply') && s.filePath.endsWith('math.ts')), JSON.stringify(symbols));
    });

    it('rejects out-of-range positions', async () => {
        const result = await callTool('hover_info', { filePath: file('src/main.ts'), line: 99 });
        assert.ok(result.isError);
        assert.match(result.text, /out of range/);
    });
});

describe('fix and refactor tools', () => {
    it('applies a reviewed quick fix', async () => {
        const args = { filePath: file('src/main.ts'), startLine: 3 };
        const { actions } = (await callTool('get_code_actions', args)).json();
        const fix = actions.find((a: any) => /import.*math/i.test(a.title));
        assert.ok(fix, `no import fix in ${JSON.stringify(actions)}`);
        const result = await whilePending(callTool('apply_code_action', { ...args, title: fix.title }), ...acceptNotification);
        assert.strictEqual(result.json().applied, true, result.text);
        assert.match(read('src/main.ts'), /import \{ add, multiply \} from '\.\/math'|import \{ multiply \} from '\.\/math'/);
    });

    it('renames a symbol after review', async () => {
        const result = await whilePending(callTool('rename_symbol', {
            filePath: file('src/rename.ts'), line: 0, symbol: 'greet', newName: 'welcome',
        }), ...acceptNotification);
        assert.strictEqual(result.json().applied, true, result.text);
        const content = read('src/rename.ts');
        assert.doesNotMatch(content, /greet/);
        assert.strictEqual(content.match(/welcome/g)?.length, 2);
    });
});

describe('terminal and task tools', () => {
    it('runs a command after the user confirms', async () => {
        const result = await whilePending(callTool('run_in_terminal', { command: 'echo bridge-ok', timeoutMs: 30_000 }), ...acceptNotification);
        const value = result.json();
        assert.strictEqual(value.ran, true, result.text);
        assert.strictEqual(value.exitCode, 0, result.text);
        assert.match(value.output, /bridge-ok/);
    });

    it('does not run a command the user cancels', async () => {
        const result = await whilePending(callTool('run_in_terminal', { command: 'echo never' }), 'notifications.clearAll');
        assert.strictEqual(result.json().ran, false);
    });

    it('records terminal commands in get_context', async () => {
        const context = (await callTool('get_context')).json();
        assert.ok(context.terminalCommands.some((c: any) => c.commandLine.includes('echo bridge-ok') && /bridge-ok/.test(c.output)));
    });

    it('lists and runs tasks', async () => {
        const { tasks } = (await callTool('list_tasks')).json();
        assert.ok(tasks.some((t: any) => t.name === 'pass') && tasks.some((t: any) => t.name === 'fail'));
        assert.strictEqual((await callTool('run_task', { name: 'pass', source: 'Workspace' })).json().exitCode, 0);
        assert.strictEqual((await callTool('run_task', { name: 'fail', source: 'Workspace' })).json().exitCode, 3);
    });
});

describe('git and debug tools', () => {
    it('reports git status', async () => {
        const { repositories } = await waitFor(async () => {
            const result = (await callTool('git_status')).json();
            return result.repositories.length > 0 && result;
        }, 'git repository');
        const repo = repositories[0];
        const names = (changes: any[]) => changes.map(c => path.basename(c.filePath));
        assert.strictEqual(fs.realpathSync(repo.root), fs.realpathSync(workspace));
        assert.ok(repo.branch);
        assert.ok(names(repo.staged).includes('staged.txt'), JSON.stringify(repo));
        assert.ok(names(repo.unstaged).includes('notes.txt'), JSON.stringify(repo));
        assert.ok(names(repo.untracked).includes('new.txt'), JSON.stringify(repo));
    });

    it('lists breakpoints', async () => {
        const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file('debug/app.js')), new vscode.Position(3, 0)), true, 'item > 1');
        vscode.debug.addBreakpoints([breakpoint]);
        try {
            const { breakpoints } = (await callTool('get_breakpoints')).json();
            assert.ok(breakpoints.some((b: any) => b.filePath.endsWith('app.js') && b.line === 3 && b.condition === 'item > 1'));
        } finally {
            vscode.debug.removeBreakpoints([breakpoint]);
        }
    });

    it('reports the paused debug session with variables', async () => {
        assert.deepStrictEqual((await callTool('get_debug_state')).json(), { active: false });
        await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
            type: 'node', request: 'launch', name: 'fixture', program: file('debug/app.js'), console: 'internalConsole',
        });
        try {
            await waitFor(async () => vscode.debug.activeStackItem instanceof vscode.DebugStackFrame, 'debugger to pause');
            const state = (await callTool('get_debug_state')).json();
            assert.strictEqual(state.paused, true, JSON.stringify(state));
            assert.ok(state.stackFrames[0].filePath.endsWith('app.js'));
            assert.strictEqual(state.stackFrames[0].line, 5);
            const variables = state.variables.flatMap((s: any) => s.variables);
            assert.ok(variables.some((v: any) => v.name === 'total' && v.value === '6'), JSON.stringify(state.variables));
        } finally {
            await vscode.debug.stopDebugging();
        }
    });
});
