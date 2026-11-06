#!/usr/bin/env python3
"""DT-3 fallback for the Object Storage versioning path (U-5), used ONLY if the Node AWS SDK v3 path fails
against ewr1 (signature or path-style). Same JSON shape as S3Store.listVersions so callers do not change.

Pinned dependency:  pip install 'boto3==1.35.99'   (checked at startup; a different version refuses to run)

Credentials come from the environment only (never a file, never argv):
  VULTR_S3_HOST  VULTR_S3_ACCESS_KEY  VULTR_S3_SECRET_KEY  [VULTR_S3_BUCKET, default plumbline-orders-db]

Usage:
  s3-boto3-helper.py list-versions KEY
  s3-boto3-helper.py get KEY
  s3-boto3-helper.py delete KEY            # adds a delete marker (versioned bucket)
  s3-boto3-helper.py restore KEY VERSION   # CopyObject by VersionId -> a NEW latest version

Mutating commands are for the integrator's gate only; the broker never shells out to this script.
"""
import json
import os
import sys
from datetime import datetime, timezone

PINNED = "1.35.99"


def _client():
    import boto3
    from botocore.config import Config

    if boto3.__version__ != PINNED:
        sys.exit(f"REFUSED: boto3 {boto3.__version__} is installed, pinned version is {PINNED}")
    env = {k: os.environ.get(k, "") for k in ("VULTR_S3_HOST", "VULTR_S3_ACCESS_KEY", "VULTR_S3_SECRET_KEY")}
    missing = [k for k, v in env.items() if not v]
    if missing:
        sys.exit(f"REFUSED: missing environment: {', '.join(missing)}")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{env['VULTR_S3_HOST']}",
        aws_access_key_id=env["VULTR_S3_ACCESS_KEY"],
        aws_secret_access_key=env["VULTR_S3_SECRET_KEY"],
        region_name="us-east-1",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def _iso(d):
    return d.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if d else ""


def list_versions(client, bucket, key):
    """Follows pagination; a listing that cannot finish is an error, never a short count (fails closed)."""
    versions, markers, kwargs = [], [], {"Bucket": bucket, "Prefix": key}
    for _ in range(10):
        r = client.list_object_versions(**kwargs)
        versions += [
            {"versionId": v["VersionId"], "isLatest": bool(v["IsLatest"]), "size": v["Size"], "lastModified": _iso(v["LastModified"])}
            for v in r.get("Versions", []) if v["Key"] == key
        ]
        markers += [
            {"versionId": m["VersionId"], "isLatest": bool(m["IsLatest"]), "lastModified": _iso(m["LastModified"])}
            for m in r.get("DeleteMarkers", []) if m["Key"] == key
        ]
        if not r.get("IsTruncated"):
            return {"versions": versions, "deleteMarkers": markers, "fetched_at": _iso(datetime.now(timezone.utc))}
        kwargs.update(KeyMarker=r.get("NextKeyMarker"), VersionIdMarker=r.get("NextVersionIdMarker"))
    sys.exit("LISTING_INCOMPLETE: version listing did not finish, object state unknown")


def run(argv, client=None, bucket=None):
    cmd, args = (argv + [""])[0], argv[1:]
    bucket = bucket or os.environ.get("VULTR_S3_BUCKET", "plumbline-orders-db")
    client = client or _client()
    if cmd == "list-versions" and len(args) == 1:
        return list_versions(client, bucket, args[0])
    if cmd == "get" and len(args) == 1:
        return {"body": client.get_object(Bucket=bucket, Key=args[0])["Body"].read().decode()}
    if cmd == "delete" and len(args) == 1:
        return {"versionId": client.delete_object(Bucket=bucket, Key=args[0]).get("VersionId", "")}
    if cmd == "restore" and len(args) == 2:
        r = client.copy_object(Bucket=bucket, Key=args[0], CopySource={"Bucket": bucket, "Key": args[0], "VersionId": args[1]})
        return {"versionId": r.get("VersionId", "")}
    sys.exit(__doc__)


if __name__ == "__main__":
    print(json.dumps(run(sys.argv[1:])))
