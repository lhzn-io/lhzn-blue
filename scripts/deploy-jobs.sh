#!/bin/bash
# Build the ingest image and (re)deploy the Cloud Run jobs: `live` (hourly), `latest` (the buoys every 15 minutes
# between hourly runs), `history` and `fields` (daily),
# `snapshot` (saved copies of the server's datasets, and the Sound's HF radar days, three times a week),
# `forecast` (HRRR at the stations, hourly), and `forecast-backfill` (past HRRR cycles, run by hand).
# Settings come from ~/.config/lhzn-blue/env (never committed):
#   GCP_PROJECT      Google Cloud project id
#   GCP_REGION       e.g. us-central1
#   DATA_STORE       kv://<cloudflare account id>/<KV namespace id> the jobs write to
#   JOB_SA           service account email the jobs run as
#   CF_TOKEN_SECRET  Secret Manager secret holding the Cloudflare API token (Workers KV edit)
#   USGS_KEY_SECRET  optional: Secret Manager secret holding a USGS Water Data API key (api.data.gov)
#   SNAPSHOT_STORE   gs://bucket/prefix the snapshot job saves the server's datasets to
#   FORECAST_STORE   gs://bucket/prefix the forecast job archives HRRR at the stations to
#   NWPS_STORE       optional: gs://bucket/prefix for the NWPS wave model runs (default: nwps-okx beside FORECAST_STORE)
#   NECOFS_WAVES_STORE optional: gs://bucket/prefix for the NECOFS wave runs read (default: necofs-waves beside FORECAST_STORE)
#   PANELS_STORE     optional: gs://bucket/prefix for the LISICOS panel images as fetched (default: lisicos-panels beside it)
#   HFRADAR_STORE    optional: gs://bucket/prefix for the Sound's HF radar surface currents, kept by the snapshot job
#                    (default: hfradar-usegc beside FORECAST_STORE)
#   TILES_R2_BUCKET, TILES_R2_ENDPOINT  optional: the R2 bucket and S3 endpoint for the `shelf` job's tiles (shelf.py, tiles.py);
#                    without them the `shelf` job is not deployed. Its keys are in Secret Manager (setup-gcp.sh).
# `shelf` (daily): the Northeast U.S. Shelf's currents to the R2 tile store, only when R2 is configured;
# `shelf-wind` (every 6 hours): HRRR and GFS wind over the same domain, to the same store.
# Scheduling is separate (scripts/schedule-jobs.sh), so redeploying code does not touch triggers.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$HOME/.config/lhzn-blue/env"; set +a
: "${GCP_PROJECT:?}" "${GCP_REGION:?}" "${DATA_STORE:?}" "${JOB_SA:?}" "${CF_TOKEN_SECRET:?}" "${SNAPSHOT_STORE:?}" "${FORECAST_STORE:?}"

