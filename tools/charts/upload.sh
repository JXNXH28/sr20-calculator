#!/usr/bin/env bash
# Upload the tile pyramid built by build.sh to Cloudflare R2 (S3 API) and switch current.json.
#
# Needs the AWS CLI (v2 preinstalled on GitHub's ubuntu runners) and:
#   R2_ACCOUNT_ID  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET
# Env: OUT (default tools/charts/out), KEEP (editions to keep, default 2: current + previous)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$HERE/out}"
KEEP="${KEEP:-2}"
: "${R2_ACCOUNT_ID:?}" "${R2_BUCKET:?}"
export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?}"
export AWS_DEFAULT_REGION=auto AWS_EC2_METADATA_DISABLED=true
export AWS_MAX_CONCURRENT_REQUESTS=64
# R2 does not support the newer default checksum trailers
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
S3=(aws s3 --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com")
S3API=(aws s3api --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com")

EDITION="$(python3 -c "import json,sys;print(json.load(open('$OUT/current.json'))['edition'])")"
[ -d "$OUT/$EDITION" ] || { echo "missing $OUT/$EDITION"; exit 1; }
echo "uploading edition $EDITION to r2://$R2_BUCKET"

# 1. tiles first (immutable: the edition date is part of the path). --size-only keeps re-runs cheap.
"${S3[@]}" sync "$OUT/$EDITION" "s3://$R2_BUCKET/$EDITION" \
  --only-show-errors --size-only \
  --content-type image/webp \
  --cache-control "public, max-age=31536000, immutable"

# 2. the pointer last = atomic switch to the new edition (short cache)
"${S3[@]}" cp "$OUT/current.json" "s3://$R2_BUCKET/current.json" \
  --only-show-errors \
  --content-type application/json \
  --cache-control "public, max-age=300"

# 3. prune: keep the newest $KEEP editions (current + previous), delete the rest
mapfile -t EDS < <("${S3API[@]}" list-objects-v2 --bucket "$R2_BUCKET" --delimiter / --query 'CommonPrefixes[].Prefix' --output text \
  | tr '\t' '\n' | tr -d / | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -r)
i=0
for ed in "${EDS[@]}"; do
  i=$((i + 1))
  if [ "$i" -gt "$KEEP" ]; then
    echo "pruning old edition $ed"
    "${S3[@]}" rm "s3://$R2_BUCKET/$ed/" --recursive --only-show-errors
  fi
done
echo "done"
