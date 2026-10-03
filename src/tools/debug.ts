import * as vscode from 'vscode';

const MAX_FRAMES = 20;
const MAX_VARIABLES = 50;

export function getBreakpoints() {
    return {
        breakpoints: vscode.debug.breakpoints.map(bp => ({
            enabled: bp.enabled,
            condition: bp.condition,
            hitCondition: bp.hitCondition,
            logMessage: bp.logMessage,
            ...(bp instanceof vscode.SourceBreakpoint
                ? { filePath: bp.location.uri.fsPath, line: bp.location.range.start.line }
                : bp instanceof vscode.FunctionBreakpoint ? { functionName: bp.functionName } : {}),
        })),
    };
}

export async function getDebugState() {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
        return { active: false };
    }
    const base = { active: true, name: session.name, type: session.type };
    const item = vscode.debug.activeStackItem;
    if (!item || item.session.id !== session.id) {
        return { ...base, paused: false };
    }

    try {
        const { stackFrames = [] } = await session.customRequest('stackTrace', { threadId: item.threadId, startFrame: 0, levels: MAX_FRAMES });
        const frameId = item instanceof vscode.DebugStackFrame ? item.frameId : stackFrames[0]?.id;
        const { scopes = [] } = frameId === undefined ? {} : await session.customRequest('scopes', { frameId });
        const variables = await Promise.all(scopes
            .filter((scope: any) => !scope.expensive)
            .map(async (scope: any) => {
                const { variables = [] } = await session.customRequest('variables', { variablesReference: scope.variablesReference });
                return {
                    scope: scope.name,
                    variables: variables.slice(0, MAX_VARIABLES).map((v: any) => ({ name: v.name, value: v.value, type: v.type })),
                };
            }));
        return {
            ...base,
            paused: true,
            threadId: item.threadId,
            // DAP lines are 1-based; convert to 0-based like every other tool.
            stackFrames: stackFrames.map((f: any) => ({ id: f.id, name: f.name, filePath: f.source?.path, line: f.line - 1 })),
            currentFrameId: frameId,
            variables,
        };
    } catch {
        return { ...base, paused: false };
    }
}
