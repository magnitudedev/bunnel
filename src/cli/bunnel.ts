#!/usr/bin/env node
import { Command } from 'commander';
import { TunnelClient } from '../client/index.js';

interface ClientOptions {
  local: string;
  tunnel: string;
}

interface ServerOptions {
  port: string;
  cert?: string;
  key?: string;
  ca?: string[];
}

const program = new Command();

program
  .name('bunnel')
  .description('HTTP tunnel for local development')
  .version('0.1.0');

program
  .command('client')
  .description('Start a tunnel client')
  .option('-l, --local <url>', 'local server URL', 'http://localhost:8000')
  .option('-t, --tunnel <url>', 'tunnel server URL', 'wss://localhost:3000')
  .action((options: ClientOptions) => {
    const tunnel = new TunnelClient({
      localServerUrl: options.local,
      tunnelServerUrl: options.tunnel,
      onConnected: (subdomain) => {
        console.log(`✨ Tunnel established!`);
        const protocol = options.tunnel.startsWith('wss://') ? 'https://' : 'http://';
        const port = new URL(options.tunnel).port || (protocol === 'https://' ? '443' : '80');
        console.log(`🌍 Your local server is now available at: ${protocol}${subdomain}.localhost:${port}`);
      },
      onClosed: () => {
        console.log('🔌 Tunnel closed');
        process.exit(0);
      },
      onError: (error) => {
        console.error('❌ Tunnel error:', error);
      }
    });

    console.log(`📡 Connecting to tunnel server at ${options.tunnel}...`);
    console.log(`🔄 Will forward requests to ${options.local}`);
    
    tunnel.connect();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down tunnel...');
      tunnel.disconnect();
    });
  });

program
  .command('server')
  .description('Start a tunnel server')
  .option('-p, --port <number>', 'port to listen on', '3000')
  .option('--cert <path>', 'path to SSL certificate file')
  .option('--key <path>', 'path to SSL private key file')
  .option('--ca <paths...>', 'paths to CA certificate files')
  .action(async (options: ServerOptions) => {
    const { port, cert, key, ca } = options;
    
    // Validate SSL configuration
    if ((cert && !key) || (!cert && key)) {
      console.error('❌ Both --cert and --key must be provided for SSL');
      process.exit(1);
    }

    // Set environment variables
    process.env.PORT = port;
    if (cert) process.env.BUNNEL_CERT_PATH = cert;
    if (key) process.env.BUNNEL_KEY_PATH = key;
    if (ca) process.env.BUNNEL_CA_PATHS = ca.join(',');
    
    const protocol = cert ? 'wss' : 'ws';
    console.log(`🚀 Starting tunnel server on ${protocol}://localhost:${port}...`);
    
    // Import server dynamically since it's not included in npm package
    const serverPath = new URL('../server/server.ts', import.meta.url);
    
    try {
      await import(serverPath.toString());
    } catch (error) {
      console.error('❌ Failed to start server:', error);
      process.exit(1);
    }
  });

program.parse();
