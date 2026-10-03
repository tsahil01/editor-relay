import * as vscode from 'vscode';
import { isIgnored } from '../config';
import { reviewChanges } from '../review';

const MAX_RESULTS = 100;
const DIAGNOSTICS_WAIT_MS = 10_000;

type RangeInfo = { start: { line: number; character: number }; end: { line: number; character: number } };

function toRange(range: vscode.Range): RangeInfo {
    return {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
    };
}

async function openDocument(filePath: string): Promise<vscode.TextDocument> {
    if (isIgnored(filePath)) {
        throw new Error(`File is excluded by the ignoreFiles setting: ${filePath}`);
    }
    return vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
}

// Language servers like TypeScript only check files open in a tab, so open one in the background and give it a moment.
export async function loadDiagnostics(filePath: string): Promise<vscode.TextDocument> {
    const uri = vscode.Uri.file(filePath);
    const inTab = vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString()));
    const document = await openDocument(filePath);
    if (!inTab) {
        await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
    }
    if (!inTab && vscode.languages.getDiagnostics(uri).length === 0) {
        await new Promise<void>(resolve => {
            const timer = setTimeout(() => { sub.dispose(); resolve(); }, DIAGNOSTICS_WAIT_MS);
            const sub = vscode.languages.onDidChangeDiagnostics(e => {
                if (e.uris.some(u => u.toString() === uri.toString())) {
                    clearTimeout(timer);
                    sub.dispose();
                    resolve();
                }
            });
        });
    }
    return document;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Agents rarely know exact columns, so a symbol name on the line is enough to locate the position.
