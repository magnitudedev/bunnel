import type { Server, ServerWebSocket } from "bun";
import selfsigned from 'selfsigned';
import { LocalProxyServer } from "./proxy";
import { init } from '@paralleldrive/cuid2';

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
    tunnelPort?: number; // Port for the WSS tunnel
    proxyPort?: number; // Port for the insecure local proxy to the tunnel
    idleTimeout?: number;  // Time in ms before cleaning up idle tunnels
    reconnectGrace?: number;  // Time in ms to allow for reconnection
    tls?: {
        cert: string;    // Path to certificate file
        key: string;     // Path to private key file
        ca?: string[];   // Optional CA certificates
    };
}

const DEFAULT_OPTIONS = {
    tunnelPort: 4444,
    proxyPort: 5555,
    idleTimeout: 5 * 60 * 1000,  // 5 minutes
    reconnectGrace: 1000,  // 1 second
    tls: undefined
};

class TunnelServer {
    private tunnels: Map<string, TunnelInfo>;
    private pendingRequests: Map<string, (response: Response) => void>;
    private options: Required<Omit<TunnelServerOptions, 'tls'>> & { tls: NonNullable<TunnelServerOptions['tls']> };
    private server?: Server;
    private proxyServer?: Server;
    private monitorInterval?: number;

    private generateCertificates() {
        const attrs = [{ name: 'commonName', value: 'localhost' }];
        const pems = selfsigned.generate(attrs, {
            days: 365,
            keySize: 2048,
            algorithm: 'sha256'
        });
        return {
            cert: pems.cert,
            key: pems.private
        };
    }

    constructor(options: TunnelServerOptions = {}) {
        console.log("HELLO")
        // Generate self-signed certificates if not provided
        if (!options.tls) {
            const certs = this.generateCertificates();
            options.tls = {
                cert: certs.cert,
                key: certs.key
            };
        }

        this.options = {
            ...DEFAULT_OPTIONS,
            ...options,
            tls: options.tls as NonNullable<TunnelServerOptions['tls']>
        };
        this.tunnels = new Map();
        this.pendingRequests = new Map();
    }

    public start(): void {
        const serverConfig: any = {
            port: this.options.tunnelPort,
            fetch: this.handleRequest.bind(this),
            websocket: {
                open: this.handleWebSocketOpen.bind(this),
                message: this.handleWebSocketMessage.bind(this),
                close: this.handleWebSocketClose.bind(this)
            }
        };

        // Add TLS configuration
        try {
            const { cert, key, ca } = this.options.tls;
            // If cert/key are file paths, load them with Bun.file
            // If they're certificate strings (from selfsigned), use them directly
            serverConfig.tls = {
                cert: cert.startsWith('-----BEGIN') ? cert : Bun.file(cert),
                key: key.startsWith('-----BEGIN') ? key : Bun.file(key),
            };
            if (ca) {
                serverConfig.tls.ca = ca.map(caPath => Bun.file(caPath));
            }
        } catch (err) {
            console.error('Failed to configure TLS:', err);
            throw new Error('Failed to configure TLS. Please check your certificate configuration.');
        }

        this.server = Bun.serve(serverConfig);

        // Start the HTTP proxy server
        const proxy = new LocalProxyServer(this.options.tunnelPort, this.options.proxyPort);
        this.proxyServer = proxy.start();

        // Start tunnel monitoring
        this.monitorInterval = setInterval(() => {
            this.monitorTunnels();
        }, 60000) as unknown as number;

        const protocol = this.options.tls ? 'wss' : 'ws';
        console.log(`Tunnel server started on ${protocol}://localhost:${this.options.tunnelPort}`);
        console.log(`Local HTTP access available on http://localhost:${this.options.proxyPort}`);
    }

    public stop(): void {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        this.server?.stop();
        this.proxyServer?.stop();
        this.tunnels.clear();
        this.pendingRequests.clear();
    }

