import * as vscode from 'vscode';
import * as path from 'path';
import { ActiveFileInfo, ActiveNotebookInfo, CommandResponse, ContextData, DiagnosticInfo, DiffChange, DiffInfo, OpenTabInfo, TextSelectionInfo, ChangeProposal, ChangeProposalRequest, ChangeProposalResponse, WorkspaceFolderInfo } from '../types';
import { languageMap } from '../const';
import { TerminalTracker } from './terminalTracker';
import { getConfig, isIgnored } from '../config';
import { registerReviewProvider, reviewChanges } from '../review';

export class ContextProvider implements vscode.Disposable {
    private changeProposals: Map<string, ChangeProposal> = new Map();
    private disposables: vscode.Disposable[] = [];

    constructor(private terminalTracker: TerminalTracker) {
        this.disposables.push(registerReviewProvider());
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }

    async getContext(): Promise<ContextData> {
        const shareTerminal = getConfig().get<boolean>('shareTerminalOutput', true);
        return {
            workspaceFolders: this.getWorkspaceFoldersInfo(),
            activeFile: await this.getActiveFileInfo(),
            activeNotebook: this.getActiveNotebookInfo(),
            textSelection: this.getTextSelectionInfo(),
            openTabs: this.getOpenTabsInfo(),
            diffs: await this.getDiffsInfo(),
            diagnostics: await this.getDiagnosticsInfo(),
            terminalCommands: shareTerminal ? this.terminalTracker.getCommands() : null,
            timestamp: Date.now()
        };
    }

    private getLangFromUri(uri: vscode.Uri): string {
        const afterDot = uri.path.split('.').pop()?.toLowerCase();
        return languageMap[afterDot || ''] || 'plaintext';
    }

    private getWorkspaceFoldersInfo(): WorkspaceFolderInfo[] {
        return (vscode.workspace.workspaceFolders ?? []).map(folder => ({
            name: folder.name,
            path: folder.uri.fsPath
        }));
    }

