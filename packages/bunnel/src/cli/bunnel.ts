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
    .command('client')
    .description('Bunnel client')
    .option('-l, --local <url>', 'local server URL')
    .option('-t, --tunnel <url>', 'tunnel server URL')
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
            const { subdomain, tunnelUrl, proxyUrl } = await tunnel.connect();

            console.log(`Tunnel to ${localServerUrl} available on remote:`);
            console.log(`🔒 Secure: ${tunnelUrl}`);
            console.log(`📨 Proxy: ${proxyUrl}`);

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
