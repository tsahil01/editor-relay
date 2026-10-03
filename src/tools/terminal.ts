import * as vscode from 'vscode';
import { appendOutput } from '../provider/terminalTracker';

const TERMINAL_NAME = 'Editor Relay';
const SHELL_INTEGRATION_WAIT_MS = 5000;

let terminal: vscode.Terminal | undefined;
let busy = false;

function waitFor<T>(event: vscode.Event<T>, predicate: (e: T) => boolean, timeoutMs: number): Promise<T | undefined> {
    return new Promise(resolve => {
        const timer = setTimeout(() => { sub.dispose(); resolve(undefined); }, timeoutMs);
        const sub = event(e => {
            if (predicate(e)) {
                clearTimeout(timer);
                sub.dispose();
                resolve(e);
            }
        });
    });
}

async function shellIntegrationFor(t: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
    if (t.shellIntegration) {
        return t.shellIntegration;
    }
    const e = await waitFor(vscode.window.onDidChangeTerminalShellIntegration, e => e.terminal === t, SHELL_INTEGRATION_WAIT_MS);
    return e?.shellIntegration;
}

export async function runInTerminal(command: string, cwd: string | undefined, timeoutMs: number) {
    const choice = await vscode.window.showWarningMessage(
        `An external tool wants to run: ${command}${cwd ? ` (in ${cwd})` : ''}`,
        'Run',
        'Cancel'
    );
    if (choice !== 'Run') {
        return { ran: false, message: 'The user declined to run the command' };
    }

    if (!terminal || terminal.exitStatus !== undefined || busy || cwd) {
        terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });
    }
    const t = terminal;
    t.show(true);

    const shellIntegration = await shellIntegrationFor(t);
    if (!shellIntegration) {
        t.sendText(command);
        return { ran: true, exitCode: null, output: null, message: 'Shell integration is unavailable, so output and exit code cannot be captured' };
    }

    busy = true;
    const execution = shellIntegration.executeCommand(command);
    let output = '';
    const reading = (async () => {
        for await (const chunk of execution.read()) {
            output = appendOutput(output, chunk);
        }
    })();
    const ended = await waitFor(vscode.window.onDidEndTerminalShellExecution, e => e.execution === execution, timeoutMs);
    if (!ended) {
        terminal = undefined;
        busy = false;
        return { ran: true, timedOut: true, exitCode: null, output, message: `Still running after ${timeoutMs}ms; left running in the "${TERMINAL_NAME}" terminal` };
    }
    busy = false;
    await reading;
    return { ran: true, exitCode: ended.exitCode ?? null, output };
}

export async function listTasks() {
    const tasks = await vscode.tasks.fetchTasks();
    return {
        tasks: tasks.map(t => ({
            name: t.name,
            source: t.source,
            type: t.definition.type,
            group: t.group?.id,
            detail: t.detail,
            isBackground: t.isBackground || undefined,
        })),
    };
}

export async function runTask(name: string, source: string | undefined, timeoutMs: number) {
    const matches = (await vscode.tasks.fetchTasks()).filter(t => t.name === name && (!source || t.source === source));
    if (matches.length === 0) {
        throw new Error(`No task named "${name}"${source ? ` from source "${source}"` : ''}; call list_tasks first`);
    }
    if (matches.length > 1) {
        throw new Error(`Several tasks are named "${name}"; pass source as one of: ${matches.map(t => t.source).join(', ')}`);
    }
    const task = matches[0];

    const endedExecutions = new Map<vscode.TaskExecution, number | undefined>();
    const sub = vscode.tasks.onDidEndTaskProcess(e => endedExecutions.set(e.execution, e.exitCode));
    try {
        const execution = await vscode.tasks.executeTask(task);
        if (task.isBackground) {
            return { started: true, message: 'Background task started; it keeps running in its terminal' };
        }
        if (!endedExecutions.has(execution)) {
            const ended = await waitFor(vscode.tasks.onDidEndTaskProcess, e => e.execution === execution, timeoutMs);
            if (!ended) {
                return { started: true, timedOut: true, message: `Still running after ${timeoutMs}ms` };
            }
            return { started: true, exitCode: ended.exitCode ?? null };
        }
        return { started: true, exitCode: endedExecutions.get(execution) ?? null };
    } finally {
        sub.dispose();
    }
}
