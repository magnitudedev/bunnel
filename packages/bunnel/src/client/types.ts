export interface TunnelRequest {
    id: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string | null;
}

export interface TunnelResponse {
    id: string;
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface ConnectedMessage {
    type: 'connected';
    subdomain: string;
}
