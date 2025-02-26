#!/usr/bin/env bun
import { Command } from 'commander';
import type { TunnelServerOptions } from '../server/server.js';

interface ServerOptions {
    port: string;
}

const program = new Command();
program
    .name('bunnel-server')
    .description('HTTP tunnel server for local development')
    .version('0.1.0')
    .option('-p, --port <number>', 'port for tunnel to listen on', '4444')
    .action(async (options: ServerOptions) => {
        const { port } = options;

        const serverOptions: TunnelServerOptions = {
            tunnelPort: parseInt(port)
        };

        console.log(`🚀 Starting tunnel server on ws://0.0.0.0:${port}...`);

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
