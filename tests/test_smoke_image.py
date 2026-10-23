"""Unit tests for .github/scripts/smoke_image.py."""
import json
import io
from contextlib import redirect_stdout, redirect_stderr
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / ".github" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import smoke_image  # noqa: E402

VALID_INSPECT = [{
    "Architecture": "amd64",
    "Os": "linux",
    "Config": {
        "User": "1000:1000",
        "Cmd": ["node", "src/agent/agent.js"],
        "Entrypoint": ["docker-entrypoint.sh"],
    },
}]


class SmokeImageTests(unittest.TestCase):
    def setUp(self):
        output = io.StringIO()
        self.enterContext(redirect_stdout(output))
        self.enterContext(redirect_stderr(output))

    @patch("subprocess.run")
    def test_missing_smoke_script_rejected_before_docker(self, mock_run):
        with tempfile.TemporaryDirectory() as directory:
            code = smoke_image.run_smoke("token-monitor-agent:smoke", Path(directory) / "missing.js")
        self.assertEqual(code, 2)
        mock_run.assert_not_called()

    @patch("subprocess.run")
    def test_daemon_failure_after_inspect_is_a_blocker_and_cleans_up(self, mock_run):
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout=json.dumps(VALID_INSPECT), stderr=""),
            MagicMock(returncode=1, stdout="", stderr="Cannot connect to the Docker daemon"),
            MagicMock(returncode=0, stdout="", stderr=""),
        ]
        self.assertEqual(smoke_image.run_smoke("token-monitor-agent:smoke"), 125)
        self.assertEqual(mock_run.call_args_list[-1].args[0][:3], ["docker", "rm", "-f"])

    def test_build_docker_run_command_flags(self):
        script_path = "/path/to/smoke_agent.js"
        image = "token-monitor-agent:smoke"
        container_name = "tm-smoke-test-123"
        cmd = smoke_image.build_docker_run_command(image, script_path, container_name)

        self.assertEqual(cmd[0], "docker")
        self.assertEqual(cmd[1], "run")
        self.assertIn("--name", cmd)
        self.assertEqual(cmd[cmd.index("--name") + 1], container_name)
        self.assertIn("--rm", cmd)
        self.assertIn("--read-only", cmd)

        # Assert security flags
        self.assertTrue(
            any("--security-opt=no-new-privileges" in arg or arg == "no-new-privileges" for arg in cmd)
        )
        self.assertTrue(
            any("--cap-drop=ALL" in arg or arg == "ALL" for arg in cmd)
        )

        # Assert network none
        self.assertTrue(
            "--network=none" in cmd or ("--network" in cmd and cmd[cmd.index("--network") + 1] == "none"),
            "Expected --network none or --network=none",
        )

        # Assert user 1000:1000
        self.assertTrue(
            "--user=1000:1000" in cmd or ("--user" in cmd and cmd[cmd.index("--user") + 1] == "1000:1000"),
            "Expected --user 1000:1000",
        )

        # Assert tmpfs with finite size and mode=1777 on /tmp
        tmpfs_val = None
        if "--tmpfs" in cmd:
            tmpfs_val = cmd[cmd.index("--tmpfs") + 1]
        else:
            for arg in cmd:
                if arg.startswith("--tmpfs="):
                    tmpfs_val = arg.split("=", 1)[1]
                    break
        self.assertIsNotNone(tmpfs_val, "Expected --tmpfs argument")
        assert tmpfs_val is not None
        self.assertTrue(tmpfs_val.startswith("/tmp"), f"tmpfs should mount /tmp, got {tmpfs_val}")
        self.assertIn("size=", tmpfs_val, f"tmpfs should have finite size, got {tmpfs_val}")
        self.assertIn("mode=1777", tmpfs_val, f"tmpfs should have mode=1777, got {tmpfs_val}")

        # Assert mount of smoke script to /tmp/overlay-smoke.js:ro
        mount_found = False
        for i, arg in enumerate(cmd):
            if arg in ("-v", "--volume") and i + 1 < len(cmd):
                val = cmd[i + 1]
                if f"{script_path}:/tmp/overlay-smoke.js:ro" in val or (
                    val.startswith(f"{script_path}:") and val.endswith(":ro")
                ):
                    mount_found = True
            elif arg.startswith(("-v=", "--volume=")) and f"{script_path}:/tmp/overlay-smoke.js:ro" in arg:
                mount_found = True
            elif arg.startswith("--mount") and f"source={script_path}" in arg and "readonly" in arg:
                mount_found = True
        self.assertTrue(mount_found, "Expected read-only mount of smoke script to /tmp/overlay-smoke.js:ro")

        # Assert entrypoint node
        self.assertTrue(
            "--entrypoint=node" in cmd or ("--entrypoint" in cmd and cmd[cmd.index("--entrypoint") + 1] == "node"),
            "Expected --entrypoint node",
        )

        # Assert workdir /app
        self.assertTrue(
            "-w" in cmd and cmd[cmd.index("-w") + 1] == "/app"
            or "--workdir" in cmd and cmd[cmd.index("--workdir") + 1] == "/app"
            or any(arg.startswith(("--workdir=", "-w=")) and arg.endswith("/app") for arg in cmd),
            "Expected workdir /app",
        )

        # Assert image and entrypoint script arg at the end
        self.assertIn(image, cmd)
        self.assertEqual(cmd[-1], "/tmp/overlay-smoke.js")

    @patch("subprocess.run")
    def test_verify_image_metadata_success(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout=json.dumps(VALID_INSPECT), stderr="")
        code, err = smoke_image.verify_image_metadata("token-monitor-agent:smoke")
        self.assertEqual(code, 0)
        self.assertEqual(err, "")

    @patch("subprocess.run")
    def test_verify_image_metadata_catches_user_regression(self, mock_run):
        bad_user = [{
            "Architecture": "amd64",
            "Os": "linux",
            "Config": {"User": "root", "Cmd": ["node", "src/agent/agent.js"]},
        }]
        mock_run.return_value = MagicMock(returncode=0, stdout=json.dumps(bad_user), stderr="")
        code, err = smoke_image.verify_image_metadata("token-monitor-agent:smoke")
        self.assertEqual(code, 1)
        self.assertIn("1000:1000", err)

    @patch("subprocess.run")
    def test_verify_image_metadata_catches_cmd_regression(self, mock_run):
        bad_cmd = [{
            "Architecture": "amd64",
            "Os": "linux",
            "Config": {"User": "1000:1000", "Cmd": ["sh"]},
        }]
        mock_run.return_value = MagicMock(returncode=0, stdout=json.dumps(bad_cmd), stderr="")
        code, err = smoke_image.verify_image_metadata("token-monitor-agent:smoke")
        self.assertEqual(code, 1)
        self.assertIn("Cmd", err)

    @patch("subprocess.run")
    def test_verify_image_metadata_catches_arch_regression(self, mock_run):
        bad_arch = [{
            "Architecture": "arm64",
            "Os": "linux",
            "Config": {"User": "1000:1000", "Cmd": ["node", "src/agent/agent.js"]},
        }]
        mock_run.return_value = MagicMock(returncode=0, stdout=json.dumps(bad_arch), stderr="")
        code, err = smoke_image.verify_image_metadata("token-monitor-agent:smoke")
        self.assertEqual(code, 1)
        self.assertIn("linux/amd64", err)

    @patch("subprocess.run")
    def test_run_smoke_success_and_cleans_up(self, mock_run):
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout=json.dumps(VALID_INSPECT), stderr=""),  # docker inspect
            MagicMock(returncode=0, stdout="OK", stderr=""),                       # docker run
            MagicMock(returncode=0, stdout="", stderr=""),                         # docker rm -f
        ]
        code = smoke_image.run_smoke("token-monitor-agent:smoke", timeout_s=30)
        self.assertEqual(code, 0)
        self.assertEqual(mock_run.call_count, 3)
        run_cmd = mock_run.call_args_list[1][0][0]
        rm_cmd = mock_run.call_args_list[2][0][0]
        container_name = run_cmd[run_cmd.index("--name") + 1]
        self.assertEqual(rm_cmd, ["docker", "rm", "-f", container_name])

    @patch("subprocess.run")
    def test_run_smoke_inspect_failure_halts_without_run(self, mock_run):
        bad_user = [{
            "Architecture": "amd64",
            "Os": "linux",
            "Config": {"User": "0", "Cmd": ["node", "src/agent/agent.js"]},
        }]
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout=json.dumps(bad_user), stderr=""),
        ]
        code = smoke_image.run_smoke("token-monitor-agent:smoke", timeout_s=30)
        self.assertEqual(code, 1)
        self.assertEqual(mock_run.call_count, 1)  # did not run container

    @patch("subprocess.run")
    def test_run_smoke_propagates_nonzero_exit_and_cleans_up(self, mock_run):
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout=json.dumps(VALID_INSPECT), stderr=""),
            MagicMock(returncode=42, stdout="", stderr="Smoke failure"),
            MagicMock(returncode=0, stdout="", stderr=""),
        ]
        code = smoke_image.run_smoke("token-monitor-agent:smoke", timeout_s=30)
        self.assertEqual(code, 42)
        self.assertEqual(mock_run.call_count, 3)
        rm_cmd = mock_run.call_args_list[2][0][0]
        self.assertEqual(rm_cmd[:3], ["docker", "rm", "-f"])

    @patch("subprocess.run")
    def test_run_smoke_handles_timeout_and_cleans_up_container(self, mock_run):
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout=json.dumps(VALID_INSPECT), stderr=""),
            subprocess.TimeoutExpired(cmd=["docker", "run"], timeout=30),
            MagicMock(returncode=0, stdout="", stderr=""),
        ]
        code = smoke_image.run_smoke("token-monitor-agent:smoke", timeout_s=30)
        self.assertEqual(code, 124)
        self.assertEqual(mock_run.call_count, 3)
        rm_cmd = mock_run.call_args_list[2][0][0]
        self.assertEqual(rm_cmd[:3], ["docker", "rm", "-f"])

    @patch("subprocess.run")
    def test_run_smoke_cleanup_failure_does_not_mask_original_timeout(self, mock_run):
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout=json.dumps(VALID_INSPECT), stderr=""),
            subprocess.TimeoutExpired(cmd=["docker", "run"], timeout=30),
            subprocess.SubprocessError("rm failed"),
        ]
        code = smoke_image.run_smoke("token-monitor-agent:smoke", timeout_s=30)
        self.assertEqual(code, 124)
        self.assertEqual(mock_run.call_count, 3)

    @patch("subprocess.run")
    def test_run_smoke_distinguishes_setup_blocker_cli_not_found(self, mock_run):
        mock_run.side_effect = FileNotFoundError("No such file or directory: 'docker'")
        code = smoke_image.run_smoke("token-monitor-agent:smoke", timeout_s=30)
        self.assertEqual(code, 125)

    @patch("subprocess.run")
    def test_run_smoke_distinguishes_setup_blocker_daemon_down(self, mock_run):
        mock_run.side_effect = [
            MagicMock(
                returncode=1,
                stdout="",
                stderr="ERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
            ),
            MagicMock(returncode=0, stdout="", stderr=""),
        ]
        code = smoke_image.run_smoke("token-monitor-agent:smoke", timeout_s=30)
        self.assertEqual(code, 125)

    def test_main_missing_image_arg_exits_2(self):
        with self.assertRaises(SystemExit) as cm:
            smoke_image.main([])
        self.assertEqual(cm.exception.code, 2)

    @patch("smoke_image.run_smoke")
    def test_main_success_returns_0(self, mock_run_smoke):
        mock_run_smoke.return_value = 0
        code = smoke_image.main(["token-monitor-agent:smoke"])
        self.assertEqual(code, 0)
        mock_run_smoke.assert_called_once_with(
            image="token-monitor-agent:smoke",
            timeout_s=smoke_image.DEFAULT_TIMEOUT_S,
        )

    @patch("smoke_image.run_smoke")
    def test_main_blocker_returns_125(self, mock_run_smoke):
        mock_run_smoke.return_value = 125
        code = smoke_image.main(["token-monitor-agent:smoke"])
        self.assertEqual(code, 125)

    @patch("subprocess.run")
    def test_run_smoke_with_custom_script_via_tempfile(self, mock_run):
        with tempfile.NamedTemporaryFile(suffix=".js") as tf:
            mock_run.side_effect = [
                MagicMock(returncode=0, stdout=json.dumps(VALID_INSPECT), stderr=""),
                MagicMock(returncode=0, stdout="OK", stderr=""),
                MagicMock(returncode=0, stdout="", stderr=""),
            ]
            code = smoke_image.run_smoke(
                "token-monitor-agent:smoke",
                smoke_script_path=tf.name,
                timeout_s=10,
            )
            self.assertEqual(code, 0)
            run_cmd = mock_run.call_args_list[1][0][0]
            self.assertTrue(any(tf.name in arg for arg in run_cmd))


if __name__ == "__main__":
    unittest.main()
