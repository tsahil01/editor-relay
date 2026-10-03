import * as vscode from 'vscode';
import { ContextProvider } from './provider/contextProvider';
import { StatusBarManager } from './ui/statusBarMngt';
import { ContextBridgeServer, HOST } from './server/contextBridgeServer';
import { TerminalTracker } from './provider/terminalTracker';
import { loadOrCreateToken } from './auth';

const DEFAULT_PORT = 3210;

let contextProvider: ContextProvider | undefined;
let statusBarManager: StatusBarManager | undefined;
let contextBridgeServer: ContextBridgeServer | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let authToken = '';
const mcpDefinitionsChanged = new vscode.EventEmitter<void>();

export function activate(contenxt: vscode.ExtensionContext) {
    console.log("Editor Relay extension is now live!");

    extensionContext = contenxt;
    authToken = loadOrCreateToken();
    const terminalTracker = new TerminalTracker();
    contextProvider = new ContextProvider(terminalTracker);
    statusBarManager = new StatusBarManager();

    const startServerCmd = vscode.commands.registerCommand('vscode-context-bridge.startServer', startServer);
    const stopServerCmd = vscode.commands.registerCommand('vscode-context-bridge.stopServer', stopServer);

    const showStatusCmd = vscode.commands.registerCommand('vscode-context-bridge.showStatus', showStatus);
    const copyTokenCmd = vscode.commands.registerCommand('vscode-context-bridge.copyToken', copyToken);

    contenxt.subscriptions.push(startServerCmd, stopServerCmd, showStatusCmd, copyTokenCmd, terminalTracker, contextProvider, mcpDefinitionsChanged);

    // Guarded because some VS Code forks lag behind on the lm API.
    if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function') {
        contenxt.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('vscode-context-bridge.mcp', {
            onDidChangeMcpServerDefinitions: mcpDefinitionsChanged.event,
            provideMcpServerDefinitions: () => {
                if (!contextBridgeServer?.isRunning()) {
                    return [];
                }
                return [new vscode.McpHttpServerDefinition(
                    'Editor Relay',
                    vscode.Uri.parse(`http://${HOST}:${getPort()}/mcp`),
                    { Authorization: `Bearer ${authToken}` },
                    contenxt.extension.packageJSON.version
                )];
            },
        }));
    }

    const wasRunning = contenxt.globalState.get<boolean>('contextBridgeServerRunning', false);
    statusBarManager.updateStatus(wasRunning);
    if (!contextBridgeServer || !contextBridgeServer.isRunning()) {
        startServer();
    }
}

function getPort(): number {
    return vscode.workspace.getConfiguration('vscodeContextBridge').get<number>('port', DEFAULT_PORT);
}

async function copyToken() {
    await vscode.env.clipboard.writeText(authToken);
    vscode.window.setStatusBarMessage('Editor Relay auth token copied to clipboard.', 3000);
}

export function deactivate() {
    if (contextBridgeServer) {
        contextBridgeServer.stop();
    }
    if (statusBarManager) {
        statusBarManager.dispose();
    }
}

async function startServer() {
    try {
        if (contextBridgeServer && contextBridgeServer.isRunning()) {
            vscode.window.setStatusBarMessage("Editor Relay server is already running.", 3000);
            return;
        }

        const port = getPort();

        contextBridgeServer = new ContextBridgeServer(port, contextProvider!, authToken, extensionContext?.extension.packageJSON.version ?? '0.0.0');
        await contextBridgeServer.start();
        mcpDefinitionsChanged.fire();

        statusBarManager!.updateStatus(true);
        extensionContext?.globalState.update('contextBridgeServerRunning', true);
        vscode.window.setStatusBarMessage(`Editor Relay server started on port ${port}.`, 3000);
    } catch (error) {
        console.error("Error starting Editor Relay server:", error);
        vscode.window.showErrorMessage(`Failed to start Editor Relay server: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}


async function stopServer() {
    try {
        if (!contextBridgeServer || !contextBridgeServer.isRunning()) {
            vscode.window.setStatusBarMessage('Editor Relay server is not running.', 3000);
            return;
        }

        await contextBridgeServer.stop();
        mcpDefinitionsChanged.fire();
        statusBarManager!.updateStatus(false);
        extensionContext?.globalState.update('contextBridgeServerRunning', false);
        vscode.window.setStatusBarMessage('Editor Relay server stopped.', 3000);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to stop Editor Relay server: ${error}`);
    }
}

