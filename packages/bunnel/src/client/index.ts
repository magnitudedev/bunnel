import type { TunnelRequest, TunnelResponse, ConnectedMessage } from './types';

export interface TunnelClientOptions {
    /**
     * The URL of your local server that will receive the tunneled requests
     */
    localServerUrl: string;

    /**
     * The URL of the tunnel server (remote)
     */
    tunnelServerUrl: string;

    /**
     * Called when the tunnel is closed
     * This is kept as a callback since it's an event that happens after setup
     */
    onClosed?: () => void;
    
    /**
     * Timeout in milliseconds for local server availability check
     * Default: 5000 (5 seconds)
     */
    serverCheckTimeout?: number;
}

const DEFAULT_OPTIONS = {
    serverCheckTimeout: 5000
};

export interface ConnectionInfo {
    subdomain: string;
    tunnelUrl: string;
}

export class TunnelClient {
    private ws: WebSocket | null = null;
    private localServerUrl: string;
    private tunnelServerUrl: string;
    private serverCheckTimeout: number;
    private options: TunnelClientOptions;

    constructor(options: TunnelClientOptions) {
        this.options = {
            ...DEFAULT_OPTIONS,
            ...options
        };
        this.localServerUrl = this.options.localServerUrl;
        this.tunnelServerUrl = this.options.tunnelServerUrl;
        this.serverCheckTimeout = this.options.serverCheckTimeout!;
    }

    /**
     * Check if the local server is available
     * @throws Error if the server is unavailable
     */
    public async checkLocalServerAvailability(): Promise<void> {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.serverCheckTimeout);
            
            const response = await fetch(this.localServerUrl, {
                method: 'HEAD',
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`Local server responded with status: ${response.status}`);
            }
        } catch (error) {
            throw new Error(`Local server at ${this.localServerUrl} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Connect to the tunnel server
     * @returns Promise with connection info
     * @throws Error if connection fails or local server is unavailable
     */
    public async connect(): Promise<ConnectionInfo> {
        if (this.ws) {
            throw new Error("Already connected");
        }

        // Check if local server is available before connecting to tunnel
        await this.checkLocalServerAvailability();
        
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.tunnelServerUrl);

            this.ws.onopen = () => {
                console.log("Connected to tunnel server");
            };

            this.ws.onmessage = async (event) => {
                try {
                    const data = JSON.parse(event.data.toString());

                    if (data.type === "connected") {
                        const message = data as ConnectedMessage;
                        const tunnelPort = new URL(this.tunnelServerUrl).port || "4444";
                        
                        resolve({
                            subdomain: message.subdomain,
                            tunnelUrl: `http://${message.subdomain}.localhost:${tunnelPort}`
                        });
                        return;
                    }

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
                    console.error("Error handling message:", error);

                    // If we're still in the connection phase, reject the promise
                    if (!this.isConnected()) {
                        reject(error);
                        return;
                    }

                    // For established connections, try to handle the error
                    try {
                        const reqData = JSON.parse(event.data.toString()) as TunnelRequest;
                        const errorResponse: TunnelResponse = {
                            id: reqData.id,
                            status: 502,
                            headers: {},
                            body: "Bad Gateway"
                        };
                        this.ws?.send(JSON.stringify(errorResponse));
                    } catch {
                        // If we can't even parse the request ID, we can't respond
                        console.error("Failed to send error response");
                    }
                }
            };

            this.ws.onclose = () => {
                console.log("Disconnected from tunnel server");
                this.ws = null;
                this.options.onClosed?.();
            };

            this.ws.onerror = (event) => {
                console.error("WebSocket error:", event);
                const error = new Error("WebSocket connection error");
                reject(error);
            };
        });
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
