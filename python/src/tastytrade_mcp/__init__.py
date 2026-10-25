"""Launcher for the tastytrade MCP server.

The server is implemented in TypeScript and published to npm as
``@tastytrade/mcp-server``. This package runs that exact release through
``npx`` so it can be installed with ``pipx`` / ``uvx`` like other Python
MCP servers. Node.js 22+ must be on ``PATH``.
"""

__version__ = "2.0.0"

#: The npm package this launcher runs, pinned to the launcher's own version.
NPM_PACKAGE = "@tastytrade/mcp-server"

__all__ = ["__version__", "NPM_PACKAGE"]
