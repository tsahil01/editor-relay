import * as vscode from 'vscode';
import { isIgnored } from '../config';

// Mirrors the Status enum in VS Code's built-in git extension API (extensions/git/src/api/git.d.ts).
const STATUS = [
    'INDEX_MODIFIED', 'INDEX_ADDED', 'INDEX_DELETED', 'INDEX_RENAMED', 'INDEX_COPIED',
    'MODIFIED', 'DELETED', 'UNTRACKED', 'IGNORED', 'INTENT_TO_ADD', 'INTENT_TO_RENAME', 'TYPE_CHANGED',
    'ADDED_BY_US', 'ADDED_BY_THEM', 'DELETED_BY_US', 'DELETED_BY_THEM', 'BOTH_ADDED', 'BOTH_DELETED', 'BOTH_MODIFIED',
];

interface GitChange {
    uri: vscode.Uri;
    status: number;
}

function toChanges(changes: GitChange[] | undefined) {
    return (changes ?? [])
        .filter(c => !isIgnored(c.uri.fsPath))
        .map(c => ({ filePath: c.uri.fsPath, status: STATUS[c.status] ?? String(c.status) }));
}

export async function gitStatus() {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) {
        throw new Error('The built-in Git extension is not available');
    }
    const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
    return {
        repositories: api.repositories.map((repo: any) => {
            const head = repo.state.HEAD;
            const workingTree = [...repo.state.workingTreeChanges, ...(repo.state.untrackedChanges ?? [])];
            return {
                root: repo.rootUri.fsPath,
                branch: head?.name ?? null,
                commit: head?.commit ?? null,
                upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : null,
                ahead: head?.ahead ?? null,
                behind: head?.behind ?? null,
                staged: toChanges(repo.state.indexChanges),
                unstaged: toChanges(workingTree.filter((c: GitChange) => STATUS[c.status] !== 'UNTRACKED')),
                untracked: toChanges(workingTree.filter((c: GitChange) => STATUS[c.status] === 'UNTRACKED')),
                conflicts: toChanges(repo.state.mergeChanges),
            };
        }),
    };
}
