# tastytrade-mcp (Python launcher)

This package launches the [tastytrade MCP server](https://github.com/tastytrade/tastytrade-mcp),
which is implemented in TypeScript and published to npm as
[`@tastytrade/mcp-server`](https://www.npmjs.com/package/@tastytrade/mcp-server).
It is **not** a separate implementation: each `tastytrade-mcp` release runs
exactly the npm release with the same version number, through `npx`.

Versions up to 1.4.3 on PyPI were an earlier, Python implementation. 2.0.0 and
later are this launcher.

## Requirements

- Python 3.9+
- Node.js 22+ with `npx` on `PATH` (the first run downloads the npm package)

## Install

```bash
pipx install tastytrade-mcp   # or: uvx tastytrade-mcp
```

This puts two commands on your `PATH`:

- `tastytrade-mcp` — the MCP server, speaking MCP over stdio
- `tastytrade-mcp-doctor` — a read-only preflight of your credentials

## Configure an MCP client

```json
{
  "mcpServers": {
    "tastytrade": {
      "command": "tastytrade-mcp",
      "env": {
        "TASTYTRADE_ENV": "production",
        "TASTYTRADE_CLIENT_ID": "…",
        "TASTYTRADE_CLIENT_SECRET": "…",
        "TASTYTRADE_REFRESH_TOKEN": "…"
      }
    }
  }
}
```

That block is **production**: real funds, real accounts. Use `"sandbox"` for an
environment with no real money, and add `"TASTYTRADE_READ_ONLY": "1"` to
withhold every write and destructive tool. Everything else — credentials,
environments, the safety model and the tool surface — is documented in the
[main README](https://github.com/tastytrade/tastytrade-mcp#readme).