    private getActiveNotebookInfo(): ActiveNotebookInfo | null {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor || isIgnored(editor.notebook.uri.fsPath)) {
            return null;
        }
        const notebook = editor.notebook;
        return {
            path: notebook.uri.fsPath,
            name: path.basename(notebook.uri.fsPath),
            notebookType: notebook.notebookType,
            isDirty: notebook.isDirty,
            selectedCellIndexes: editor.selections.flatMap(range =>
                Array.from({ length: range.end - range.start }, (_, i) => range.start + i)),
            cells: notebook.getCells().map(cell => ({
                index: cell.index,
                kind: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup',
                language: cell.document.languageId,
                content: cell.document.getText()
            }))
        };
    }

    private async getActiveFileInfo(): Promise<ActiveFileInfo | null> {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || isIgnored(activeEditor.document.fileName)) {
            return null;
        }
        const document = activeEditor.document;
        return {
            path: document.fileName,
            name: document.fileName.split('/').pop() || document.fileName.split('\\').pop() || 'unknown',
            language: document.languageId,
            content: document.getText(),
            lineCount: document.lineCount,
            isDirty: document.isDirty,
        }
    }

    private getTextSelectionInfo(): TextSelectionInfo | null {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.selection.isEmpty || isIgnored(activeEditor.document.fileName)) {
            return null;
        }
        const selection = activeEditor.selection;
        return {
            startLine: selection.start.line,
            endLine: selection.end.line,
            startCharacter: selection.start.character,
            endCharacter: selection.end.character,
            text: activeEditor.document.getText(selection),
            range: {
                start: { line: selection.start.line, character: selection.start.character },
                end: { line: selection.end.line, character: selection.end.character }
            }
        };
    }

    private getOpenTabsInfo(): OpenTabInfo[] {
        const openTabs: OpenTabInfo[] = [];
        vscode.window.tabGroups.all.forEach(grp => {
            grp.tabs.forEach(tab => {
                const isText = tab.input instanceof vscode.TabInputText;
                if (!isText && !(tab.input instanceof vscode.TabInputNotebook)) {
                    return;
                }
                const document = tab.input.uri;
                const filePath = document.fsPath;
                if (isIgnored(filePath)) {
                    return;
                }
                openTabs.push({
                    path: filePath,
                    name: document.path.split('/').pop() || document.path.split('\\').pop() || 'unknown',
                    language: isText ? this.getLangFromUri(document) : (tab.input as vscode.TabInputNotebook).notebookType,
                    isActive: tab.isActive,
                    isDirty: tab.isDirty
                })
            })
        })
        return openTabs;
    }

    private async getDiffsInfo(): Promise<DiffInfo[] | null> {
        const shareDiffs = getConfig().get<boolean>('shareDiffs', true);
        if (!shareDiffs) {
            return null;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return null;
        }

        const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
        const gitApi = gitExtension?.getAPI(1);

        if (gitApi) {
            const diffs: DiffInfo[] = [];
            for (const repo of gitApi.repositories) {
                for (const change of repo.state.workingTreeChanges) {
                    if (isIgnored(change.uri.fsPath)) {
                        continue;
                    }
                    const filePath = change.uri.fsPath;
                    const fileName = change.uri.path.split('/').pop() || change.uri.path.split('\\').pop() || 'unknown';
                    let diffText = '';
                    try {
                        diffText = await repo.diffWithHEAD(filePath);
                    } catch (e) {
                        diffs.push({
                            filePath,
                            fileName,
                            changes: [{
                                type: 'modify',
                                lineNumber: 1,
                                newText: 'File has changes (diff unavailable)'
                            }]
                        });
                        continue;
                    }
                    const changes = this.parseGitDiff(diffText);
                    diffs.push({
                        filePath,
                        fileName,
                        changes
                    });
                }
            }
            return diffs;
        }
        return null;
    }

    private parseGitDiff(diffText: string): DiffChange[] {
        const changes: DiffChange[] = [];
        const lines = diffText.split('\n');
        let lineNumber = 0;
        for (const line of lines) {
            if (line.startsWith('@@')) {
                const match = line.match(/@@ -\d+,?\d* \+(\d+),?/);
                if (match) {
                    lineNumber = parseInt(match[1], 10);
                }
            } else if (line.startsWith('+') && !line.startsWith('+++')) {
                changes.push({
                    type: 'add',
                    lineNumber: lineNumber++,
                    newText: line.substring(1)
                });
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                changes.push({
                    type: 'delete',
                    lineNumber: lineNumber,
                    originalText: line.substring(1)
                });
            } else if (line.startsWith(' ')) {
                lineNumber++;
            }
        }
        return changes;
    }

    async getDiagnosticsInfo(): Promise<DiagnosticInfo[] | null> {
        const shareDiagnostics = getConfig().get<boolean>('shareDiagnostics', true);
        if (!shareDiagnostics) {
            return null;
        }

        const diagnostics: DiagnosticInfo[] = [];
        const diagnosticCollection = vscode.languages.getDiagnostics();

        for (const [uri, diags] of diagnosticCollection) {
            if (isIgnored(uri.fsPath)) {
                continue;
            }
            if (uri.scheme === 'file') {
                const fileDiagnostics = diags.map(diag => ({
                    message: diag.message,
                    severity: (diag.severity === vscode.DiagnosticSeverity.Error ? 'error' :
                        diag.severity === vscode.DiagnosticSeverity.Warning ? 'warning' :
                            diag.severity === vscode.DiagnosticSeverity.Information ? 'info' : 'hint') as 'error' | 'warning' | 'info' | 'hint',
                    range: {
                        start: { line: diag.range.start.line, character: diag.range.start.character },
                        end: { line: diag.range.end.line, character: diag.range.end.character }
                    },
                    source: diag.source,
                    code: typeof diag.code === 'object' ? diag.code.value : diag.code
                }));

                diagnostics.push({
                    filePath: uri.fsPath,
                    fileName: uri.path.split('/').pop() || uri.path.split('\\').pop() || 'untitled',
                    diagnostics: fileDiagnostics
                });
            }
        }

        return diagnostics;
    }

    async openFile(filePath: string, options: any = {}): Promise<CommandResponse> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, options);

            return {
                success: true,
                data: { filePath },
                message: `File opened successfully: ${filePath}`
            }

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                message: `Failed to open file: ${filePath}`
            };
        }
    }

    async selectText(startLine: number, startChar: number, endLine: number, endChar: number): Promise<CommandResponse> {
        try {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                throw new Error("No active text editor found");
            }
            const startPosition = new vscode.Position(startLine, startChar);
            const endPosition = new vscode.Position(endLine, endChar);
            const selection = new vscode.Selection(startPosition, endPosition);

            activeEditor.selection = selection;
            activeEditor.revealRange(selection);

            return {
                success: true,
                data: { startLine, startChar, endLine, endChar },
                message: "Text selection set successfully"
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                message: "Failed to set text selection"
            };
        }
    }

    async showNotification(message: string, type: 'info' | 'warning' | 'error' = 'info'): Promise<CommandResponse> {
        try {
            switch (type) {
                case 'info':
                    vscode.window.showInformationMessage(message);
                    break;
                case 'warning':
                    vscode.window.showWarningMessage(message);
                    break;
                case 'error':
                    vscode.window.showErrorMessage(message);
                    break;
            }
            return {
                success: true,
                data: { message, type },
                message: `Notification shown: ${message}`
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                message: `Failed to show notification: ${message}`
            };
        }
    }

    async proposeChange(request: ChangeProposalRequest): Promise<ChangeProposalResponse> {
        try {
            const proposalId = `change_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
            const proposal: ChangeProposal = {
                id: proposalId,
                title: request.title,
                filePath: request.filePath,
                changes: request.changes,
                timestamp: Date.now()
            };

            this.changeProposals.set(proposalId, proposal);
            
            const result = await this.showInlineDiffAndWait(proposal);
            
            return result;
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                message: 'Failed to create change proposal',
                accepted: false
            };
        }
    }

    private async acceptProposal(proposalId: string): Promise<ChangeProposalResponse> {
        try {
            const proposal = this.changeProposals.get(proposalId);
            if (!proposal) {
                return {
                    success: false,
                    error: 'Proposal not found',
                    message: `Proposal ${proposalId} not found`,
                    accepted: false
                };
            }

            const uri = vscode.Uri.file(proposal.filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            let fileContent = document.getText();

            // Process changes in reverse order to maintain text positions
            const sortedChanges = [...proposal.changes].reverse();
            
            for (const change of sortedChanges) {
                const { originalContent, proposedContent } = change;
                
                // Find the content to replace
                const contentIndex = fileContent.indexOf(originalContent);
                if (contentIndex === -1) {
                    throw new Error(`Original content not found in file: "${originalContent.substring(0, 100)}..."`);
                }
                
                // Check if there are multiple occurrences
                const lastIndex = fileContent.lastIndexOf(originalContent);
                if (contentIndex !== lastIndex) {
                    console.warn(`Multiple occurrences found for content: "${originalContent.substring(0, 50)}...". Using first occurrence.`);
                }
                
                // Replace the first occurrence
                fileContent = fileContent.replace(originalContent, proposedContent);
            }

            // Apply the complete file change
            const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, fullRange, fileContent);

            await vscode.workspace.applyEdit(edit);
            await document.save();

            this.changeProposals.delete(proposalId);

            return {
                success: true,
                data: { proposalId, filePath: proposal.filePath },
                message: `Change proposal ${proposalId} accepted and applied`,
                accepted: true
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                message: `Failed to accept proposal ${proposalId}`,
                accepted: false
            };
        }
    }

    private async rejectProposal(proposalId: string): Promise<ChangeProposalResponse> {
        try {
            const proposal = this.changeProposals.get(proposalId);
            if (!proposal) {
                return {
                    success: false,
                    error: 'Proposal not found',
                    message: `Proposal ${proposalId} not found`,
                    accepted: false
                };
            }

            this.changeProposals.delete(proposalId);

            return {
                success: true,
                data: { proposalId },
                message: `Change proposal ${proposalId} rejected`,
                accepted: false
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                message: `Failed to reject proposal ${proposalId}`,
                accepted: false
            };
        }
    }

    private async showInlineDiffAndWait(proposal: ChangeProposal): Promise<ChangeProposalResponse> {
        try {
            const uri = vscode.Uri.file(proposal.filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            let proposedContent = document.getText();

            for (const change of [...proposal.changes].reverse()) {
                if (!proposedContent.includes(change.originalContent)) {
                    console.warn(`Original content not found in file: "${change.originalContent.substring(0, 50)}..."`);
                    continue;
                }
                proposedContent = proposedContent.replace(change.originalContent, change.proposedContent);
            }

            const action = await reviewChanges(proposal.title, `${proposal.title} - Review ${proposal.changes.length} change(s)`, [{ uri, proposedContent }]);

            if (!action) {
                this.changeProposals.delete(proposal.id);
                return {
                    success: false,
                    error: 'No action selected',
                    message: `Change proposal ${proposal.id} was dismissed`,
                    accepted: false
                };
            }

            const result = action === 'accept'
                ? await this.acceptProposal(proposal.id)
                : await this.rejectProposal(proposal.id);
            vscode.window.showInformationMessage(result.accepted ? 'Changes accepted and applied!' : result.success ? 'Changes rejected.' : result.message);
            return result;

        } catch (error) {
            console.error('Failed to show diff:', error);
            vscode.window.showErrorMessage('Failed to show change proposal diff');
            this.changeProposals.delete(proposal.id);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                message: 'Failed to show change proposal',
                accepted: false
            };
        }
    }

}
