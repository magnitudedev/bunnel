import type { Server, ServerWebSocket } from "bun";
import { init } from '@paralleldrive/cuid2';
import logger from './logger';

const createId = init({
    length: 12
});

interface TunnelData {
    subdomain: string;
    isControl?: boolean;
}

interface TunnelRequest {
    id: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string | null;
}

interface TunnelResponse {
    id: string;
    status: number;
    headers: Record<string, string>;
    body: string;
}

interface ConnectedMessage {
    type: 'connected';
    subdomain: string;
}

interface TunnelInfo {
    controlSocket: ServerWebSocket<TunnelData>;
    clientSockets: Set<ServerWebSocket<TunnelData>>;
    state: 'online' | 'offline';
    graceTimeout?: number;  // Timer ID for reconnection window
    lastActive: number;     // Timestamp for activity tracking
}

export interface TunnelServerOptions {
    tunnelPort?: number; // Port for the WS tunnel
    idleTimeout?: number;  // Time in ms before cleaning up idle tunnels
    reconnectGrace?: number;  // Time in ms to allow for reconnection
}

const DEFAULT_OPTIONS = {
    tunnelPort: 4444,
    idleTimeout: 5 * 60 * 1000,  // 5 minutes
    reconnectGrace: 1000  // 1 second
};

class TunnelServer {
    private tunnels: Map<string, TunnelInfo>;
    private pendingRequests: Map<string, (response: Response) => void>;
    private options: Required<TunnelServerOptions>;
    private server?: Server;
    private monitorInterval?: number;

    constructor(options: TunnelServerOptions = {}) {
        this.options = {
            ...DEFAULT_OPTIONS,
            ...options
        };
        this.tunnels = new Map();
        this.pendingRequests = new Map();
    }

    public start(): void {
        // const serverConfig: any = {
        //     hostname: "0.0.0.0",
        //     port: this.options.tunnelPort,
        //     fetch: this.handleRequest.bind(this),
        //     websocket: {
        //         open: this.handleWebSocketOpen.bind(this),
        //         message: this.handleWebSocketMessage.bind(this),
        //         close: this.handleWebSocketClose.bind(this)
        //     }
        // };

        const host = "0.0.0.0";

        this.server = Bun.serve({
            hostname: host,
            port: this.options.tunnelPort,
            fetch: this.handleRequest.bind(this),
            websocket: {
                open: this.handleWebSocketOpen.bind(this),
                message: this.handleWebSocketMessage.bind(this),
                close: this.handleWebSocketClose.bind(this)
            }
        });

        // Start tunnel monitoring
        this.monitorInterval = setInterval(() => {
            this.monitorTunnels();
        }, 60000) as unknown as number;

        logger.info(`Tunnel server started on ws://${host}:${this.options.tunnelPort}`);
    }

    public stop(): void {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        this.server?.stop();
        this.tunnels.clear();
        this.pendingRequests.clear();
    }

    private monitorTunnels(): void {
        const now = Date.now();
        for (const [subdomain, tunnel] of this.tunnels) {
            // Clean up tunnels that have been idle too long
            if (now - tunnel.lastActive > this.options.idleTimeout) {
                logger.debug(`Cleaning up idle tunnel: ${subdomain}`);
                this.cleanupTunnel(subdomain);
                continue;
            }

            // Update activity timestamp for active tunnels
            if (tunnel.state === 'online') {
                tunnel.lastActive = now;
            }
        }
    }