function resolvePosition(document: vscode.TextDocument, line: number, symbol?: string, character?: number): vscode.Position {
    if (line < 0 || line >= document.lineCount) {
        throw new Error(`Line ${line} is out of range (file has ${document.lineCount} lines, 0-based)`);
    }
    const text = document.lineAt(line).text;
    if (character !== undefined) {
        return new vscode.Position(line, character);
    }
    if (symbol) {
        const match = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`).exec(text);
        const index = match ? match.index : text.indexOf(symbol);
        if (index === -1) {
            throw new Error(`"${symbol}" not found on line ${line}: ${text.trim()}`);
        }
        return new vscode.Position(line, index);
    }
    return new vscode.Position(line, document.lineAt(line).firstNonWhitespaceCharacterIndex);
}

async function toLocations(results: (vscode.Location | vscode.LocationLink)[] | undefined) {
    const locations = (results ?? [])
        .map(r => 'targetUri' in r
            ? { uri: r.targetUri, range: r.targetSelectionRange ?? r.targetRange }
            : { uri: r.uri, range: r.range })
        .filter(l => !isIgnored(l.uri.fsPath));
    const shown = await Promise.all(locations.slice(0, MAX_RESULTS).map(async l => ({
        filePath: l.uri.fsPath,
        range: toRange(l.range),
        preview: await vscode.workspace.openTextDocument(l.uri).then(d => d.lineAt(l.range.start.line).text.trim(), () => undefined),
    })));
    return { total: locations.length, locations: shown };
}

export interface PositionArgs {
    filePath: string;
    line: number;
    symbol?: string;
    character?: number;
}

export async function goToDefinition({ filePath, line, symbol, character }: PositionArgs) {
    const document = await openDocument(filePath);
    const position = resolvePosition(document, line, symbol, character);
    return toLocations(await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider', document.uri, position));
}

export async function findReferences({ filePath, line, symbol, character }: PositionArgs) {
    const document = await openDocument(filePath);
    const position = resolvePosition(document, line, symbol, character);
    return toLocations(await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', document.uri, position));
}

export async function hoverInfo({ filePath, line, symbol, character }: PositionArgs) {
    const document = await openDocument(filePath);
    const position = resolvePosition(document, line, symbol, character);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, position);
    const contents = (hovers ?? []).flatMap(h => h.contents.map(c => typeof c === 'string' ? c : c.value));
    return { contents: contents.filter(Boolean) };
}

type SymbolResult = { name: string; kind: string; detail?: string; range: RangeInfo; children?: SymbolResult[] };

function toSymbol(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): SymbolResult {
    if ('children' in symbol) {
        return {
            name: symbol.name,
            kind: vscode.SymbolKind[symbol.kind],
            detail: symbol.detail || undefined,
            range: toRange(symbol.range),
            children: symbol.children.length ? symbol.children.map(toSymbol) : undefined,
        };
    }
    return { name: symbol.name, kind: vscode.SymbolKind[symbol.kind], detail: symbol.containerName || undefined, range: toRange(symbol.location.range) };
}

export async function documentSymbols(filePath: string) {
    const document = await openDocument(filePath);
    const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        'vscode.executeDocumentSymbolProvider', document.uri);
    return { symbols: (symbols ?? []).map(toSymbol) };
}

export async function workspaceSymbols(query: string) {
    const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query) ?? [])
        .filter(s => !isIgnored(s.location.uri.fsPath));
    return {
        total: symbols.length,
        symbols: symbols.slice(0, MAX_RESULTS).map(s => ({
            name: s.name,
            kind: vscode.SymbolKind[s.kind],
            containerName: s.containerName || undefined,
            filePath: s.location.uri.fsPath,
            range: toRange(s.location.range),
        })),
    };
}

function lineRange(document: vscode.TextDocument, startLine: number, endLine = startLine): vscode.Range {
    const last = Math.min(endLine, document.lineCount - 1);
    return new vscode.Range(startLine, 0, last, document.lineAt(last).text.length);
}

async function fetchCodeActions(document: vscode.TextDocument, startLine: number, endLine?: number) {
    return await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
        'vscode.executeCodeActionProvider', document.uri, lineRange(document, startLine, endLine), undefined, MAX_RESULTS) ?? [];
}

export async function getCodeActions(filePath: string, startLine: number, endLine?: number) {
    const document = await loadDiagnostics(filePath);
    const actions = await fetchCodeActions(document, startLine, endLine);
    return {
        actions: actions.map(a => typeof a.command === 'string'
            ? { title: a.title }
            : {
                title: a.title,
                kind: (a as vscode.CodeAction).kind?.value,
                isPreferred: (a as vscode.CodeAction).isPreferred || undefined,
                fixes: (a as vscode.CodeAction).diagnostics?.map(d => d.message),
            }),
    };
}

async function applyWithReview(edit: vscode.WorkspaceEdit, title: string) {
    const entries = edit.entries();
    const files = await Promise.all(entries.map(async ([uri, edits]) => {
        const document = await vscode.workspace.openTextDocument(uri);
        let proposedContent = document.getText();
        for (const e of [...edits].sort((x, y) => document.offsetAt(y.range.start) - document.offsetAt(x.range.start))) {
            proposedContent = proposedContent.slice(0, document.offsetAt(e.range.start)) + e.newText + proposedContent.slice(document.offsetAt(e.range.end));
        }
        return { uri, proposedContent };
    }));
    const summary = { files: entries.map(([uri]) => uri.fsPath), edits: entries.reduce((n, [, edits]) => n + edits.length, 0) };
    const action = await reviewChanges(title, `${title} - Review ${summary.edits} edit(s) in ${files.length} file(s)`, files);
    if (action !== 'accept') {
        return { applied: false, ...summary, message: action ? 'The user rejected the changes' : 'The review was dismissed' };
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
        for (const [uri] of entries) {
            await vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())?.save();
        }
    }
    return { applied, ...summary };
}

export async function applyCodeAction(filePath: string, title: string, startLine: number, endLine?: number) {
    const document = await loadDiagnostics(filePath);
    const action = (await fetchCodeActions(document, startLine, endLine)).find(a => a.title === title);
    if (!action) {
        throw new Error(`No code action titled "${title}" for that range; call get_code_actions first`);
    }
    const command = typeof action.command === 'string' ? action as vscode.Command : action.command;
    const edit = (action as vscode.CodeAction).edit;
    let result: { applied: boolean; files: string[]; edits: number; message?: string } = { applied: true, files: [], edits: 0 };
    if (edit) {
        result = await applyWithReview(edit, title);
        if (!result.applied) {
            return result;
        }
    } else {
        const choice = await vscode.window.showInformationMessage(`Apply code action "${title}"?`, 'Apply', 'Cancel');
        if (choice !== 'Apply') {
            return { ...result, applied: false };
        }
    }
    if (command) {
        await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    }
    return result;
}

export async function renameSymbol(args: PositionArgs & { newName: string }) {
    const document = await openDocument(args.filePath);
    const position = resolvePosition(document, args.line, args.symbol, args.character);
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
        'vscode.executeDocumentRenameProvider', document.uri, position, args.newName);
    if (!edit || edit.size === 0) {
        throw new Error('The language server returned no rename edits for that position');
    }
    return applyWithReview(edit, `Rename ${args.symbol ?? 'symbol'} to ${args.newName}`);
}
