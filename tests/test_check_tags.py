import io
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
import sys
from unittest.mock import MagicMock, patch


# Ensure .github/scripts is importable
SCRIPTS_DIR = Path(__file__).resolve().parents[1] / ".github" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import check_tags  # noqa: E402


class CheckTagsTests(unittest.TestCase):
    def setUp(self):
        output = io.StringIO()
        self.enterContext(redirect_stdout(output))
        self.enterContext(redirect_stderr(output))

    def test_extract_digest_from_config(self):
        sample = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
            "config": {
                "mediaType": "application/vnd.docker.container.image.v1+json",
                "size": 1234,
                "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            },
            "layers": [],
        }
        digest = check_tags.extract_digest(sample)
        self.assertEqual(
            digest,
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        )

    def test_rejects_descriptor_and_manifest_list(self):
        sample_desc = {
            "Descriptor": {
                "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222"
            }
        }
        with self.assertRaises(ValueError):
            check_tags.extract_digest(sample_desc)

        sample_list = {
            "manifests": [
                {
                    "platform": {"os": "linux", "architecture": "amd64"},
                    "digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
                }
            ]
        }
        with self.assertRaises(ValueError):
            check_tags.extract_digest(sample_list)

    def test_extract_digest_raises_on_invalid_data(self):
        for data in ({}, [], {"schemaVersion": 2, "config": {"digest": "sha256:abc"}},
                     {"schemaVersion": 1, "config": {"digest": "sha256:" + "a" * 64}}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                check_tags.extract_digest(data)

    @patch("subprocess.run")
    def test_inspect_manifest_invokes_docker_cli(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout='{"config": {"digest": "sha256:abc"}}')
        res = check_tags.inspect_manifest("ghcr.io/test/image:v1")
        self.assertEqual(res, {"config": {"digest": "sha256:abc"}})
        mock_run.assert_called_once_with(
            ["docker", "manifest", "inspect", "ghcr.io/test/image:v1"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    @patch("subprocess.run")
    def test_inspect_manifest_raises_on_nonzero_exit(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stderr="no such manifest")
        with self.assertRaises(RuntimeError) as ctx:
            check_tags.inspect_manifest("ghcr.io/test/image:v1")
        self.assertIn("failed for ghcr.io/test/image:v1", str(ctx.exception))
    @patch("check_tags.inspect_manifest")
    def test_check_tags_match_success(self, mock_inspect):
        digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        mock_inspect.return_value = {
            "schemaVersion": 2, "config": {"digest": digest}
        }
        matched, result = check_tags.check_tags_match(
            repo="ghcr.io/agathonli/token-monitor-agent",
            tags=["v0.77.0", "latest", "overlay-abc1234"],
        )
        self.assertTrue(matched)
        self.assertEqual(result, digest)
        self.assertEqual(mock_inspect.call_count, 3)

    @patch("check_tags.inspect_manifest")
    def test_check_tags_match_mismatched_digest(self, mock_inspect):
        mock_inspect.side_effect = [
            {"schemaVersion": 2, "config": {"digest": "sha256:" + "1" * 64}},
            {"schemaVersion": 2, "config": {"digest": "sha256:" + "1" * 64}},
            {"schemaVersion": 2, "config": {"digest": "sha256:" + "2" * 64}},
        ]
        matched, result = check_tags.check_tags_match(
            repo="ghcr.io/agathonli/token-monitor-agent",
            tags=["v0.77.0", "latest", "overlay-abc1234"],
        )
        self.assertFalse(matched)
        self.assertIn("digest mismatch", result)

    @patch("check_tags.inspect_manifest")
    def test_check_tags_match_missing_or_failed(self, mock_inspect):
        mock_inspect.side_effect = RuntimeError("manifest not found")
        matched, result = check_tags.check_tags_match(
            repo="ghcr.io/agathonli/token-monitor-agent",
            tags=["v0.77.0", "latest", "overlay-abc1234"],
        )
        self.assertFalse(matched)
        self.assertIn("inspection failed", result)

    @patch("check_tags.inspect_manifest")
    def test_schedule_retries_failed_publication_and_skips_after_recovery(self, mock_inspect):
        manifest = {"schemaVersion": 2, "config": {"digest": "sha256:" + "a" * 64}}
        tags = ["v1", "latest", "overlay-sha"]
        mock_inspect.side_effect = [manifest, manifest, RuntimeError("overlay not published")]
        self.assertTrue(check_tags.should_build("schedule", False, "ghcr.io/test/image", tags)[0])
        mock_inspect.side_effect = None
        mock_inspect.return_value = manifest
        self.assertFalse(check_tags.should_build("schedule", False, "ghcr.io/test/image", tags)[0])

    @patch("check_tags.inspect_manifest")
    def test_lookup_timeout_requires_rebuild(self, mock_inspect):
        mock_inspect.side_effect = subprocess.TimeoutExpired("docker", 30)
        self.assertTrue(check_tags.should_build("schedule", False, "ghcr.io/test/image", ["v1"])[0])

    def test_should_build_forced_events(self):
        for event in ("push", "workflow_dispatch"):
            build, reason = check_tags.should_build(
                event_name=event,
                sync_changed=False,
                repo="ghcr.io/test/image",
                tags=["v1", "latest", "overlay-sha"],
            )
            self.assertTrue(build, f"Expected event {event} to force build")
            self.assertIn("forced", reason)

    def test_should_build_on_sync_changed(self):
        build, reason = check_tags.should_build(
            event_name="schedule",
            sync_changed=True,
            repo="ghcr.io/test/image",
            tags=["v1", "latest", "overlay-sha"],
        )
        self.assertTrue(build)
        self.assertIn("updated", reason)

    @patch("check_tags.check_tags_match")
    def test_should_build_schedule_skips_when_tags_match(self, mock_match):
        mock_match.return_value = (True, "sha256:matched")
        build, reason = check_tags.should_build(
            event_name="schedule",
            sync_changed=False,
            repo="ghcr.io/test/image",
            tags=["v1", "latest", "overlay-sha"],
        )
        self.assertFalse(build)
        self.assertIn("all tags exist and match", reason)

    @patch("check_tags.check_tags_match")
    def test_should_build_schedule_rebuilds_when_tags_mismatch_or_missing(self, mock_match):
        mock_match.return_value = (False, "tag overlay-sha missing")
        build, reason = check_tags.should_build(
            event_name="schedule",
            sync_changed=False,
            repo="ghcr.io/test/image",
            tags=["v1", "latest", "overlay-sha"],
        )
        self.assertTrue(build)
        self.assertIn("rebuild needed", reason)


    @patch("check_tags.check_tags_match")
    def test_verify_published_tags_success(self, mock_match):
        digest = "sha256:" + "a" * 64
        mock_match.return_value = (True, digest)
        check_tags.verify_published_tags("ghcr.io/test/image", ["v1", "latest"], digest)

    @patch("check_tags.check_tags_match")
    def test_verify_rejects_matching_but_old_tags(self, mock_match):
        mock_match.return_value = (True, "sha256:" + "a" * 64)
        with self.assertRaisesRegex(RuntimeError, "tested image"):
            check_tags.verify_published_tags("ghcr.io/test/image", ["v1", "latest"], "sha256:" + "b" * 64)

    @patch("check_tags.check_tags_match")
    def test_verify_published_tags_failure_raises(self, mock_match):
        mock_match.return_value = (False, "overlay tag missing")
        with self.assertRaises(RuntimeError) as ctx:
            check_tags.verify_published_tags("ghcr.io/test/image", ["v1", "latest"], "sha256:" + "a" * 64)
        self.assertIn("overlay tag missing", str(ctx.exception))

    def test_write_output_to_file(self):
        with tempfile.TemporaryDirectory() as directory:
            out_file = Path(directory) / "output"
            with patch.dict("os.environ", {"GITHUB_OUTPUT": str(out_file)}):
                check_tags.write_output(build="true", can_push="false")
            self.assertEqual(out_file.read_text(), "build=true\ncan_push=false\n")

    @patch("check_tags.check_tags_match")
    def test_main_decide(self, mock_match):
        mock_match.return_value = (True, "sha256:abc")
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        out_file = Path(directory.name) / "output"
        with patch.dict("os.environ", {"GITHUB_OUTPUT": str(out_file)}):
            ret = check_tags.main([
                "decide",
                "--repo", "ghcr.io/test/image",
                "--tags", "v1", "latest",
                "--event", "schedule",
                "--changed", "false",
            ])
            self.assertEqual(ret, 0)
            content = out_file.read_text()
            self.assertIn("build=false\n", content)


    @patch("check_tags.verify_published_tags")
    def test_main_verify_success(self, mock_verify):
        mock_verify.return_value = None
        digest = "sha256:" + "a" * 64
        ret = check_tags.main(["verify", "--repo", "ghcr.io/test/image", "--tags", "v1", "latest", "--expected-digest", digest])
        self.assertEqual(ret, 0)
        mock_verify.assert_called_once_with("ghcr.io/test/image", ["v1", "latest"], digest)

    @patch("check_tags.verify_published_tags")
    def test_main_verify_failure(self, mock_verify):
        mock_verify.side_effect = RuntimeError("failed verification")
        ret = check_tags.main(["verify", "--repo", "ghcr.io/test/image", "--tags", "v1", "latest", "--expected-digest", "sha256:" + "a" * 64])
        self.assertEqual(ret, 1)
if __name__ == "__main__":
    unittest.main()
