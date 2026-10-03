import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ContextProvider } from '../provider/contextProvider';
import { isValidToken } from '../auth';
import { createMcpServer } from './mcpServer';

export const HOST = '127.0.0.1';

function tokenFromRequest(req: http.IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

export class ContextBridgeServer {
    private server: http.Server | undefined;
    private serverRunning: boolean = false;
    private app: express.Application;

    constructor(
        private port: number,
        private contextProvider: ContextProvider,
        private token: string,
        private version: string,
    ) {
        this.app = express();
        this.app.use(express.json({ limit: '10mb' }));
        this.app.get('/health', (req: Request, res: Response) => {
            res.status(200).json({ status: 'ok', server: 'running' });
        });
        this.app.use((req: Request, res: Response, next: NextFunction) => {
            if (!isValidToken(tokenFromRequest(req), this.token)) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }
            next();
        });
        this.setupRoutes();
    }

    private setupRoutes() {
        this.app.post('/mcp', async (req: Request, res: Response) => {
            const mcpServer = createMcpServer(this.contextProvider, this.version);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            res.on('close', () => {
                transport.close();
                mcpServer.close();
            });
            try {
                await mcpServer.connect(transport);
                await transport.handleRequest(req, res, req.body);
            } catch (error) {
                if (!res.headersSent) {
                    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
                }
            }
        });

        this.app.all('/mcp', (req: Request, res: Response) => {
            res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
        });

        this.app.use((req: Request, res: Response) => {
            res.status(404).json({ error: 'Not found' });
        });
    }

    async start() {
        return new Promise<void>((resolve, reject) => {
            try {
                this.server = http.createServer(this.app);
                this.server.listen(this.port, HOST, () => {
                    this.serverRunning = true;
                    console.log(`Editor Relay server is running on ${HOST}:${this.port}`);
                    resolve();
                });
                this.server.on('error', (error: Error) => {
                    console.error(`Error starting server: ${error.message}`);
                    reject(error);
                });
            } catch (error) {
                reject(error);
            }
        })
    }

    async stop() {
        return new Promise<void>((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    this.serverRunning = false;
                    console.log('HTTP server closed');
                    resolve();
                });
                this.server.closeAllConnections();
            } else {
                resolve();
            }
        });
    }

    isRunning(): boolean {
        return this.serverRunning;
    }
}