    private async handleRequest(req: Request, server: Server): Promise<Response> {
        try {
            const url = new URL(req.url);
            const host = req.headers.get('host') || url.hostname;

            logger.debug("Got request:", req)
            logger.debug(`[REQUEST] ${new Date().toISOString()}`);
            logger.debug(`[REQUEST] URL: ${req.url}`);
            logger.debug(`[REQUEST] Method: ${req.method}`);
            logger.debug(`[REQUEST] Host header: ${host}`);
            logger.debug(`[REQUEST] URL hostname: ${url.hostname}`);
            
            // Handle health check for root path - only for non-WebSocket requests to the root domain
            // Handle health check for root path - only for non-WebSocket requests to the root domain
            if (req.method === 'GET' && url.pathname === '/' && 
                req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
                
                // Parse the host to check if it's a subdomain request
                const hostWithoutPort = host.includes(':') ? host.split(':')[0] : host;
                const hostParts = hostWithoutPort.split('.');
                
                // Check if this is a subdomain request (<id>.localhost)
                const isSubdomainRequest = hostParts.length === 2 && hostParts[1] === 'localhost';
                
                // Only respond to health check if it's NOT a subdomain request
                if (!isSubdomainRequest) {
                    logger.debug('[REQUEST] Returning health check 200 response')
                    return new Response('Tunnel server is running', { 
                        status: 200,
                        headers: { 'Content-Type': 'text/plain' }
                    });
                }
            }

            logger.debug('[REQUEST] Request to subdomain tunnel, forwarding')
            
            let parts: string[] = [];
            
            // Try both the Host header and URL hostname for parsing
            if (host.includes(':')) {
                // Remove port if present
                parts = host.split(':')[0].split('.');
                logger.debug(`[REQUEST] Host parts (from header): ${JSON.stringify(parts)}`);
            } else {
                parts = host.split('.');
                logger.debug(`[REQUEST] Host parts: ${JSON.stringify(parts)}`);
            }
            
            // Also log URL parts as fallback
            const urlParts = url.hostname.split('.');
            logger.debug(`[REQUEST] URL hostname parts: ${JSON.stringify(urlParts)}`);
            
            // Log all headers for debugging
            logger.debug('[REQUEST] Headers:');
            const allHeaders: Record<string, string> = {};
            req.headers.forEach((value, key) => {
                allHeaders[key] = value;
                logger.debug(`[REQUEST]   ${key}: ${value}`);
            });

            // Check if this is a WebSocket upgrade request
            const upgradeHeader = req.headers.get('upgrade');
            logger.debug(`[REQUEST] Upgrade header: ${upgradeHeader}`);
            
            if (upgradeHeader?.toLowerCase() === 'websocket') {
                try {
                    logger.debug(`[WS] Processing WebSocket upgrade request`);
                    logger.debug(`[WS] Host parts length: ${parts.length}`);
                    logger.debug(`[WS] First part: '${parts[0]}', Second part (if exists): '${parts[1]}'`);
                    
                    // Check if direct connection (for new tunnel) - accept any non-subdomain host
                    // This handles both localhost:4444 and api.app.magnitude.run:4444
                    const isLocalhostSubdomain = parts.length >= 2 && parts[parts.length - 1] === 'localhost';

                    if (isLocalhostSubdomain) {
                        const subdomain = parts[0];
                        logger.debug(`[WS] Identified as client connection for subdomain: ${subdomain}`);
                        
                        const tunnel = this.tunnels.get(subdomain);
                        if (!tunnel) {
                            logger.debug(`[WS] No tunnel found for subdomain: ${subdomain}`);
                            return new Response('Tunnel not found', { status: 404 });
                        }
                        
                        const success = server.upgrade(req, {
                            data: { subdomain, isControl: false }
                        });
                        
                        logger.debug(`[WS] Client upgrade result: ${success ? 'Success' : 'Failed'}`);
                        return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
                    } else {
                        logger.debug('[WS] Identified as new tunnel control connection');
                        const subdomain = this.generateSubdomain();
                        logger.debug(`[WS] Generated subdomain: ${subdomain}`);
                        
                        const success = server.upgrade(req, {
                            data: { subdomain, isControl: true }
                        });
                        
                        logger.debug(`[WS] Upgrade result: ${success ? 'Success' : 'Failed'}`);
                        return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
                    }
                    // // If we get here, neither parsing method worked
                    // logger.debug(`[WS] Invalid WebSocket connection request`);
                    // logger.debug(`[WS] Expected formats:`);
                    // logger.debug(`[WS]   - some.domain.com:${this.options.tunnelPort} (for control connection)`);
                    // logger.debug(`[WS]   - localhost:${this.options.tunnelPort} (for control connection)`);
                    // logger.debug(`[WS]   - <subdomain>.localhost:${this.options.tunnelPort} (for client connection)`);
                    // logger.debug(`[WS] Actual host received: ${host}`);
                    
                    // return new Response('Invalid WebSocket connection request', { status: 400 });
                } catch (err) {
                    logger.error('[WS] Error handling WebSocket upgrade:', err);
                    return new Response('WebSocket upgrade failed', { status: 500 });
                }
            }

            // Handle regular HTTP requests
            if (parts.length === 2 && parts[1] === 'localhost') {
                logger.debug('[HTTP] Forwarding HTTP request')
                const subdomain = parts[0];
                const tunnel = this.tunnels.get(subdomain);
                
                if (!tunnel) {
                    logger.debug(`[HTTP] No tunnel found for ${subdomain}:`);
                    return new Response('Tunnel not found', { status: 404 });
                } else {
                    logger.debug(`[HTTP] Tunnel found for ${subdomain}:`, tunnel);
                }

                // Create unique request ID
                const requestId = Math.random().toString(36).substring(2);
                logger.debug(`[HTTP] Request ID generated: ${requestId}`);

                try {
                    // Prepare request data for tunnel
                    const tunnelRequest: TunnelRequest = {
                        id: requestId,
                        method: req.method,
                        path: url.pathname + url.search,
                        headers: this.headersToObject(req.headers),
                        body: req.body ? await req.text() : null
                    };

                    logger.debug('[HTTP] Sending request through tunnel socket:', tunnelRequest);
                    logger.debug(tunnelRequest);
                    logger.debug(tunnelRequest.body);

                    // Send request through control socket
                    tunnel.controlSocket.send(JSON.stringify(tunnelRequest));

                    // Wait for response with timeout
                    const response = await Promise.race([
                        new Promise<Response>((resolve) => {
                            this.pendingRequests.set(requestId, resolve);
                        }),
                        new Promise<Response>((_, reject) => {
                            setTimeout(() => {
                                this.pendingRequests.delete(requestId);
                                reject(new Error('Request timeout'));
                            }, 30000); // 30 second timeout
                        })
                    ]);

                    return response;
                } catch (err) {
                    logger.error('Error processing tunnel request:', err);
                    this.pendingRequests.delete(requestId);

                    if (err instanceof Error && err.message === 'Request timeout') {
                        return new Response('Request timeout', { status: 504 });
                    }

                    return new Response('Error processing request', { status: 500 });
                }
            }

            logger.debug('[REQUEST] No matching route found, returning 404');
            return new Response('Not found', { status: 404 });
        } catch (err) {
            logger.error('Unexpected error handling request:', err);
            return new Response('Internal server error', { status: 500 });
        }
    }

