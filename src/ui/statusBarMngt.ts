import * as vscode from 'vscode';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'vscode-context-bridge.showStatus';
        this.statusBarItem.tooltip = 'Click to show Editor Relay server status';
    }

    updateStatus(running: boolean) {
        if (running) {
            this.statusBarItem.text = `$(radio-tower) Editor Relay: Running`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            this.statusBarItem.tooltip = 'Editor Relay server is running. Click to show status.';
        } else {
            this.statusBarItem.text = '$(radio-tower) Editor Relay';
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = 'Editor Relay server is stopped. Click to show status.';
        }

        this.statusBarItem.show();
    }


    dispose(): void {
        this.statusBarItem.dispose();
    }
}