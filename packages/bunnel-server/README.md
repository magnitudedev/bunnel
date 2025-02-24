# Bunnel Server

## Installation

### Global Installation

```bash
npm install -g bunnel-server
```

### Local Installation

```bash
npm install bunnel-server
```

## Usage

### Command Line

```bash
# Start a tunnel server with default options
bunnel-server

# Specify ports
bunnel-server --port 4444 --proxy 5555

# Use custom SSL certificates (instead of self-signed)
bunnel-server --cert /path/to/cert.pem --key /path/to/key.pem
```

### Programmatic Usage

```javascript
import TunnelServer from 'bunnel-server';

const server = new TunnelServer({
  tunnelPort: 4444,
  proxyPort: 5555,
  // Optional TLS configuration
  tls: {
    cert: '/path/to/cert.pem',
    key: '/path/to/key.pem'
  }
});

// Start the server
server.start();

// Later, to stop the server
server.stop();
```

## Options

- `--port, -p`: Port for tunnel to listen on (default: 4444)
- `--proxy, -x`: Port for proxy to listen on (default: 5555)
- `--cert`: Path to SSL certificate file
- `--key`: Path to SSL private key file
- `--ca`: Paths to CA certificate files

## Requirements

Bunnel Server requires [Bun](https://bun.sh/) to run.

