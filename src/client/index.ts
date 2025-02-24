import type { TunnelRequest, TunnelResponse, ConnectedMessage } from './types';

export interface TunnelClientOptions {
    /**
     * The URL of your local server that will receive the tunneled requests
     * @default "http://localhost:8000"
     */
    localServerUrl?: string;

    /**
     * The URL of the tunnel server
     * @default "wss://localhost:3000"
     */
    tunnelServerUrl?: string;

    /**
     * Called when the tunnel is established
     */
    onConnected?: (subdomain: string) => void;

    /**
     * Called when the tunnel is closed
     */
    onClosed?: () => void;

    /**
     * Called when an error occurs
     */
    onError?: (error: Error) => void;
}

export class TunnelClient {
    private ws: WebSocket | null = null;
    private localServerUrl: string;
    private tunnelServerUrl: string;
    private options: TunnelClientOptions;

    constructor(options: TunnelClientOptions = {}) {
        this.options = options;
        this.localServerUrl = options.localServerUrl || "http://localhost:8000";
        this.tunnelServerUrl = options.tunnelServerUrl || "wss://localhost:3000";
    }

    /**
     * Connect to the tunnel server
     */
    public connect(): void {
        if (this.ws) {
            throw new Error("Already connected");
        }

        console.log("Connecting to tunnel server...");
        
        // Temporarily allow self-signed TLS connections as we connect to WSS proxy
        const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        this.ws = new WebSocket(this.tunnelServerUrl);
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;

        this.ws.onopen = () => {
            console.log("Connected to tunnel server");
        };

        this.ws.onmessage = async (event) => {
            const data = JSON.parse(event.data.toString());

            if (data.type === "connected") {
                const message = data as ConnectedMessage;
                const tunnelPort = new URL(this.tunnelServerUrl).port || "3000";
                const httpPort = parseInt(tunnelPort) + 1;
                console.log(`Tunnel established at: http://${message.subdomain}.localhost:${httpPort}`);
                this.options.onConnected?.(message.subdomain);
                return;
            }

            try {
                const request = data as TunnelRequest;

                // Forward request to local server
                const localResponse = await fetch(`${this.localServerUrl}${request.path}`, {
                    method: request.method,
                    headers: request.headers,
                    body: request.body
                });

                // Convert headers to plain object
                const headers: Record<string, string> = {};
                localResponse.headers.forEach((value, key) => {
                    headers[key] = value;
                });

                // Send response back through tunnel
                const tunnelResponse: TunnelResponse = {
                    id: request.id,
                    status: localResponse.status,
                    headers,
                    body: await localResponse.text()
                };

                this.ws?.send(JSON.stringify(tunnelResponse));
            } catch (error) {
                console.error("Error forwarding request:", error);

                // Handle errors
                const errorResponse: TunnelResponse = {
                    id: (data as TunnelRequest).id,
                    status: 502,
                    headers: {},
                    body: "Bad Gateway"
                };

                this.ws?.send(JSON.stringify(errorResponse));
                this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
            }
        };

        this.ws.onclose = () => {
            console.log("Disconnected from tunnel server");
            this.ws = null;
            this.options.onClosed?.();
        };

        this.ws.onerror = (event) => {
            console.error("WebSocket error:", event);
            const error = event instanceof Error ? event : new Error("WebSocket connection error");
            this.options.onError?.(error);
        };
    }

    /**
     * Disconnect from the tunnel server
     */
    public disconnect(): void {
        this.ws?.close();
        this.ws = null;
    }

    /**
     * Check if connected to the tunnel server
     */
    public isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
}

// Export types
export type { TunnelRequest, TunnelResponse, ConnectedMessage } from './types';
