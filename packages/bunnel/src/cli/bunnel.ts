#!/usr/bin/env node
import { Command } from 'commander';
import { TunnelClient } from '../client/index.js';

interface ClientOptions {
    local: string;
    tunnel: string;
}

const program = new Command();
program
    .name('bunnel')
    .description('Bunnel client')
    .requiredOption('-l, --local <url>', 'local server URL, for example http://localhost:3000')
    .requiredOption('-t, --tunnel <url>', 'tunnel server URL, for example, ws://myserver.com:4444')
    .action(async (options: ClientOptions) => {
        const localServerUrl = options.local;

        const tunnel = new TunnelClient({
            localServerUrl: localServerUrl,
            tunnelServerUrl: options.tunnel,
            onClosed: () => {
                console.log('🔌 Tunnel closed');
                process.exit(0);
            }
        });

        console.log(`📡 Connecting to tunnel server at ${options.tunnel}...`);
        console.log(`🔄 Will forward requests to ${options.local}`);

        try {
            const { subdomain, tunnelUrl } = await tunnel.connect();

            console.log(`Tunnel to ${localServerUrl} available on remote:`);
            console.log(`🌐 Tunnel URL: ${tunnelUrl}`);

            // Handle graceful shutdown
            process.on('SIGINT', () => {
                console.log('\n🛑 Shutting down tunnel...');
                tunnel.disconnect();
            });
        } catch (error) {
            console.error('❌ Tunnel error:', error);
            process.exit(1);
        }
    });

program.parse();