    private handleWebSocketOpen(ws: ServerWebSocket<TunnelData>): void {
        const subdomain = ws.data.subdomain;

        if (!subdomain) {
            logger.error('WebSocket opened without subdomain');
            ws.close();
            return;
        }

        logger.debug(`[WS_OPEN] New WebSocket connection for: ${subdomain}, isControl: ${ws.data.isControl}`);

        // Handle control connection (from bunnel CLI)
        if (ws.data.isControl) {
            const existingTunnel = this.tunnels.get(subdomain);

            if (existingTunnel && existingTunnel.state === 'offline') {
                // Reconnection during grace period
                clearTimeout(existingTunnel.graceTimeout);
                existingTunnel.controlSocket = ws;
                existingTunnel.state = 'online';
                existingTunnel.lastActive = Date.now();
                logger.debug(`Tunnel ${subdomain} reconnected`);
            } else {
                // New tunnel connection
                const tunnelInfo: TunnelInfo = {
                    controlSocket: ws,
                    clientSockets: new Set(),
                    state: 'online',
                    lastActive: Date.now()
                };
                this.tunnels.set(subdomain, tunnelInfo);
                logger.debug(`Control connection opened for subdomain: ${subdomain}`);
            }

            try {
                const message: ConnectedMessage = { type: 'connected', subdomain };
                ws.send(JSON.stringify(message));
                logger.debug(`[WS_OPEN] Sent connected message to control connection for: ${subdomain}`);
            } catch (err) {
                logger.error(`Error sending initial message to ${subdomain}:`, err);
                this.cleanupWebSocket(ws);
            }
            return;
        }

        // Handle client connection (to be tunneled)
        const tunnel = this.tunnels.get(subdomain);
        if (!tunnel) {
            logger.error(`No tunnel found for subdomain: ${subdomain}`);
            ws.close();
            return;
        }

        tunnel.clientSockets.add(ws);
        logger.debug(`Client connection added for subdomain: ${subdomain}, total clients: ${tunnel.clientSockets.size}`);
    }

