import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const TOKEN_DIR = path.join(os.homedir(), '.vscode-context-bridge');
export const TOKEN_FILE = path.join(TOKEN_DIR, 'token');

// Reuse an existing token so multiple VS Code windows and already-configured clients keep working.
export function loadOrCreateToken(): string {
    try {
        const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        if (existing) {
            return existing;
        }
    } catch {
    }
    const token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return token;
}

export function isValidToken(provided: string | undefined, expected: string): boolean {
    if (!provided) {
        return false;
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
