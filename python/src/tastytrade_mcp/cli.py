"""Entry points: ``tastytrade-mcp`` and ``tastytrade-mcp-doctor``.

Both hand the process over to ``npx`` running the pinned npm release. On
POSIX the launcher ``exec``s, so the MCP client's stdin/stdout and signals
reach the Node process directly with no Python process in between. stdout is
the MCP protocol channel, so every message from this launcher goes to stderr.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from typing import List, Optional, Sequence

from tastytrade_mcp import NPM_PACKAGE, __version__

MIN_NODE_MAJOR = 22
SERVER_BIN = "tastytrade-mcp"
DOCTOR_BIN = "tastytrade-mcp-doctor"


class LauncherError(Exception):
    """A problem that stops the launch, with the exit code to use."""

    def __init__(self, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def package_spec() -> str:
    """The exact npm release this launcher runs."""
    return f"{NPM_PACKAGE}@{__version__}"


def parse_node_major(version_output: str) -> Optional[int]:
    """``v22.11.0`` -> 22; None when the output is not a Node version."""
    match = re.match(r"^\s*v?(\d+)\.\d+", version_output)
    return int(match.group(1)) if match else None


def check_node(node: Optional[str]) -> None:
    """Refuse to launch without Node.js >= MIN_NODE_MAJOR."""
    if node is None:
        raise LauncherError(
            f"tastytrade-mcp needs Node.js {MIN_NODE_MAJOR}+ on PATH: this Python "
            f"package launches the npm package {NPM_PACKAGE}. Install Node.js from "
            "https://nodejs.org and retry.",
            127,
        )
    try:
        out = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=15
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        raise LauncherError(f"Could not run `{node} --version`: {exc}", 127)
    major = parse_node_major(out)
    if major is None or major < MIN_NODE_MAJOR:
        raise LauncherError(
            f"tastytrade-mcp needs Node.js {MIN_NODE_MAJOR}+, found "
            f"{out.strip() or 'an unreadable version'} at {node}.",
            1,
        )


def build_command(npx: str, bin_name: str, args: Sequence[str]) -> List[str]:
    """The npx invocation for one of the package's bin commands."""
    return [npx, "--yes", "--package", package_spec(), "--", bin_name, *args]


def launch(bin_name: str, args: Optional[Sequence[str]] = None) -> int:
    """Resolve Node and npx, then run ``bin_name``. Returns an exit code
    (only reached on Windows or on failure: POSIX replaces the process)."""
    argv = list(sys.argv[1:] if args is None else args)
    try:
        check_node(shutil.which("node"))
        npx = shutil.which("npx")
        if npx is None:
            raise LauncherError(
                "Node.js was found but `npx` was not; it ships with npm. "
                "Reinstall Node.js with npm included.",
                127,
            )
    except LauncherError as err:
        print(f"[tastytrade-mcp] {err}", file=sys.stderr)
        return err.exit_code
    command = build_command(npx, bin_name, argv)
    if os.name == "posix":
        os.execv(npx, command)
    return subprocess.call(command)  # pragma: no cover - Windows path


def main() -> None:
    sys.exit(launch(SERVER_BIN))


def doctor() -> None:
    sys.exit(launch(DOCTOR_BIN))
