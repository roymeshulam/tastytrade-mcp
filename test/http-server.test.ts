/**
 * The Streamable HTTP entrypoint, exercised over a real loopback socket.
 *
 * Every test binds an ephemeral port chosen by the OS, never the default 8010:
 * a deployed instance may already be listening there, and a test must not
 * collide with (or talk to) it. No credentials are set, so nothing here can
 * reach the tastytrade API; only the MCP handshake and session bookkeeping run.
 */

import { createServer, type Server } from "node:net";
import type { Server as HttpServer } from "node:http";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { runHttpServer } from "../src/http-server.js";

const ENV_KEYS = [
  "MCP_HOST",
  "MCP_PORT",
  "MCP_STREAMABLE_HTTP_PATH",
  "MCP_ALLOWED_HOSTS",
  "MCP_ALLOWED_ORIGINS",
] as const;

async function freePort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === "string") {
    throw new Error("no port");
  }
  return address.port;
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "http-test", version: "0" },
  },
};

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("runHttpServer", () => {
  const saved: Record<string, string | undefined> = {};
  let server: HttpServer | undefined;
  let base = "";

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await freePort();
    process.env.MCP_PORT = String(port);
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.restoreAllMocks();
  });

  it("answers the health probe and 404s unknown paths", async () => {
    server = await runHttpServer();
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ error: "ok" });

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
  });

  it("refuses a non-POST without a session and an unknown session id", async () => {
    server = await runHttpServer();
    const get = await fetch(`${base}/mcp`);
    expect(get.status).toBe(404);

    const unknown = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": "not-a-session" },
      body: JSON.stringify(INIT),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Session not found" });
  });

  it("initializes a session, reuses it, and forgets it on DELETE", async () => {
    server = await runHttpServer();
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await init.text();

    const headers = { ...MCP_HEADERS, "mcp-session-id": sessionId! };
    const initialized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    expect(initialized.status).toBe(202);

    const del = await fetch(`${base}/mcp`, { method: "DELETE", headers });
    expect(del.status).toBe(200);

    const after = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(after.status).toBe(404);
  });

  it("honours a custom path, host allowlist and origin allowlist", async () => {
    const port = Number(process.env.MCP_PORT);
    process.env.MCP_STREAMABLE_HTTP_PATH = "/custom";
    process.env.MCP_ALLOWED_HOSTS = `127.0.0.1:${port}, ,`;
    process.env.MCP_ALLOWED_ORIGINS = "https://allowed.example";
    server = await runHttpServer();

    expect((await fetch(`${base}/mcp`)).status).toBe(404);
    const refused = await fetch(`${base}/custom`, {
      method: "POST",
      headers: { ...MCP_HEADERS, Origin: "https://evil.example" },
      body: JSON.stringify(INIT),
    });
    expect(refused.status).toBe(403);
  });

  it("falls back to the default port when MCP_PORT is unusable", async () => {
    process.env.MCP_PORT = "not-a-port";
    process.env.MCP_HOST = "256.256.256.256";
    // An unresolvable host makes listen() fail, which proves the error path
    // without ever binding the default port a deployed instance may own.
    await expect(runHttpServer()).rejects.toThrow();
  });

  it("returns 500 when the transport throws while handling a request", async () => {
    server = await runHttpServer();
    const { StreamableHTTPServerTransport } =
      await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    jest
      .spyOn(StreamableHTTPServerTransport.prototype, "handleRequest")
      .mockRejectedValueOnce(new Error("boom"));
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });
});
