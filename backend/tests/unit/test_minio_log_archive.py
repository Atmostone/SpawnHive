"""Unit tests for the minio_client helpers (no real MinIO)."""

from io import BytesIO
from unittest.mock import MagicMock, patch

from app.storage import minio_client


def _fake_client():
    c = MagicMock()
    c.bucket_exists.return_value = True
    return c


def test_upload_log_archive_calls_put_object():
    fake = _fake_client()
    with patch.object(minio_client, "get_minio_client", return_value=fake):
        path = minio_client.upload_log_archive("task-x", b"hello world")
    assert path == "logs/task-x.log"
    fake.put_object.assert_called_once()
    args, kwargs = fake.put_object.call_args
    assert args[0] == minio_client.BUCKET
    assert args[1] == "logs/task-x.log"
    assert kwargs["length"] == len(b"hello world")
    assert kwargs["content_type"] == "text/plain"


def test_read_log_archive_consumes_stream():
    fake = _fake_client()
    fake_obj = MagicMock()
    fake_obj.read.return_value = b"archived bytes"
    fake.get_object.return_value = fake_obj
    with patch.object(minio_client, "get_minio_client", return_value=fake):
        result = minio_client.read_log_archive("logs/task-x.log")
    assert result == b"archived bytes"
    fake_obj.close.assert_called_once()
    fake_obj.release_conn.assert_called_once()


def test_ensure_bucket_creates_when_missing():
    fake = _fake_client()
    fake.bucket_exists.return_value = False
    with patch.object(minio_client, "get_minio_client", return_value=fake):
        minio_client.ensure_bucket()
    fake.make_bucket.assert_called_once_with(minio_client.BUCKET)


def test_get_file_stream_passes_through():
    fake = _fake_client()
    fake.get_object.return_value = "stream-handle"
    with patch.object(minio_client, "get_minio_client", return_value=fake):
        result = minio_client.get_file_stream("results/task-1/foo.txt")
    assert result == "stream-handle"
    fake.get_object.assert_called_with(minio_client.BUCKET, "results/task-1/foo.txt")


def test_upload_task_results_walks_output_dir(tmp_path):
    fake = _fake_client()
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    (output_dir / "a.txt").write_text("alpha")
    (output_dir / "b.txt").write_text("beta")
    with patch.object(minio_client, "get_minio_client", return_value=fake):
        paths = minio_client.upload_task_results("task-y", str(tmp_path))
    assert sorted(paths) == ["results/task-y/a.txt", "results/task-y/b.txt"]
    assert fake.fput_object.call_count == 2
