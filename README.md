# Bunnel

A simple HTTP tunnel client for local development. Bunnel allows you to expose your local server to the internet through a WebSocket tunnel.

## Installation

```bash
npm install -g bunnel
```

## CLI Usage

Bunnel provides a command-line interface for both the client and server components.

### Starting the Server

```bash
# Start the tunnel server on default port 3000
bunnel server

# Start the tunnel server on a custom port
bunnel server --port 8080
```

### Starting the Client

```bash
# Connect to a local server (default: http://localhost:8000)
bunnel client

# Connect to a local server on a different port
bunnel client --local http://localhost:3000

# Connect to a remote tunnel server
bunnel client --tunnel ws://your-tunnel-server.com/tunnel
```

### CLI Options

#### Server Command
- `-p, --port <number>` - Port to listen on (default: 3000)

#### Client Command
- `-l, --local <url>` - Local server URL (default: http://localhost:8000)
- `-t, --tunnel <url>` - Tunnel server URL (default: ws://localhost:3000/tunnel)

## Programmatic Usage

You can also use Bunnel programmatically in your Node.js applications:

```typescript
import { TunnelClient } from 'bunnel';

const tunnel = new TunnelClient({
  // Optional: Configure local server URL (defaults to http://localhost:8000)
  localServerUrl: 'http://localhost:3000',
  
  // Optional: Configure tunnel server URL (defaults to ws://localhost:3000/tunnel)
  tunnelServerUrl: 'ws://your-tunnel-server.com/tunnel',
  
  // Optional: Event handlers
  onConnected: (subdomain) => {
    console.log(`Tunnel established at: ${subdomain}.your-tunnel-server.com`);
  },
  onClosed: () => {
    console.log('Tunnel closed');
  },
  onError: (error) => {
    console.error('Tunnel error:', error);
  }
});

// Connect to tunnel server
tunnel.connect();

// Later: Disconnect when done
tunnel.disconnect();
```

## API

### TunnelClient

#### Constructor Options

- `localServerUrl?: string` - URL of your local server (default: "http://localhost:8000")
- `tunnelServerUrl?: string` - URL of the tunnel server (default: "ws://localhost:3000/tunnel")
- `onConnected?: (subdomain: string) => void` - Called when tunnel is established
- `onClosed?: () => void` - Called when tunnel is closed
- `onError?: (error: Error) => void` - Called when an error occurs

#### Methods

- `connect(): void` - Connect to the tunnel server
- `disconnect(): void` - Disconnect from the tunnel server
- `isConnected(): boolean` - Check if connected to the tunnel server

## How it Works

1. The tunnel server generates a random subdomain for each client connection
2. When a client connects via WebSocket, they receive their assigned subdomain
3. HTTP requests to `[subdomain].localhost:3000` are forwarded through the WebSocket to the client
4. The client forwards these requests to the local server and sends responses back through the tunnel

## Development

The project is structured to separate the client library (published to npm) from the server code:

```
src/
  ├── client/         # npm package code
  │   ├── index.ts   # Main client library
  │   └── types.ts   # Shared types
  ├── cli/           # Command-line interface
  │   └── bunnel.ts  # CLI implementation
  └── server/        # Server code (not published)
      └── tunnel_server.ts
```

### Building

```bash
npm run build
```

This will compile the client library and CLI to the `dist/` directory.

## License

MIT
