import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

interface WebSocketData {
  url?: string;
  secureWs?: WebSocket;
}

export class LocalProxyServer {
  private securePort: number;

  constructor(securePort: number) {
    this.securePort = securePort;
  }

  start(): Server {
    // Allow self-signed certificates
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    
    return Bun.serve({
      port: this.securePort + 1,
      fetch: async (req, server) => {
        try {
          const url = new URL(req.url);
          
          // Check if this is a WebSocket upgrade request
          const upgradeHeader = req.headers.get('upgrade');
          if (upgradeHeader?.toLowerCase() === 'websocket') {
            // Upgrade the connection and store the URL
            const success = server.upgrade(req, {
              data: { url: req.url }
            });
            return success ? new Response() : new Response('WebSocket upgrade failed', { status: 500 });
          }

          // Forward HTTP requests
          const secureUrl = new URL(`https://localhost:${this.securePort}${url.pathname}${url.search}`);
          const response = await fetch(secureUrl, {
            method: req.method,
            headers: req.headers,
            body: req.body,
            //@ts-ignore
            secure: false,
            redirect: 'follow'
          });

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        } catch (err) {
          console.error('Error in proxy server:', err);
          return new Response('Proxy server error', { status: 500 });
        }
      },
      websocket: {
        open: (ws: ServerWebSocket<WebSocketData>) => {
          try {
            // Create WebSocket connection to secure server with same path
            const url = new URL(ws.data.url || '');
            const secureWs = new WebSocket(
              `wss://localhost:${this.securePort}${url.pathname}${url.search}`
            );

            // Wait for secure connection to be established
            secureWs.onopen = () => {
              // Forward messages from secure server to client
              secureWs.onmessage = (event) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(event.data);
                }
              };

              // Store secure WebSocket in data
              ws.data.secureWs = secureWs;
            };

            // Handle connection errors
            secureWs.onerror = (error) => {
              console.error('Secure WebSocket connection error:', error);
              ws.close();
            };
          } catch (err) {
            console.error('Error establishing secure WebSocket connection:', err);
            ws.close();
          }
        },
        message: (ws: ServerWebSocket<WebSocketData>, message: string | Buffer) => {
          try {
            // Forward messages from client to secure server
            const secureWs = ws.data.secureWs;
            if (secureWs?.readyState === WebSocket.OPEN) {
              secureWs.send(message);
            }
          } catch (err) {
            console.error('Error forwarding message:', err);
            ws.close();
          }
        },
        close: (ws: ServerWebSocket<WebSocketData>) => {
          try {
            // Close secure WebSocket when client disconnects
            ws.data.secureWs?.close();
          } catch (err) {
            console.error('Error closing secure WebSocket:', err);
          }
        }
      }
    });
  }
}
