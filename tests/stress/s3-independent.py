#!/usr/bin/env python3
"""Stress DH-4: an INDEPENDENT S3 listing (boto3) of the rewind canary bucket, to compare with what the range reports.

The range reads object versions through the broker's own TypeScript S3 client. This script uses a different implementation (Python boto3) and
the owner S3 credentials from the environment (VULTR_S3_ACCESS_KEY, VULTR_S3_SECRET_KEY, VULTR_S3_HOST). It prints NAME/version-id/latest/delete-marker
lines so a human or a test can diff them against GET /api/rewind (session key required). Usage: s3-independent.py <bucket> [prefix]
"""
import os, sys, json
import boto3
from botocore.config import Config
bucket = sys.argv[1]; prefix = sys.argv[2] if len(sys.argv) > 2 else ''
s3 = boto3.client('s3', endpoint_url='https://' + os.environ['VULTR_S3_HOST'], aws_access_key_id=os.environ['VULTR_S3_ACCESS_KEY'],
                  aws_secret_access_key=os.environ['VULTR_S3_SECRET_KEY'], region_name='us-east-1', config=Config(s3={'addressing_style': 'path'}, retries={'max_attempts': 3}))
out = []
for page in s3.get_paginator('list_object_versions').paginate(Bucket=bucket, Prefix=prefix):
    for v in page.get('Versions', []): out.append({'key': v['Key'], 'version_id': v['VersionId'], 'latest': v['IsLatest'], 'size': v['Size'], 'delete_marker': False})
    for m in page.get('DeleteMarkers', []): out.append({'key': m['Key'], 'version_id': m['VersionId'], 'latest': m['IsLatest'], 'size': 0, 'delete_marker': True})
print(json.dumps(sorted(out, key=lambda x: (x['key'], x['version_id']))))
