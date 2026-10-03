import * as vscode from 'vscode';
import * as path from 'path';

const REVIEW_SCHEME = 'context-bridge-proposal';
const ACCEPT = 'Accept Changes';
const REJECT = 'Reject Changes';

const proposedContents = new Map<string, string>();
let nextReviewId = 0;

export function registerReviewProvider(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, {
        provideTextDocumentContent: uri => proposedContents.get(uri.path) ?? ''
    });
}

export interface ReviewFile {
    uri: vscode.Uri;
    proposedContent: string;
}

/** Shows the proposed contents as a diff and resolves to 'accept', 'reject', or undefined if dismissed. */
export async function reviewChanges(title: string, message: string, files: ReviewFile[]): Promise<'accept' | 'reject' | undefined> {
    const reviewId = `${Date.now()}-${nextReviewId++}`;
    const pairs = files.map(({ uri, proposedContent }, i) => {
        const proposedUri = vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${reviewId}/${i}/${path.basename(uri.fsPath)}` });
        proposedContents.set(proposedUri.path, proposedContent);
        return [uri, proposedUri] as const;
    });
    try {
        if (pairs.length === 1) {
            await vscode.commands.executeCommand('vscode.diff', pairs[0][0], pairs[0][1], `${title} - Review Changes`);
        } else {
            await vscode.commands.executeCommand('vscode.changes', `${title} - Review Changes`, pairs.map(([uri, proposedUri]) => [uri, uri, proposedUri]));
        }
        const action = await vscode.window.showInformationMessage(
            message,
            { title: ACCEPT, isCloseAffordance: false },
            { title: REJECT, isCloseAffordance: true }
        );
        return action?.title === ACCEPT ? 'accept' : action ? 'reject' : undefined;
    } finally {
        pairs.forEach(([, proposedUri]) => proposedContents.delete(proposedUri.path));
    }
}
