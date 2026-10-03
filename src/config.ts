import * as vscode from 'vscode';

export function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('vscodeContextBridge');
}

export function isIgnored(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (getConfig().get<string[]>('ignoreFiles') ?? [])
        .some(pattern => pattern.trim() && lower.includes(pattern.trim().toLowerCase()));
}
