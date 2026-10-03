import * as vscode from 'vscode';
import { TerminalCommandInfo } from '../types';

const MAX_COMMANDS = 20;
const MAX_OUTPUT_CHARS = 10_000;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

export function appendOutput(output: string, chunk: string): string {
    return (output + chunk.replace(ANSI_PATTERN, '')).slice(-MAX_OUTPUT_CHARS);
}

export class TerminalTracker implements vscode.Disposable {
    private commands: TerminalCommandInfo[] = [];
    private running = new Map<vscode.TerminalShellExecution, TerminalCommandInfo>();
    private disposables: vscode.Disposable[] = [];

    constructor() {
        this.disposables.push(
            vscode.window.onDidStartTerminalShellExecution(e => this.onStart(e)),
            vscode.window.onDidEndTerminalShellExecution(e => this.onEnd(e)),
        );
    }

    getCommands(): TerminalCommandInfo[] {
        return [...this.commands];
    }

    private async onStart(e: vscode.TerminalShellExecutionStartEvent) {
        const info: TerminalCommandInfo = {
            terminalName: e.terminal.name,
            commandLine: e.execution.commandLine.value,
            cwd: e.execution.cwd?.fsPath,
            output: '',
            startedAt: Date.now(),
        };
        this.running.set(e.execution, info);
        this.commands.push(info);
        if (this.commands.length > MAX_COMMANDS) {
            this.commands.shift();
        }

        // read() only yields output produced after it is called, so it must start here, not on end.
        for await (const chunk of e.execution.read()) {
            info.output = appendOutput(info.output, chunk);
        }
    }

    private onEnd(e: vscode.TerminalShellExecutionEndEvent) {
        const info = this.running.get(e.execution);
        if (!info) {
            return;
        }
        info.commandLine = e.execution.commandLine.value;
        info.exitCode = e.exitCode;
        info.endedAt = Date.now();
        this.running.delete(e.execution);
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
