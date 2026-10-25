import subprocess
import sys

import pytest

import tastytrade_mcp
from tastytrade_mcp import cli


def test_package_spec_pins_the_launcher_version():
    assert cli.package_spec() == f"@tastytrade/mcp-server@{tastytrade_mcp.__version__}"


@pytest.mark.parametrize(
    "output,major",
    [("v22.11.0\n", 22), ("v24.1.3", 24), ("18.0.0", 18), ("", None), ("nope", None)],
)
def test_parse_node_major(output, major):
    assert cli.parse_node_major(output) == major


def test_build_command_separates_npx_options_from_server_args():
    cmd = cli.build_command("/usr/bin/npx", "tastytrade-mcp", ["--json"])
    assert cmd == [
        "/usr/bin/npx",
        "--yes",
        "--package",
        cli.package_spec(),
        "--",
        "tastytrade-mcp",
        "--json",
    ]


def test_check_node_missing():
    with pytest.raises(cli.LauncherError) as err:
        cli.check_node(None)
    assert err.value.exit_code == 127


def _fake_run(stdout):
    def run(*_a, **_k):
        return subprocess.CompletedProcess([], 0, stdout=stdout, stderr="")

    return run


def test_check_node_too_old(monkeypatch):
    monkeypatch.setattr(cli.subprocess, "run", _fake_run("v20.10.0\n"))
    with pytest.raises(cli.LauncherError) as err:
        cli.check_node("/usr/bin/node")
    assert err.value.exit_code == 1
    assert "v20.10.0" in str(err.value)


def test_check_node_unrunnable(monkeypatch):
    def boom(*_a, **_k):
        raise OSError("no exec")

    monkeypatch.setattr(cli.subprocess, "run", boom)
    with pytest.raises(cli.LauncherError) as err:
        cli.check_node("/usr/bin/node")
    assert err.value.exit_code == 127


def test_check_node_ok(monkeypatch):
    monkeypatch.setattr(cli.subprocess, "run", _fake_run("v22.0.0\n"))
    cli.check_node("/usr/bin/node")


def test_launch_reports_missing_node_on_stderr_not_stdout(monkeypatch, capsys):
    monkeypatch.setattr(cli.shutil, "which", lambda _name: None)
    assert cli.launch(cli.SERVER_BIN, []) == 127
    out = capsys.readouterr()
    assert out.out == ""  # stdout is the MCP protocol channel
    assert "Node.js 22+" in out.err


def test_launch_reports_missing_npx(monkeypatch, capsys):
    monkeypatch.setattr(
        cli.shutil, "which", lambda name: "/usr/bin/node" if name == "node" else None
    )
    monkeypatch.setattr(cli.subprocess, "run", _fake_run("v22.0.0"))
    assert cli.launch(cli.DOCTOR_BIN, []) == 127
    assert "npx" in capsys.readouterr().err


def test_launch_execs_npx_with_the_pinned_package(monkeypatch):
    monkeypatch.setattr(cli.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(cli.subprocess, "run", _fake_run("v22.0.0"))
    monkeypatch.setattr(cli.os, "name", "posix")
    seen = {}

    def fake_execv(path, argv):
        seen["path"], seen["argv"] = path, argv
        raise SystemExit(0)

    monkeypatch.setattr(cli.os, "execv", fake_execv)
    with pytest.raises(SystemExit):
        cli.launch(cli.SERVER_BIN, ["x"])
    assert seen["path"] == "/usr/bin/npx"
    assert seen["argv"][-2:] == ["tastytrade-mcp", "x"]


def test_launch_uses_subprocess_off_posix(monkeypatch):
    monkeypatch.setattr(cli.shutil, "which", lambda name: f"C:/node/{name}")
    monkeypatch.setattr(cli.subprocess, "run", _fake_run("v22.0.0"))
    monkeypatch.setattr(cli.os, "name", "nt")
    monkeypatch.setattr(cli.subprocess, "call", lambda cmd: 3)
    assert cli.launch(cli.DOCTOR_BIN, []) == 3


@pytest.mark.parametrize("entry,bin_name", [("main", "tastytrade-mcp"), ("doctor", "tastytrade-mcp-doctor")])
def test_entry_points_exit_with_the_launch_code(monkeypatch, entry, bin_name):
    seen = []
    monkeypatch.setattr(cli, "launch", lambda name: seen.append(name) or 5)
    with pytest.raises(SystemExit) as exc:
        getattr(cli, entry)()
    assert exc.value.code == 5
    assert seen == [bin_name]


def test_module_is_runnable_with_python_dash_m():
    # `python -m tastytrade_mcp` resolves; with no node on PATH it must fail
    # cleanly on stderr rather than with a traceback.
    proc = subprocess.run(
        [sys.executable, "-m", "tastytrade_mcp"],
        capture_output=True,
        text=True,
        env={"PATH": "/nonexistent"},
        timeout=30,
    )
    assert proc.returncode == 127
    assert proc.stdout == ""
    assert "Traceback" not in proc.stderr
