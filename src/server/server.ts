import type { Server, ServerWebSocket } from "bun";

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

interface TunnelServerOptions {
  port?: number;
  idleTimeout?: number;  // Time in ms before cleaning up idle tunnels
  reconnectGrace?: number;  // Time in ms to allow for reconnection
  tls?: {
    cert: string;    // Path to certificate file
    key: string;     // Path to private key file
    ca?: string[];   // Optional CA certificates
  };
}

const DEFAULT_OPTIONS = {
  port: 3000,
  idleTimeout: 5 * 60 * 1000,  // 5 minutes
  reconnectGrace: 1000,  // 1 second
  tls: undefined
};

class TunnelServer {
  private tunnels: Map<string, TunnelInfo>;
  private pendingRequests: Map<string, (response: Response) => void>;
  private options: Required<Omit<TunnelServerOptions, 'tls'>> & Pick<TunnelServerOptions, 'tls'>;
  private server?: Server;
  private monitorInterval?: number;

  constructor(options: TunnelServerOptions = {}) {
    this.options = { 
      ...DEFAULT_OPTIONS, 
      ...options,
      port: options.port ?? DEFAULT_OPTIONS.port,
      idleTimeout: options.idleTimeout ?? DEFAULT_OPTIONS.idleTimeout,
      reconnectGrace: options.reconnectGrace ?? DEFAULT_OPTIONS.reconnectGrace
    };
    this.tunnels = new Map();
    this.pendingRequests = new Map();
  }

  public start(): void {
    const serverConfig: any = {
      port: this.options.port,
      fetch: this.handleRequest.bind(this),
      websocket: {
        open: this.handleWebSocketOpen.bind(this),
        message: this.handleWebSocketMessage.bind(this),
        close: this.handleWebSocketClose.bind(this)
      }
    };

    // Add TLS configuration if provided
    if (this.options.tls) {
      try {
        const { cert, key, ca } = this.options.tls;
        serverConfig.tls = {
          cert: Bun.file(cert),
          key: Bun.file(key),
        };
        if (ca) {
          serverConfig.tls.ca = ca.map(caPath => Bun.file(caPath));
        }
      } catch (err) {
        console.error('Failed to load TLS certificates:', err);
        throw new Error('Failed to load TLS certificates. Please check your certificate paths.');
      }
    }

    this.server = Bun.serve(serverConfig);

    // Start tunnel monitoring
    this.monitorInterval = setInterval(() => {
      this.monitorTunnels();
    }, 60000) as unknown as number;

    const protocol = this.options.tls ? 'wss' : 'ws';
    console.log(`Tunnel server started on ${protocol}://localhost:${this.options.port}`);
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
      const host = url.hostname;
      const parts = host.split('.');
      
      // Check if this is a WebSocket upgrade request
      const upgradeHeader = req.headers.get('upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        try {
          if (parts.length === 1 && parts[0] === 'localhost') {
            // New tunnel connection at localhost:<port>
            console.log('Processing new tunnel connection');
            const subdomain = this.generateSubdomain();
            const success = server.upgrade(req, {
              data: { subdomain, isControl: true }
            });
            return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
          }

          if (parts.length === 2 && parts[1] === 'localhost') {
            // Client connection at <subdomain>.localhost:<port>
            const subdomain = parts[0];
            console.log(`Processing client connection for subdomain: ${subdomain}`);
            
            const tunnel = this.tunnels.get(subdomain);
            if (!tunnel) {
              console.log(`No tunnel found for subdomain: ${subdomain}`);
              return new Response('Tunnel not found', { status: 404 });
            }
            
            const success = server.upgrade(req, {
              data: { subdomain, isControl: false }
            });
            console.log(`Upgraded client connection for subdomain: ${subdomain}`);
            return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
          }

          console.log('Invalid WebSocket connection request');
          return new Response('Invalid WebSocket connection request', { status: 400 });
        } catch (err) {
          console.error('Error handling WebSocket upgrade:', err);
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
    console.log(`Client connection added for subdomain: ${subdomain}`);
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
      console.log(`Client connection closed for subdomain: ${subdomain}`);
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
    return Math.random().toString(36).substring(2, 8);
  }

  private headersToObject(headers: Headers): Record<string, string> {
    const obj: Record<string, string> = {};
    headers.forEach((value, key) => {
      obj[key] = value;
    });
    return obj;
  }
}

// Create and start the tunnel server
const serverOptions: TunnelServerOptions = {
  port: process.env.PORT ? parseInt(process.env.PORT) : undefined
};

// Configure TLS if certificate and key are provided
if (process.env.BUNNEL_CERT_PATH && process.env.BUNNEL_KEY_PATH) {
  serverOptions.tls = {
    cert: process.env.BUNNEL_CERT_PATH,
    key: process.env.BUNNEL_KEY_PATH,
  };

  // Add CA certificates if provided
  if (process.env.BUNNEL_CA_PATHS) {
    serverOptions.tls.ca = process.env.BUNNEL_CA_PATHS.split(',');
  }
}

const server = new TunnelServer(serverOptions);
server.start();

export default TunnelServer;
