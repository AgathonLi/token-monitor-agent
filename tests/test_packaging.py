"""Dockerfile contracts and real Compose rendering; agent behavior uses smoke_image.py."""
import re
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PackagingTests(unittest.TestCase):
    def test_image_installs_timezone_database(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        match = re.search(r"apt-get install[^;]+", dockerfile)
        assert match is not None
        install = match.group()
        self.assertIn("tzdata", install.split())
        self.assertNotRegex(dockerfile, r"\bTZ=Asia/Shanghai\b")

    def test_image_explicitly_keeps_session_titles_private(self):
        self.assertIn("TOKEN_MONITOR_SYNC_SESSION_TITLES=0", (ROOT / "Dockerfile").read_text())

    def test_compose_defaults_and_host_overrides(self):
        compose = [os.environ["COMPOSE_BIN"]] if "COMPOSE_BIN" in os.environ else ["docker", "compose"]
        try:
            probe = subprocess.run(compose + ["version"], capture_output=True, timeout=10)
        except FileNotFoundError:
            self.skipTest("Docker Compose not installed")
        if probe.returncode:
            self.skipTest("Docker Compose not installed")
        with tempfile.TemporaryDirectory(prefix="overlay-compose-") as directory:
            root = Path(directory)
            (root / "compose").mkdir()
            shutil.copyfile(ROOT / "compose/docker-compose.agent.yaml", root / "compose/docker-compose.agent.yaml")
            template = (ROOT / ".env.example").read_text()
            for overrides in ({}, {"TZ": "Asia/Shanghai", "TOKEN_MONITOR_LIMITS_ENABLED": "1",
                                   "TOKEN_MONITOR_WATCH": "1", "TOKEN_MONITOR_INTERVAL_MS": "60000",
                                   "TOKEN_MONITOR_SYNC_SESSION_TITLES": "1"}):
                with self.subTest(overrides=overrides):
                    env_text = template
                    for key, value in overrides.items():
                        env_text = re.sub(rf"^{key}=.*$", f"{key}={value}", env_text, flags=re.M)
                    (root / "compose/.env").write_text(env_text)
                    env = {k: v for k, v in os.environ.items() if not k.startswith("TOKEN_MONITOR_") and k not in {"TZ", "HERMES_HOME"}}
                    result = subprocess.run(compose + ["--env-file", "compose/.env", "-f", "compose/docker-compose.agent.yaml",
                                                      "config", "--format", "json"], cwd=root, env=env,
                                            capture_output=True, text=True, timeout=20, check=True)
                    service = json.loads(result.stdout)["services"]["token-monitor-agent"]
                    config = service["environment"]
                    expected = {"TZ": "UTC", "TOKEN_MONITOR_CLIENTS": "hermes", "TOKEN_MONITOR_LIMITS_ENABLED": "0",
                                "TOKEN_MONITOR_SYNC_SESSION_TITLES": "0", "TOKEN_MONITOR_WATCH": "0",
                                "TOKEN_MONITOR_INTERVAL_MS": "300000", **overrides}
                    self.assertEqual({key: config[key] for key in expected}, expected)
                    self.assertEqual(service["user"], "1000:1000")
                    self.assertRegex(service["image"], r":v\d+\.\d+\.\d+$")
                    targets = {volume["target"]: volume for volume in service["volumes"]}
                    for target in (config["HERMES_HOME"], config["TOKEN_MONITOR_SHARED_DIR"]):
                        self.assertIn(target, targets)
                        self.assertFalse(targets[target].get("read_only", False))
                    self.assertNotEqual(config["HERMES_HOME"], config["TOKEN_MONITOR_SHARED_DIR"])


if __name__ == "__main__":
    unittest.main()
