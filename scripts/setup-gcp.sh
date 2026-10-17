#!/bin/bash
# One-time Google Cloud setup for the ingest jobs. Safe to re-run.
# Settings come from ~/.config/lhzn-blue/env (never committed): GCP_PROJECT, GCP_REGION,
# JOB_SA (service account email; also used by Cloud Scheduler), CF_TOKEN_SECRET (secret name).
#
# The jobs write the published JSON to Cloudflare Workers KV. The one thing Google Cloud keeps is the snapshot
# job's saved copies of the server's datasets (SNAPSHOT_STORE, a gs:// bucket and prefix): about 50 MB three
# times a week, moved to Coldline storage after 30 days (about $0.05 a month for a year of copies).
# The Cloudflare token (Workers KV edit only) lives in Secret Manager; add it yourself with:
#   printf '%s' "<token>" | gcloud secrets versions add "$CF_TOKEN_SECRET" --data-file=- --project "$GCP_PROJECT"
set -euo pipefail
set -a; . "$HOME/.config/lhzn-blue/env"; set +a
: "${GCP_PROJECT:?}" "${GCP_REGION:?}" "${JOB_SA:?}" "${CF_TOKEN_SECRET:?}" "${SNAPSHOT_STORE:?}" "${FORECAST_STORE:?}"
P=(--project "$GCP_PROJECT")

gcloud services enable cloudbuild.googleapis.com cloudscheduler.googleapis.com run.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com "${P[@]}"

gcloud artifacts repositories describe lhzn-blue --location "$GCP_REGION" "${P[@]}" >/dev/null 2>&1 ||
  gcloud artifacts repositories create lhzn-blue --repository-format docker --location "$GCP_REGION" "${P[@]}" \
    --description "longhorizon.blue ingest images"

SA_NAME="${JOB_SA%%@*}"
gcloud iam service-accounts describe "$JOB_SA" "${P[@]}" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" "${P[@]}" --display-name "longhorizon.blue ingest"

# Cloud Build runs as the same account: push to this one image repository, read the build source.
gcloud artifacts repositories add-iam-policy-binding lhzn-blue --location "$GCP_REGION" "${P[@]}" \
  --member "serviceAccount:$JOB_SA" --role roles/artifactregistry.writer >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${GCP_PROJECT}_cloudbuild" "${P[@]}" \
  --member "serviceAccount:$JOB_SA" --role roles/storage.objectViewer >/dev/null

# Keep only the newest images: every deploy pushes one (about 1 GB with the field libraries), and the
# repository's free allowance is 0.5 GB. The policy deletes older tagged images automatically.
POLICY="$(mktemp)"
cat > "$POLICY" <<'JSON'
[
  {"name": "keep-newest-5", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 5}},
  {"name": "delete-older", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "1d"}}
]
JSON
gcloud artifacts repositories set-cleanup-policies lhzn-blue --location "$GCP_REGION" "${P[@]}" \
  --policy "$POLICY" --no-dry-run >/dev/null
rm -f "$POLICY"

gcloud secrets describe "$CF_TOKEN_SECRET" "${P[@]}" >/dev/null 2>&1 ||
  gcloud secrets create "$CF_TOKEN_SECRET" "${P[@]}" --replication-policy automatic
gcloud secrets add-iam-policy-binding "$CF_TOKEN_SECRET" "${P[@]}" \
  --member "serviceAccount:$JOB_SA" --role roles/secretmanager.secretAccessor >/dev/null
# Snapshots and the forecast archive (same bucket): the jobs may create objects but not overwrite or delete
# them (object creator only).
SNAP_BUCKET="${SNAPSHOT_STORE#gs://}"; SNAP_BUCKET="${SNAP_BUCKET%%/*}"
SNAP_PREFIX="${SNAPSHOT_STORE#gs://$SNAP_BUCKET}"; SNAP_PREFIX="${SNAP_PREFIX#/}"
FC_PREFIX="${FORECAST_STORE#gs://$SNAP_BUCKET}"; FC_PREFIX="${FC_PREFIX#/}"
NWPS_STORE="${NWPS_STORE:-${FORECAST_STORE%/*}/nwps-okx}"  # the NWPS wave model runs (same bucket)
NWPS_PREFIX="${NWPS_STORE#gs://$SNAP_BUCKET}"; NWPS_PREFIX="${NWPS_PREFIX#/}"
PANELS_STORE="${PANELS_STORE:-${FORECAST_STORE%/*}/lisicos-panels}"  # the LISICOS panel images (same bucket)
PANELS_PREFIX="${PANELS_STORE#gs://$SNAP_BUCKET}"; PANELS_PREFIX="${PANELS_PREFIX#/}"
gcloud storage buckets add-iam-policy-binding "gs://$SNAP_BUCKET" "${P[@]}" \
  --member "serviceAccount:$JOB_SA" --role roles/storage.objectCreator >/dev/null
# Copies older than 30 days move to Coldline (read rarely, kept indefinitely). The second prefix covers the
# notebook's earlier copies, whose object names begin with a slash.
LIFECYCLE="$(mktemp)"
cat > "$LIFECYCLE" <<JSON
{"rule": [{"action": {"type": "SetStorageClass", "storageClass": "COLDLINE"},
           "condition": {"age": 30, "matchesStorageClass": ["STANDARD"], "matchesPrefix": ["${SNAP_PREFIX%/}/", "/${SNAP_PREFIX%/}/", "${FC_PREFIX%/}/", "${NWPS_PREFIX%/}/", "${PANELS_PREFIX%/}/"]}}]}
JSON
gcloud storage buckets update "gs://$SNAP_BUCKET" "${P[@]}" --lifecycle-file "$LIFECYCLE" >/dev/null
rm -f "$LIFECYCLE"
echo "setup complete: $JOB_SA, secret $CF_TOKEN_SECRET, snapshots in $SNAPSHOT_STORE"
