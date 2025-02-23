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
}

interface TunnelServerOptions {
  port?: number;
}

class TunnelServer {
  private tunnels: Map<string, TunnelInfo>;
  private pendingRequests: Map<string, (response: Response) => void>;
  private port: number;
  private server?: Server;

  constructor(options: TunnelServerOptions = {}) {
    this.tunnels = new Map();
    this.pendingRequests = new Map();
    this.port = options.port || 3000;
  }

  public start(): void {
    this.server = Bun.serve({
      port: this.port,
      fetch: this.handleRequest.bind(this),
      websocket: {
        open: this.handleWebSocketOpen.bind(this),
        message: this.handleWebSocketMessage.bind(this),
        close: this.handleWebSocketClose.bind(this)
      }
    });
    console.log(`Tunnel server started on port ${this.port}`);
  }

  public stop(): void {
    this.server?.stop();
    this.tunnels.clear();
    this.pendingRequests.clear();
  }

  private async handleRequest(req: Request, server: Server): Promise<Response> {
    try {
      const url = new URL(req.url);
      const host = url.hostname;
      const parts = host.split('.');
      
      // Check if this is a WebSocket upgrade request
      const upgradeHeader = req.headers.get('upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        console.log(`WebSocket upgrade request for: ${url.pathname}`);
        try {
          // Control connection from bunnel CLI at /tunnel path
          if (url.pathname === '/tunnel') {
            console.log('Processing control connection request');
            const subdomain = this.generateSubdomain();
            const success = server.upgrade(req, {
              data: { subdomain, isControl: true }
            });
            return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
          }

          // All other WebSocket connections are treated as client connections to be tunneled
          if (parts.length === 2 && parts[1] === 'localhost') {
            const subdomain = parts[0];
            console.log(`Processing client connection for subdomain: ${subdomain}`);
            
            const tunnel = this.tunnels.get(subdomain);
            if (!tunnel) {
              console.log(`No tunnel found for subdomain: ${subdomain}`);
              return new Response('Tunnel not found', { status: 404 });
            }
            
            // Upgrade the connection with subdomain data
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
      const tunnelInfo: TunnelInfo = {
        controlSocket: ws,
        clientSockets: new Set()
      };
      this.tunnels.set(subdomain, tunnelInfo);
      console.log(`Control connection opened for subdomain: ${subdomain}`);
      
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
      // Control socket closed - cleanup entire tunnel
      this.cleanupTunnel(subdomain);
    } else {
      // Client socket closed - just remove from set
      tunnel.clientSockets.delete(ws);
      console.log(`Client connection closed for subdomain: ${subdomain}`);
    }
  }

  private cleanupTunnel(subdomain: string): void {
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel) return;

    // Close all client sockets
    for (const clientSocket of tunnel.clientSockets) {
      try {
        clientSocket.close();
      } catch (err) {
        // Ignore errors during close
      }
    }

    // Close control socket
    try {
      tunnel.controlSocket.close();
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
const server = new TunnelServer({
  port: process.env.PORT ? parseInt(process.env.PORT) : undefined
});
server.start();

export default TunnelServer;