function showStatus() {
    const isRunning = contextBridgeServer?.isRunning() || false;
    const config = vscode.workspace.getConfiguration('vscodeContextBridge');
    const port = getPort();
    const shareDiagnostics = config.get<boolean>('shareDiagnostics', true);
    const shareDiffs = config.get<boolean>('shareDiffs', true);

    async function restartServerIfRunning() {
        if (contextBridgeServer && contextBridgeServer.isRunning()) {
            await stopServer();
            await startServer();
        }
    }

    const menuItems: vscode.QuickPickItem[] = [
        {
            label: isRunning ? '$(debug-stop) Stop Server' : '$(debug-start) Start Server',
            description: isRunning ? 'Stop the Editor Relay server' : 'Start the Editor Relay server',
        },
        {
            label: '$(gear) Configure Port',
            description: `Current: ${port}`,
        },
        {
            label: '$(check) Toggle Share Diagnostics',
            description: `Currently: ${shareDiagnostics ? 'Enabled' : 'Disabled'}`,
        },
        {
            label: '$(diff) Toggle Share Diffs',
            description: `Currently: ${shareDiffs ? 'Enabled' : 'Disabled'}`,
        },
        {
            label: '$(key) Copy Auth Token',
            description: 'Clients must send it as "Authorization: Bearer <token>"',
        },
        {
            label: '$(info) Show Current Status',
            description: 'Show the current server and settings status',
        },
    ];

    vscode.window.showQuickPick(menuItems, {
        placeHolder: 'Editor Relay Settings',
        ignoreFocusOut: true,
    }).then(async (selection) => {
        if (!selection) return;
        switch (selection.label) {
            case '$(debug-start) Start Server':
                await vscode.commands.executeCommand('vscode-context-bridge.startServer');
                break;
            case '$(debug-stop) Stop Server':
                await vscode.commands.executeCommand('vscode-context-bridge.stopServer');
                break;
            case '$(gear) Configure Port': {
                const newPort = await vscode.window.showInputBox({
                    prompt: 'Enter new port for Editor Relay server',
                    value: port.toString(),
                    validateInput: (val) => isNaN(Number(val)) || Number(val) <= 0 ? 'Enter a valid port number' : undefined,
                });
                if (newPort) {
                    await config.update('port', Number(newPort), vscode.ConfigurationTarget.Global);
                    vscode.window.setStatusBarMessage(`Port updated to ${newPort}. Restarting server if running...`, 3000);
                    await restartServerIfRunning();
                }
                break;
            }
            case '$(check) Toggle Share Diagnostics': {
                await config.update('shareDiagnostics', !shareDiagnostics, vscode.ConfigurationTarget.Global);
                vscode.window.setStatusBarMessage(`Share Diagnostics ${!shareDiagnostics ? 'enabled' : 'disabled'}.`, 3000);
                break;
            }
            case '$(diff) Toggle Share Diffs': {
                await config.update('shareDiffs', !shareDiffs, vscode.ConfigurationTarget.Global);
                vscode.window.setStatusBarMessage(`Share Diffs ${!shareDiffs ? 'enabled' : 'disabled'}.`, 3000);
                break;
            }
            case '$(key) Copy Auth Token':
                await copyToken();
                break;
            case '$(info) Show Current Status': {
                const ignoreFiles = config.get<string[]>('ignoreFiles') ?? [];
                const status = isRunning ? 'Running' : 'Stopped';
                vscode.window.setStatusBarMessage(
                    `Editor Relay Server Status: Server: ${status} | Port: ${port} | Share Diagnostics: ${shareDiagnostics ? 'Yes' : 'No'} | Ignore Files: ${ignoreFiles.join(', ')} | Share Diffs: ${shareDiffs ? 'Yes' : 'No'}`,
                    3000
                );
                break;
            }
        }
    });
} 