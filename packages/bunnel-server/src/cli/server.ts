#!/usr/bin/env bun
import { Command } from 'commander';
import type { TunnelServerOptions } from '../server/server.js';

interface ServerOptions {
    port: string;
    proxy: string;
    cert?: string;
    key?: string;
    ca?: string[];
}

const program = new Command();
program
    .name('bunnel-server')
    .description('HTTP tunnel server for local development')
    .version('0.1.0')
    .option('-p, --port <number>', 'port for tunnel to listen on', '4444')
    .option('-x, --proxy <number>', 'port for proxy to listen on', '5555')
    .option('--cert <path>', 'path to SSL certificate file')
    .option('--key <path>', 'path to SSL private key file')
    .option('--ca <paths...>', 'paths to CA certificate files')
    .action(async (options: ServerOptions) => {
        const { port, proxy, cert, key, ca } = options;
        // Validate SSL configuration
        if ((cert && !key) || (!cert && key)) {
            console.error('❌ Both --cert and --key must be provided for SSL');
            process.exit(1);
        }

        const serverOptions: TunnelServerOptions = {
            tunnelPort: parseInt(port),
            proxyPort: parseInt(proxy)
        };

        // Add TLS configuration if SSL certificates are provided
        if (cert && key) {
            serverOptions.tls = {
                cert,
                key,
                ca
            };
        }

        const protocol = cert ? 'wss' : 'ws';
        console.log(`🚀 Starting tunnel server on ${protocol}://localhost:${port}...`);

        try {
            const { default: TunnelServer } = await import('../server/server.js');
            const server = new TunnelServer(serverOptions);
            server.start();

            // Handle graceful shutdown
            process.on('SIGINT', () => {
                console.log('\n🛑 Shutting down server...');
                server.stop();
                process.exit(0);
            });
        } catch (error) {
            console.error('❌ Failed to start server:', error);
            process.exit(1);
        }
    });

program.parse();
