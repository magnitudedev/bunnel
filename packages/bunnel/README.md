# Bunnel Client

## Installation

```bash
npm install bunnel
# or for global/CLI use
npm install -g bunnel
```

## Usage

### CLI

```bash
# Specify local server and tunnel server
bunnel client --local http://localhost:3000 --tunnel wss://example.com:4444
```

### SDK

```javascript
import { TunnelClient } from 'bunnel';

const tunnel = new TunnelClient({
    localServerUrl: 'http://localhost:3000',
    tunnelServerUrl: 'wss://example.com:4444',
    onClosed: () => console.log('Tunnel closed')
});

try {
    const { subdomain, tunnelUrl, proxyUrl } = await tunnel.connect();
    console.log(`Tunnel available on remote at: ${tunnelUrl} or ${proxyUrl}`);

    // Later, to disconnect
    tunnel.disconnect();
} catch (error) {
    console.error('Tunnel error:', error);
}
```

## Options

- `--local, -l`: Local server URL)
- `--tunnel, -t`: Tunnel server URL)
