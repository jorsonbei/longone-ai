from __future__ import annotations

import datetime as dt
import glob
import json
import os
import shutil
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

from google.cloud import storage


LOCAL_ROOT = Path("/Users/beijisheng/Desktop/codex_wxl")
RUNNER_LOG = Path("/tmp/hfcd_runner_stdout.log")


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
      raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def list_blobs(bucket: storage.Bucket, prefix: str):
    return list(bucket.list_blobs(prefix=prefix.rstrip("/") + "/"))


def download_source(bucket: storage.Bucket, source_prefix: str) -> int:
    if LOCAL_ROOT.exists():
        shutil.rmtree(LOCAL_ROOT)
    LOCAL_ROOT.mkdir(parents=True, exist_ok=True)

    count = 0
    prefix = source_prefix.rstrip("/") + "/"
    for blob in list_blobs(bucket, source_prefix):
        relative = blob.name[len(prefix):]
        if not relative or relative.endswith("/"):
            continue
        target = LOCAL_ROOT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        blob.download_to_filename(target)
        count += 1
    return count


def download_input_dataset(bucket: storage.Bucket, object_name: str | None) -> dict[str, Any] | None:
    if not object_name:
        return None

    target = LOCAL_ROOT / "customer_input" / "input_dataset.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    blob = bucket.blob(object_name)
    if not blob.exists():
        raise FileNotFoundError(f"HFCD input dataset not found in GCS: {object_name}")
    blob.download_to_filename(target)
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        payload = {}
    return {
        "object": object_name,
        "local_path": str(target),
        "file_name": payload.get("fileName"),
        "industry": payload.get("industry"),
        "row_count": payload.get("rowCount") or len(payload.get("rows") or []),
    }


def upload_file(bucket: storage.Bucket, artifact_prefix: str, file_path: Path, root: Path) -> str:
    relative = file_path.relative_to(root).as_posix()
    object_name = f"{artifact_prefix.rstrip('/')}/{relative}"
    blob = bucket.blob(object_name)
    blob.upload_from_filename(file_path)
    return object_name


def collect_artifacts(bucket: storage.Bucket, artifact_prefix: str, output_globs: str) -> list[str]:
    artifacts: list[str] = []
    seen: set[Path] = set()
    for pattern in [item.strip() for item in output_globs.split(",") if item.strip()]:
        for item in glob.glob(str(LOCAL_ROOT / pattern), recursive=True):
            path = Path(item)
            if not path.is_file() or path in seen:
                continue
            seen.add(path)
            artifacts.append(upload_file(bucket, artifact_prefix, path, LOCAL_ROOT))

    if RUNNER_LOG.exists():
        artifacts.append(upload_file(bucket, artifact_prefix, RUNNER_LOG, RUNNER_LOG.parent))
    return artifacts


def upload_manifest(bucket: storage.Bucket, artifact_prefix: str, manifest: dict[str, Any]) -> None:
    blob = bucket.blob(f"{artifact_prefix.rstrip('/')}/cloud_manifest.json")
    blob.upload_from_string(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        content_type="application/json; charset=utf-8",
    )


def apply_extra_env() -> None:
    raw = os.environ.get("HFCD_ENV_JSON")
    if not raw:
        return
    try:
        payload = json.loads(raw)
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    for key, value in payload.items():
        if isinstance(key, str) and key.replace("_", "").isalnum():
            os.environ[key] = str(value)


def run_experiment(script_name: str) -> int:
    script = LOCAL_ROOT / script_name
    if not script.exists():
        raise FileNotFoundError(f"Experiment script not found in staged source: {script}")

    with RUNNER_LOG.open("w", encoding="utf-8") as log:
        log.write(f"[runner] started_at={utc_now()}\n")
        log.write(f"[runner] script={script}\n")
        log.flush()
        process = subprocess.run(
            [sys.executable, str(script)],
            cwd=str(LOCAL_ROOT),
            stdout=log,
            stderr=subprocess.STDOUT,
            env=os.environ.copy(),
            check=False,
        )
        log.write(f"\n[runner] finished_at={utc_now()}\n")
        log.write(f"[runner] returncode={process.returncode}\n")
        return process.returncode


def main() -> int:
    job_id = os.environ.get("HFCD_JOB_ID", f"hfcd-run-{dt.datetime.now().strftime('%Y%m%d%H%M%S')}")
    bucket_name = require_env("HFCD_GCS_BUCKET")
    source_prefix = require_env("HFCD_SOURCE_GCS_PREFIX")
    artifact_prefix = require_env("HFCD_ARTIFACT_PREFIX")
    script_name = require_env("HFCD_EXPERIMENT_SCRIPT")
    output_globs = os.environ.get("HFCD_OUTPUT_GLOBS", "物性论_HFCD_*,HFCD_*_checkpoints/*.pkl")
    input_dataset_object = os.environ.get("HFCD_INPUT_DATASET_OBJECT")

    apply_extra_env()

    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)
    manifest: dict[str, Any] = {
        "job_id": job_id,
        "status": "running",
        "script": script_name,
        "source_prefix": source_prefix,
        "artifact_prefix": artifact_prefix,
        "output_globs": output_globs,
        "started_at": utc_now(),
        "finished_at": None,
        "returncode": None,
        "source_file_count": 0,
        "input_dataset": None,
        "artifacts": [],
        "error": None,
    }

    try:
        manifest["source_file_count"] = download_source(bucket, source_prefix)
        manifest["input_dataset"] = download_input_dataset(bucket, input_dataset_object)
        upload_manifest(bucket, artifact_prefix, manifest)
        returncode = run_experiment(script_name)
        manifest["returncode"] = returncode
        manifest["status"] = "succeeded" if returncode == 0 else "failed"
        manifest["artifacts"] = collect_artifacts(bucket, artifact_prefix, output_globs)
        return returncode
    except Exception as error:
        manifest["status"] = "failed"
        manifest["error"] = f"{error}\n{traceback.format_exc()}"
        try:
            if RUNNER_LOG.exists():
                manifest["artifacts"] = collect_artifacts(bucket, artifact_prefix, output_globs)
        except Exception:
            pass
        return 1
    finally:
        manifest["finished_at"] = utc_now()
        upload_manifest(bucket, artifact_prefix, manifest)


if __name__ == "__main__":
    raise SystemExit(main())
