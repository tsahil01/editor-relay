export interface ActiveFileInfo {
    path: string;
    name: string;
    language: string;
    content: string;
    lineCount: number;
    isDirty: boolean;
}

export interface TextSelectionInfo {
    startLine: number;
    endLine: number;
    startCharacter: number;
    endCharacter: number;
    text: string;
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
}

export interface OpenTabInfo {
    path: string;
    name: string;
    language: string;
    isActive: boolean;
    isDirty: boolean;
}

export interface DiffInfo {
    filePath: string;
    fileName: string;
    changes: DiffChange[];
}

export interface DiffChange {
    type: 'add' | 'delete' | 'modify';
    lineNumber: number;
    originalText?: string;
    newText?: string;
}

export interface DiagnosticInfo {
    filePath: string;
    fileName: string;
    diagnostics: Diagnostic[];
}

export interface Diagnostic {
    message: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    source?: string;
    code?: string | number;
}

export interface CommandResponse {
    success: boolean;
    data?: any;
    error?: string;
    message: string;
}

export interface WorkspaceFolderInfo {
    name: string;
    path: string;
}

export interface NotebookCellInfo {
    index: number;
    kind: 'code' | 'markup';
    language: string;
    content: string;
}

export interface ActiveNotebookInfo {
    path: string;
    name: string;
    notebookType: string;
    isDirty: boolean;
    selectedCellIndexes: number[];
    cells: NotebookCellInfo[];
}

export interface TerminalCommandInfo {
    terminalName: string;
    commandLine: string;
    cwd?: string;
    exitCode?: number;
    output: string;
    startedAt: number;
    endedAt?: number;
}

export interface ContextData {
    workspaceFolders: WorkspaceFolderInfo[];
    activeFile: ActiveFileInfo | null;
    activeNotebook: ActiveNotebookInfo | null;
    textSelection: TextSelectionInfo | null;
    openTabs: OpenTabInfo[];
    diffs: DiffInfo[] | null;
    diagnostics: DiagnosticInfo[] | null;
    terminalCommands: TerminalCommandInfo[] | null;
    timestamp: number;
}

export interface FileChange {
    originalContent: string;
    proposedContent: string;
    description?: string;
}

export interface ChangeProposal {
    id: string;
    title: string;
    filePath: string;
    changes: FileChange[];
    timestamp: number;
}

export interface ChangeProposalRequest {
    title: string;
    filePath: string;
    changes: FileChange[];
}

export interface ChangeProposalResponse {
    success: boolean;
    proposalId?: string;
    data?: any;
    error?: string;
    message: string;
    accepted: boolean;
}
