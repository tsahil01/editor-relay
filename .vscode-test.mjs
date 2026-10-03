import { defineConfig } from '@vscode/test-cli';
import { execSync } from 'child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Tests edit files and need a git repo, so they run against a throwaway copy of the fixture.
const root = mkdtempSync(join(tmpdir(), 'context-bridge-test-'));
const workspace = join(root, 'workspace');
const home = join(root, 'home');
mkdirSync(home);
cpSync('test/fixture', workspace, { recursive: true });
const git = args => execSync(`git -c user.name=test -c user.email=test@example.com ${args}`, { cwd: workspace, stdio: 'ignore' });
git('init -q');
git('add -A');
git('commit -qm init');
appendFileSync(join(workspace, 'notes.txt'), 'changed\n');
appendFileSync(join(workspace, 'staged.txt'), 'changed\n');
git('add staged.txt');
writeFileSync(join(workspace, 'new.txt'), 'untracked\n');

export default defineConfig({
    files: 'out/test/**/*.test.js',
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    workspaceFolder: workspace,
    launchArgs: ['--disable-workspace-trust'],
    env: { HOME: home },
    mocha: { ui: 'bdd', timeout: 60_000 },
});