    private monitorTunnels(): void {
        const now = Date.now();
        for (const [subdomain, tunnel] of this.tunnels) {
            // Clean up tunnels that have been idle too long
            if (now - tunnel.lastActive > this.options.idleTimeout) {
                console.log(`Cleaning up idle tunnel: ${subdomain}`);
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

            console.log("Got request:", req)
            
            // Handle health check for root path
            if (req.method === 'GET' && url.pathname === '/') {
                return new Response('Tunnel server is running', { 
                    status: 200,
                    headers: { 'Content-Type': 'text/plain' }
                });
            }
            
            // Enhanced logging: Log full request details
            console.log(`[REQUEST] ${new Date().toISOString()}`);
            console.log(`[REQUEST] URL: ${req.url}`);
            console.log(`[REQUEST] Method: ${req.method}`);
            console.log(`[REQUEST] Host header: ${host}`);
            console.log(`[REQUEST] URL hostname: ${url.hostname}`);
            
            let parts: string[] = [];
            
            // Try both the Host header and URL hostname for parsing
            if (host.includes(':')) {
                // Remove port if present
                parts = host.split(':')[0].split('.');
                console.log(`[REQUEST] Host parts (from header): ${JSON.stringify(parts)}`);
            } else {
                parts = host.split('.');
                console.log(`[REQUEST] Host parts: ${JSON.stringify(parts)}`);
            }
            
            // Also log URL parts as fallback
            const urlParts = url.hostname.split('.');
            console.log(`[REQUEST] URL hostname parts: ${JSON.stringify(urlParts)}`);
            
            // Log all headers for debugging
            console.log('[REQUEST] Headers:');
            const allHeaders: Record<string, string> = {};
            req.headers.forEach((value, key) => {
                allHeaders[key] = value;
                console.log(`[REQUEST]   ${key}: ${value}`);
            });

            // Check if this is a WebSocket upgrade request
            const upgradeHeader = req.headers.get('upgrade');
            console.log(`[REQUEST] Upgrade header: ${upgradeHeader}`);
            
            if (upgradeHeader?.toLowerCase() === 'websocket') {
                try {
                    console.log(`[WS] Processing WebSocket upgrade request`);
                    console.log(`[WS] Host parts length: ${parts.length}`);
                    console.log(`[WS] First part: '${parts[0]}', Second part (if exists): '${parts[1]}'`);
                    
                    // Check if direct localhost connection (for new tunnel)
                    if (parts.length === 1 && parts[0] === 'localhost') {
                        console.log('[WS] Identified as new tunnel connection at localhost');
                        const subdomain = this.generateSubdomain();
                        console.log(`[WS] Generated subdomain: ${subdomain}`);
                        
                        const success = server.upgrade(req, {
                            data: { subdomain, isControl: true }
                        });
                        
                        console.log(`[WS] Upgrade result: ${success ? 'Success' : 'Failed'}`);
                        return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
                    }
                    
                    // Check if subdomain.localhost connection (for client)
                    if (parts.length === 2 && parts[1] === 'localhost') {
                        const subdomain = parts[0];
                        console.log(`[WS] Identified as client connection for subdomain: ${subdomain}`);
                        
                        const tunnel = this.tunnels.get(subdomain);
                        if (!tunnel) {
                            console.log(`[WS] No tunnel found for subdomain: ${subdomain}`);
                            return new Response('Tunnel not found', { status: 404 });
                        }
                        
                        const success = server.upgrade(req, {
                            data: { subdomain, isControl: false }
                        });
                        
                        console.log(`[WS] Client upgrade result: ${success ? 'Success' : 'Failed'}`);
                        return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
                    }
                    
                    // Try alternative hostname parsing if previous checks failed
                    // This might help if there's an issue with how your infrastructure handles Host headers
                    if (urlParts.length === 1 && urlParts[0] === 'localhost') {
                        console.log('[WS] Alternative check: Identified as new tunnel connection');
                        const subdomain = this.generateSubdomain();
                        
                        const success = server.upgrade(req, {
                            data: { subdomain, isControl: true }
                        });
                        
                        console.log(`[WS] Alternative upgrade result: ${success ? 'Success' : 'Failed'}`);
                        return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
                    }
                    
                    if (urlParts.length === 2 && urlParts[1] === 'localhost') {
                        const subdomain = urlParts[0];
                        console.log(`[WS] Alternative check: Identified as client connection for subdomain: ${subdomain}`);
                        
                        const tunnel = this.tunnels.get(subdomain);
                        if (!tunnel) {
                            console.log(`[WS] Alternative check: No tunnel found for subdomain: ${subdomain}`);
                            return new Response('Tunnel not found', { status: 404 });
                        }
                        
                        const success = server.upgrade(req, {
                            data: { subdomain, isControl: false }
                        });
                        
                        console.log(`[WS] Alternative client upgrade result: ${success ? 'Success' : 'Failed'}`);
                        return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
                    }
                    
                    // If we get here, neither parsing method worked
                    console.log(`[WS] Invalid WebSocket connection request`);
                    console.log(`[WS] Expected formats:`);
                    console.log(`[WS]   - localhost:${this.options.tunnelPort} (for control connection)`);
                    console.log(`[WS]   - <subdomain>.localhost:${this.options.tunnelPort} (for client connection)`);
                    console.log(`[WS] Actual host received: ${host}`);
                    
                    return new Response('Invalid WebSocket connection request', { status: 400 });
                } catch (err) {
                    console.error('[WS] Error handling WebSocket upgrade:', err);
                    return new Response('WebSocket upgrade failed', { status: 500 });
                }
            }

            // Handle regular HTTP requests
            if (parts.length === 2 && parts[1] === 'localhost') {
                const subdomain = parts[0];
                const tunnel = this.tunnels.get(subdomain);
                if (!tunnel) {
                    return new Response('Tunnel not found', { status: 404 });
                }

                // Create unique request ID
                const requestId = Math.random().toString(36).substring(2);

                try {
                    // Prepare request data for tunnel
                    const tunnelRequest: TunnelRequest = {
                        id: requestId,
                        method: req.method,
                        path: url.pathname + url.search,
                        headers: this.headersToObject(req.headers),
                        body: req.body ? await req.text() : null
                    };

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
                    console.error('Error processing tunnel request:', err);
                    this.pendingRequests.delete(requestId);

                    if (err instanceof Error && err.message === 'Request timeout') {
                        return new Response('Request timeout', { status: 504 });
                    }

                    return new Response('Error processing request', { status: 500 });
                }
            }

            console.log('[REQUEST] No matching route found, returning 404');
            return new Response('Not found', { status: 404 });
        } catch (err) {
            console.error('Unexpected error handling request:', err);
            return new Response('Internal server error', { status: 500 });
        }
    }

    private handleWebSocketOpen(ws: ServerWebSocket<TunnelData>): void {
        const subdomain = ws.data.subdomain;

        if (!subdomain) {
            console.error('WebSocket opened without subdomain');
            ws.close();
            return;
        }

        console.log(`[WS_OPEN] New WebSocket connection for: ${subdomain}, isControl: ${ws.data.isControl}`);

        // Handle control connection (from bunnel CLI)
        if (ws.data.isControl) {
            const existingTunnel = this.tunnels.get(subdomain);

            if (existingTunnel && existingTunnel.state === 'offline') {
                // Reconnection during grace period
                clearTimeout(existingTunnel.graceTimeout);
                existingTunnel.controlSocket = ws;
                existingTunnel.state = 'online';
                existingTunnel.lastActive = Date.now();
                console.log(`Tunnel ${subdomain} reconnected`);
            } else {
                // New tunnel connection
                const tunnelInfo: TunnelInfo = {
                    controlSocket: ws,
                    clientSockets: new Set(),
                    state: 'online',
                    lastActive: Date.now()
                };
                this.tunnels.set(subdomain, tunnelInfo);
                console.log(`Control connection opened for subdomain: ${subdomain}`);
            }

            try {
                const message: ConnectedMessage = { type: 'connected', subdomain };
                ws.send(JSON.stringify(message));
                console.log(`[WS_OPEN] Sent connected message to control connection for: ${subdomain}`);
            } catch (err) {
                console.error(`Error sending initial message to ${subdomain}:`, err);
                this.cleanupWebSocket(ws);
            }
            return;
        }

        // Handle client connection (to be tunneled)
        const tunnel = this.tunnels.get(subdomain);
        if (!tunnel) {
            console.error(`No tunnel found for subdomain: ${subdomain}`);
            ws.close();
            return;
        }

        tunnel.clientSockets.add(ws);
        console.log(`Client connection added for subdomain: ${subdomain}, total clients: ${tunnel.clientSockets.size}`);
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
            console.error('Error handling WebSocket message:', err);
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
                console.log(`Grace period expired for tunnel: ${subdomain}`);
                this.cleanupTunnel(subdomain);
            }, this.options.reconnectGrace) as unknown as number;
            console.log(`Control connection lost for ${subdomain}, grace period started`);
        } else {
            // Client socket closed - just remove from set
            tunnel.clientSockets.delete(ws);
            tunnel.lastActive = Date.now(); // Update activity timestamp
            console.log(`Client connection closed for subdomain: ${subdomain}, remaining clients: ${tunnel.clientSockets.size}`);
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

        console.log(`Tunnel cleaned up for subdomain: ${subdomain}`);
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
