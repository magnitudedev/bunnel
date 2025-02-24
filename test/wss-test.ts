import selfsigned from 'selfsigned';
import { WebSocket } from "ws";

// Allow self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Generate self-signed cert
const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }]);

// Start WSS server
const serverConfig: any = {
  port: 3000,
  tls: {
    key: pems.private,
    cert: pems.cert,
  },
  fetch(req, server) {
    if (server.upgrade(req)) {
      return;
    }
    return new Response("Upgrade failed", { status: 500 });
  },
  websocket: {
    open(ws) {
      console.log("Server: Client connected!");
      ws.send("Hello from secure server!");
    },
    message(ws, message) {
      console.log(`Server: Received: ${message}`);
      ws.send(`Echo: ${message}`);
    },
    close(ws) {
      console.log("Server: Client disconnected!");
    }
  }
};

const server = Bun.serve(serverConfig);

console.log(`Server started on wss://localhost:${server.port}`);

// Test client
const ws = new WebSocket(`wss://localhost:${server.port}`);

ws.addEventListener('open', () => {
  console.log("Client: Connected to server");
  ws.send("Hello from client!");
});

ws.addEventListener('message', (event) => {
  console.log(`Client: Received: ${event.data}`);
});

ws.addEventListener('close', (event) => {
  console.log(`Client: Disconnected (code: ${event.code}, reason: ${event.reason})`);
  server.stop();
  process.exit(0);
});

ws.addEventListener('error', (error) => {
  console.error('Client: WebSocket error:', error);
  server.stop();
  process.exit(1);
});
