/** Main → renderer: run a bridge method. */
export const REQUEST_CHANNEL = 'mcp-bridge:request';
/** Renderer → main: result of a bridge method. */
export const RESPONSE_CHANNEL = 'mcp-bridge:response';

export const DEFAULT_PORT = 26539;
/** Written to the app's data folder; the MCP server reads it to connect. */
export const CONNECTION_FILE = 'mcp-bridge.json';

export interface BridgeRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  id: number;
  result?: unknown;
  error?: string;
}
