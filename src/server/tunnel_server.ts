import type { Server, ServerWebSocket } from "bun";

interface TunnelData {
  subdomain: string;
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

const tunnels = new Map<string, ServerWebSocket<TunnelData>>();
const pendingRequests = new Map<string, (response: Response) => void>();

// Generate a random subdomain
function generateSubdomain(): string {
  return Math.random().toString(36).substring(2, 8);
}

// Convert regular headers to Record<string, string>
function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

console.log("Starting tunnel server on port 3000...");

Bun.serve({
  port: 3000,
  async fetch(req: Request, server: Server): Promise<Response> {
    const url = new URL(req.url);
    
    // WebSocket upgrade request for new tunnel
    if (url.pathname === '/tunnel') {
      const success = server.upgrade(req, {
        data: { subdomain: generateSubdomain() }
      });
      return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
    }

    const host = url.hostname;
    const subdomain = host.split('.')[0];

    // Handle HTTP requests to be tunneled
    const tunnel = tunnels.get(subdomain);
    if (!tunnel) {
      return new Response('Tunnel not found', { status: 404 });
    }

    // Create unique request ID
    const requestId = Math.random().toString(36).substring(2);

    // Prepare request data for tunnel
    const tunnelRequest: TunnelRequest = {
      id: requestId,
      method: req.method,
      path: url.pathname + url.search,
      headers: headersToObject(req.headers),
      body: req.body ? await req.text() : null
    };

    // Send request through WebSocket
    tunnel.send(JSON.stringify(tunnelRequest));

    // Wait for response
    const response = await new Promise<Response>((resolve) => {
      pendingRequests.set(requestId, resolve);
    });

    return response;
  },
  websocket: {
    open(ws: ServerWebSocket<TunnelData>) {
      const subdomain = ws.data.subdomain;
      tunnels.set(subdomain, ws);
      console.log(`Tunnel opened for subdomain: ${subdomain}`);
      const message: ConnectedMessage = { type: 'connected', subdomain };
      ws.send(JSON.stringify(message));
    },
    message(ws: ServerWebSocket<TunnelData>, message: string | Buffer) {
      const response = JSON.parse(message.toString()) as TunnelResponse;
      const resolve = pendingRequests.get(response.id);
      
      if (resolve) {
        resolve(new Response(response.body, {
          status: response.status,
          headers: response.headers
        }));
        pendingRequests.delete(response.id);
      }
    },
    close(ws: ServerWebSocket<TunnelData>) {
      const subdomain = ws.data.subdomain;
      tunnels.delete(subdomain);
      console.log(`Tunnel closed for subdomain: ${subdomain}`);
    }
  }
});
