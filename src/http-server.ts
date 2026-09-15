/** Streamable-HTTP entrypoint for deployments behind a reverse proxy. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TastytradeMCPServer } from "./mcp-server/index.js";

const DEFAULT_PATH = "/mcp";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8010;

function listEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function portEnv(): number {
  const parsed = Number(process.env.MCP_PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536
    ? parsed
    : DEFAULT_PORT;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: body }));
}

/** Start a stateful MCP Streamable HTTP server. */
export async function runHttpServer(): Promise<void> {
  const host = process.env.MCP_HOST?.trim() || DEFAULT_HOST;
  const port = portEnv();
  const endpoint = process.env.MCP_STREAMABLE_HTTP_PATH?.trim() || DEFAULT_PATH;
  const allowedHosts = listEnv("MCP_ALLOWED_HOSTS", [host === "127.0.0.1" ? `127.0.0.1:${port}` : `${host}:${port}`]);
  const allowedOrigins = listEnv("MCP_ALLOWED_ORIGINS", []);
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (requestUrl.pathname === "/healthz") {
      send(res, 200, "ok");
      return;
    }
    if (requestUrl.pathname !== endpoint) {
      send(res, 404, "Not found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const suppliedId = typeof sessionId === "string" ? sessionId : undefined;
    let transport = suppliedId ? sessions.get(suppliedId) : undefined;
    if (!transport) {
      if (suppliedId || req.method !== "POST") {
        send(res, 404, "Session not found");
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        allowedHosts,
        allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
        enableDnsRebindingProtection: true,
      });
      const server = new TastytradeMCPServer();
      await server.connect(transport);
    }

    try {
      await transport.handleRequest(req, res);
      // The SDK allocates a stateful session ID while it handles initialize,
      // not in the transport constructor. Register it only afterwards so the
      // client's next request can find the same transport.
      if (!suppliedId && transport.sessionId) {
        sessions.set(transport.sessionId, transport);
      }
      if (req.method === "DELETE" && suppliedId) sessions.delete(suppliedId);
    } catch (error) {
      console.error(`[tastytrade-mcp] HTTP transport error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, "Internal server error");
    }
  };

  const httpServer = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  console.error(`[tastytrade-mcp] listening on http://${host}:${port}${endpoint}`);
}
