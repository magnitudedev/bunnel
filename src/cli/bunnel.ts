#!/usr/bin/env node
import { Command } from 'commander';
import { TunnelClient } from '../client/index.js';

interface ClientOptions {
  local: string;
  tunnel: string;
}

interface ServerOptions {
  port: string;
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
  .option('-t, --tunnel <url>', 'tunnel server URL', 'ws://localhost:3000/tunnel')
  .action((options: ClientOptions) => {
    const tunnel = new TunnelClient({
      localServerUrl: options.local,
      tunnelServerUrl: options.tunnel,
      onConnected: (subdomain) => {
        console.log(`✨ Tunnel established!`);
        console.log(`🌍 Your local server is now available at: ${subdomain}.localhost:3000`);
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
  .action(async (options: ServerOptions) => {
    const { port } = options;
    
    console.log(`🚀 Starting tunnel server on port ${port}...`);
    
    // Import server dynamically since it's not included in npm package
    const serverPath = new URL('../server/tunnel_server.ts', import.meta.url);
    
    // Set environment variable for port
    process.env.PORT = port;
    
    try {
      await import(serverPath.toString());
    } catch (error) {
      console.error('❌ Failed to start server:', error);
      process.exit(1);
    }
  });

program.parse();
