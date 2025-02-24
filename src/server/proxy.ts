import { Server } from "bun";

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
      fetch: async (req) => {
        const url = new URL(req.url);
        const host = url.hostname; // Get original hostname (e.g. subdomain.localhost)
        
        // Forward to secure server with original host
        const secureUrl = new URL(`https://localhost:${this.securePort}${url.pathname}${url.search}`);
        
        // Create new headers with original host
        const headers = new Headers(req.headers);
        headers.set('host', host);
        
        // Forward the request, including method, headers, body
        return fetch(secureUrl, {
          method: req.method,
          headers: headers,
          body: req.body,
          // Trust self-signed cert when forwarding
          //@ts-ignore
          secure: false
        });
      }
    });
  }
}
