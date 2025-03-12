import type { TunnelRequest, TunnelResponse, ConnectedMessage } from './types';
import logger from './logger';

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
                logger.debug("Connected to tunnel server");
            };

            this.ws.onmessage = async (event) => {
                try {
                    const data = JSON.parse(event.data.toString());

                    logger.debug("Received WS message:");
                    logger.debug(data);

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

                    // Log the request being sent to local server
                    logger.debug(`Forwarding request to local server: ${this.localServerUrl}${request.path}`);
                    logger.debug(`Request method: ${request.method}`);
                    logger.debug(`Original request headers:`, request.headers);
                    
                    // Create a copy of the headers and replace the Host header with the local server host
                    // const modifiedHeaders = { ...request.headers };
                    // modifiedHeaders['host'] = new URL(this.localServerUrl).host; // Replace with localhost:3000
                    
                    // logger.debug(`Modified request headers:`, modifiedHeaders);
                    // logger.debug(`Modified Host header to: ${modifiedHeaders['host']}`);
                    
                    // Forward request to local server with modified headers
                    const localResponse = await fetch(`${this.localServerUrl}${request.path}`, {
                        method: request.method,
                        headers: request.headers,
                        body: request.body
                    });

                    // Log the response from local server
                    logger.debug(`Response from local server: Status ${localResponse.status}`);
                    logger.debug(`Response headers from local server:`);
                    localResponse.headers.forEach((value, key) => {
                        logger.debug(`  ${key}: ${value}`);
                    });

                    // Convert headers to plain object
                    const headers: Record<string, string> = {};
                    localResponse.headers.forEach((value, key) => {
                        headers[key] = value;
                    });

                    // Handle redirects by rewriting the Location header
                    // if (localResponse.status >= 300 && localResponse.status < 400 && headers['location']) {
                    //     try {
                    //         const location = headers['location'];
                    //         const tunnelHost = request.headers['host'];
                            
                    //         // Determine if we need to rewrite the URL
                    //         if (location.startsWith('/')) {
                    //             // Absolute path - rewrite with tunnel host
                    //             // Preserve protocol (http/https) from the original request
                    //             const protocol = tunnelHost.includes('localhost') ? 'http' : 'https';
                    //             headers['location'] = `${protocol}://${tunnelHost}${location}`;
                    //             logger.debug(`Rewrote redirect URL from ${location} to ${headers['location']}`);
                    //         } else if (!location.includes('://')) {
                    //             // Relative path without leading slash - combine with current path
                    //             const currentPath = request.path.split('?')[0]; // Remove query string
                    //             const basePath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
                    //             // Preserve protocol (http/https) from the original request
                    //             const protocol = tunnelHost.includes('localhost') ? 'http' : 'https';
                    //             headers['location'] = `${protocol}://${tunnelHost}${basePath}${location}`;
                    //             logger.debug(`Rewrote redirect URL from ${location} to ${headers['location']}`);
                    //         }
                    //         // If it's already an absolute URL with protocol, leave it unchanged
                    //     } catch (error) {
                    //         logger.warn('Error rewriting redirect URL:', error);
                    //         // If URL rewriting fails, continue with the original URL
                    //     }
                    // }

                    // Get response body
                    const responseBody = await localResponse.text();
                    
                    // Send response back through tunnel
                    const tunnelResponse: TunnelResponse = {
                        id: request.id,
                        status: localResponse.status,
                        headers,
                        body: responseBody
                    };

                    // Log the final response being sent back through tunnel
                    logger.debug(`Sending response back through tunnel: Status ${tunnelResponse.status}`);
                    logger.debug(`Response headers being sent back:`);
                    Object.entries(tunnelResponse.headers).forEach(([key, value]) => {
                        logger.debug(`  ${key}: ${value}`);
                    });
                    logger.debug(`Response body length: ${responseBody.length} characters`);
                    
                    this.ws?.send(JSON.stringify(tunnelResponse));
                } catch (error) {
                    logger.warn("Error handling tunnel message:", error);

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
                        logger.warn("Failed to send tunnel error response");
                    }
                }
            };

            this.ws.onclose = () => {
                logger.debug("Disconnected from tunnel server");
                this.ws = null;
                this.options.onClosed?.();
            };

            this.ws.onerror = (event) => {
                logger.warn("WebSocket error:", event);
                const error = new Error(`WebSocket connection error: ${event}`);
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