    private handleWebSocketMessage(ws: ServerWebSocket<TunnelData>, message: string | Buffer): void {
        const subdomain = ws.data.subdomain;
        if (!subdomain) return;

        const tunnel = this.tunnels.get(subdomain);
        if (!tunnel) return;

        try {
            if (ws === tunnel.controlSocket) {
                // Handle messages from control connection
                const response = JSON.parse(message.toString()) as TunnelResponse;
                const resolve = this.pendingRequests.get(response.id);

                if (resolve) {
                    resolve(new Response(response.body, {
                        status: response.status,
                        headers: response.headers
                    }));
                    this.pendingRequests.delete(response.id);
                }
            } else {
                // Handle messages from client connections
                // Forward to control socket
                tunnel.controlSocket.send(message);
            }
        } catch (err) {
            logger.error('Error handling WebSocket message:', err);
            this.cleanupWebSocket(ws);
        }
    }

    private handleWebSocketClose(ws: ServerWebSocket<TunnelData>): void {
        const subdomain = ws.data.subdomain;
        if (!subdomain) return;

        const tunnel = this.tunnels.get(subdomain);
        if (!tunnel) return;

        if (ws === tunnel.controlSocket) {
            // Control socket disconnected - start grace period
            tunnel.state = 'offline';
            tunnel.graceTimeout = setTimeout(() => {
                logger.debug(`Grace period expired for tunnel: ${subdomain}`);
                this.cleanupTunnel(subdomain);
            }, this.options.reconnectGrace) as unknown as number;
            logger.debug(`Control connection lost for ${subdomain}, grace period started`);
        } else {
            // Client socket closed - just remove from set
            tunnel.clientSockets.delete(ws);
            tunnel.lastActive = Date.now(); // Update activity timestamp
            logger.debug(`Client connection closed for subdomain: ${subdomain}, remaining clients: ${tunnel.clientSockets.size}`);
        }
    }

    private cleanupTunnel(subdomain: string): void {
        const tunnel = this.tunnels.get(subdomain);
        if (!tunnel) return;

        // Clear any existing grace timeout
        if (tunnel.graceTimeout) {
            clearTimeout(tunnel.graceTimeout);
        }

        // Close all client sockets
        for (const clientSocket of tunnel.clientSockets) {
            try {
                clientSocket.close();
            } catch (err) {
                // Ignore errors during close
            }
        }

        // Close control socket if it's still open
        try {
            if (tunnel.controlSocket.readyState !== WebSocket.CLOSED) {
                tunnel.controlSocket.close();
            }
        } catch (err) {
            // Ignore errors during close
        }

        // Clean up maps
        this.tunnels.delete(subdomain);

        // Clean up any pending requests
        for (const [id, resolve] of this.pendingRequests) {
            resolve(new Response('Tunnel connection lost', { status: 502 }));
            this.pendingRequests.delete(id);
        }

        logger.debug(`Tunnel cleaned up for subdomain: ${subdomain}`);
    }

    private cleanupWebSocket(ws: ServerWebSocket<TunnelData>): void {
        const subdomain = ws.data.subdomain;
        if (!subdomain) return;

        if (ws.data.isControl) {
            this.cleanupTunnel(subdomain);
        } else {
            const tunnel = this.tunnels.get(subdomain);
            if (tunnel) {
                tunnel.clientSockets.delete(ws);
            }
        }

        if (ws.readyState !== WebSocket.CLOSED) {
            try {
                ws.close();
            } catch (err) {
                // Ignore errors during close
            }
        }
    }

    private generateSubdomain(): string {
        return createId();
    }

    private headersToObject(headers: Headers): Record<string, string> {
        const obj: Record<string, string> = {};
        headers.forEach((value, key) => {
            obj[key] = value;
        });
        return obj;
    }
}

export default TunnelServer;
