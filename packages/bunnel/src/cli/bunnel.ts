#!/usr/bin/env node
import { Command } from 'commander';
import { TunnelClient } from '../client/index.js';

interface ClientOptions {
    local: string;
    tunnel: string;
    selfSigned: boolean;
}

const program = new Command();
program
    .name('bunnel')
    .description('Bunnel client')
    .requiredOption('-l, --local <url>', 'local server URL, for example http://localhost:3000')
    .requiredOption('-t, --tunnel <url>', 'tunnel server URL, for example, wss://myserver.com:4444')
    .option('-s, --self-signed', 'allow self-signed SSL when connecting to tunnel server', false)
    .action(async (options: ClientOptions) => {
        const localServerUrl = options.local;

        const tunnel = new TunnelClient({
            localServerUrl: localServerUrl,
            tunnelServerUrl: options.tunnel,
            onClosed: () => {
                console.log('🔌 Tunnel closed');
                process.exit(0);
            },
            allowSelfSignedTunnel: options.selfSigned
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
