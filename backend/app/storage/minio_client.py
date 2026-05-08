"""MinIO storage utilities for task result files."""

import logging
import os

from minio import Minio

from app.config import get_settings

logger = logging.getLogger(__name__)

BUCKET = "spawnhive"


def get_minio_client() -> Minio:
    settings = get_settings()
    return Minio(
        settings.minio_endpoint,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        secure=False,
    )


def ensure_bucket():
    client = get_minio_client()
    if not client.bucket_exists(BUCKET):
        client.make_bucket(BUCKET)


def upload_task_results(task_id: str, workspace_dir: str) -> list[str]:
    """Upload files from workspace/output/ to MinIO. Returns list of S3 paths."""
    output_dir = os.path.join(workspace_dir, "output")
    if not os.path.exists(output_dir):
        return []

    client = get_minio_client()
    ensure_bucket()

    s3_paths = []
    for root, _dirs, files in os.walk(output_dir):
        for f in files:
            local_path = os.path.join(root, f)
            rel_path = os.path.relpath(local_path, output_dir)
            s3_path = f"results/{task_id}/{rel_path}"

            client.fput_object(BUCKET, s3_path, local_path)
            s3_paths.append(s3_path)
            logger.info(f"Uploaded {rel_path} -> s3://{BUCKET}/{s3_path}")

    return s3_paths


def get_file_stream(s3_path: str):
    """Get a file stream from MinIO."""
    client = get_minio_client()
    return client.get_object(BUCKET, s3_path)