# Stage a build context with the Dockerfile at its root, plus the station registry.
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT
mkdir -p "$CTX/jobs" "$CTX/stations"
cp -R "$REPO/jobs/pyproject.toml" "$REPO/jobs/src" "$CTX/jobs/"
[ -f "$REPO/jobs/README.md" ] && cp "$REPO/jobs/README.md" "$CTX/jobs/"
cp "$REPO"/stations/*.json "$CTX/stations/"  # every registry file; a file left out fails its job only in the cloud
cp "$REPO/jobs/Dockerfile" "$CTX/Dockerfile"

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/lhzn-blue/ingest:$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || date +%s)"
# Build as the job's own service account (scoped grants in setup-gcp.sh), without build logs.
cat > "$CTX/cloudbuild.yaml" <<YAML
steps:
  - name: gcr.io/cloud-builders/docker
    args: ["build", "-t", "${IMAGE}", "."]
images: ["${IMAGE}"]
options:
  logging: NONE
YAML
gcloud builds submit "$CTX" --project "$GCP_PROJECT" --region "$GCP_REGION" \
  --config "$CTX/cloudbuild.yaml" --service-account "projects/${GCP_PROJECT}/serviceAccounts/${JOB_SA}"

NWPS_STORE="${NWPS_STORE:-${FORECAST_STORE%/*}/nwps-okx}"
NECOFS_WAVES_STORE="${NECOFS_WAVES_STORE:-${FORECAST_STORE%/*}/necofs-waves}"
PANELS_STORE="${PANELS_STORE:-${FORECAST_STORE%/*}/lisicos-panels}"
HFRADAR_STORE="${HFRADAR_STORE:-${FORECAST_STORE%/*}/hfradar-usegc}"
SECRETS="CLOUDFLARE_API_TOKEN=${CF_TOKEN_SECRET}:latest"
[ -n "${USGS_KEY_SECRET:-}" ] && SECRETS="${SECRETS},USGS_API_KEY=${USGS_KEY_SECRET}:latest"

# Per job: timeout and memory. `live` and `latest` read the LISICOS panels (Tesseract) when the server is down. `fields` reads the model mesh and satellite grids, so it gets the most memory;
# `snapshot` holds one dataset's whole record at a time. The Piscataqua Region's jobs (region.py) run on their own:
# `region-live` hourly, `region-daily` (rivers' record, currents and SST) and `region-wind` (HRRR) every 3 hours.
# The two daily jobs that read CoastWatch get an hour: a server that stops answering is skipped after one short
# question (coastwatch_guard.py), and the hour is the backstop.
declare -A TIMEOUT=([live]=10m [latest]=5m [history]=30m [fields]=60m [snapshot]=45m [forecast]=30m [panels]=8m
  [region-live]=15m [region-daily]=60m [region-wind]=15m)
declare -A MEMORY=([live]=1Gi [latest]=1Gi [history]=1Gi [fields]=2Gi [snapshot]=1Gi [forecast]=2Gi [panels]=1Gi
  [region-live]=1Gi [region-daily]=2Gi [region-wind]=2Gi)
for mode in live latest history fields snapshot forecast panels region-live region-daily region-wind; do
  gcloud run jobs deploy "lhzn-blue-${mode}" \
    --project "$GCP_PROJECT" --region "$GCP_REGION" --image "$IMAGE" \
    --service-account "$JOB_SA" --args "$mode" \
    --set-env-vars "LHZN_BLUE_OUT=${DATA_STORE},LHZN_BLUE_SNAPSHOTS=${SNAPSHOT_STORE},LHZN_BLUE_FORECASTS=${FORECAST_STORE},LHZN_BLUE_NWPS=${NWPS_STORE},LHZN_BLUE_NECOFS_WAVES=${NECOFS_WAVES_STORE},LHZN_BLUE_PANELS_ARCHIVE=${PANELS_STORE},LHZN_BLUE_HFRADAR=${HFRADAR_STORE}" \
    --set-secrets "$SECRETS" \
    --tasks 1 --max-retries 1 --task-timeout "${TIMEOUT[$mode]}" \
    --cpu 1 --memory "${MEMORY[$mode]}"
done

# The Northeast U.S. Shelf (shelf.py): its own job, with its own memory (3.3 GB at its peak, reading NECOFS's 45 layers
# for the depths), and the only one given the R2 keys (Object Read and Write on the tile bucket alone).
if [ -n "${TILES_R2_BUCKET:-}" ] && [ -n "${TILES_R2_ENDPOINT:-}" ]; then
  gcloud run jobs deploy "lhzn-blue-shelf" \
    --project "$GCP_PROJECT" --region "$GCP_REGION" --image "$IMAGE" \
    --service-account "$JOB_SA" --args "shelf" \
    --set-env-vars "LHZN_BLUE_OUT=${DATA_STORE},LHZN_BLUE_TILES=r2://${TILES_R2_BUCKET},TILES_R2_ENDPOINT=${TILES_R2_ENDPOINT}" \
    --set-secrets "${SECRETS},TILES_R2_ACCESS_KEY_ID=lhzn-blue-r2-key-id:latest,TILES_R2_SECRET_ACCESS_KEY=lhzn-blue-r2-secret:latest" \
    --tasks 1 --max-retries 1 --task-timeout 60m \
    --cpu 1 --memory 4Gi
  # Wind over the shelf (shelf_wind.py): HRRR and GFS every 6 hours, to the same tile store. About 300 MB of byte-range
  # reads and under a minute of decoding a run; 2 GiB holds one lead at a time.
  gcloud run jobs deploy "lhzn-blue-shelf-wind" \
    --project "$GCP_PROJECT" --region "$GCP_REGION" --image "$IMAGE" \
    --service-account "$JOB_SA" --args "shelf-wind" \
    --set-env-vars "LHZN_BLUE_OUT=${DATA_STORE},LHZN_BLUE_TILES=r2://${TILES_R2_BUCKET},TILES_R2_ENDPOINT=${TILES_R2_ENDPOINT}" \
    --set-secrets "${SECRETS},TILES_R2_ACCESS_KEY_ID=lhzn-blue-r2-key-id:latest,TILES_R2_SECRET_ACCESS_KEY=lhzn-blue-r2-secret:latest" \
    --tasks 1 --max-retries 1 --task-timeout 20m \
    --cpu 1 --memory 2Gi
else
  echo "TILES_R2_BUCKET or TILES_R2_ENDPOINT not set: lhzn-blue-shelf and lhzn-blue-shelf-wind not deployed"
fi

# The HRRR backfill: never scheduled; run by hand with its dates, e.g.
#   gcloud run jobs execute lhzn-blue-forecast-backfill --tasks 250 \
#     --args=forecast-backfill,-v,--start,2024-01-01T00,--end,2024-12-31T23
# Each task takes every 250th cycle (about 100 cycles for 2024 to 2026, 20 minutes on one vCPU, inside the timeout);
# create-only writes, so a rerun only fills gaps.
# HRDPS's backfill runs on the same job while the MSC Datamart keeps the runs (30 days), e.g.
#   gcloud run jobs execute lhzn-blue-forecast-backfill --tasks 8 \
#     --args=hrdps-backfill,-v,--start,2026-10-11T00,--end,2026-11-09T18
gcloud run jobs deploy "lhzn-blue-forecast-backfill" \
  --project "$GCP_PROJECT" --region "$GCP_REGION" --image "$IMAGE" \
  --service-account "$JOB_SA" --args "forecast-backfill" \
  --set-env-vars "LHZN_BLUE_OUT=${DATA_STORE},LHZN_BLUE_FORECASTS=${FORECAST_STORE}" \
  --set-secrets "$SECRETS" \
  --tasks 1 --parallelism 20 --max-retries 1 --task-timeout 60m \
  --cpu 1 --memory 2Gi
