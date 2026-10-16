#!/bin/bash
# Build the ingest image and (re)deploy the Cloud Run jobs: `live` (hourly), `latest` (the buoys every 15 minutes
# between hourly runs), `history` and `fields` (daily),
# `snapshot` (saved copies of the server's datasets, three times a week), `forecast` (HRRR at the stations, hourly),
# and `forecast-backfill` (past HRRR cycles, run by hand).
# Settings come from ~/.config/lhzn-blue/env (never committed):
#   GCP_PROJECT      Google Cloud project id
#   GCP_REGION       e.g. us-central1
#   DATA_STORE       kv://<cloudflare account id>/<KV namespace id> the jobs write to
#   JOB_SA           service account email the jobs run as
#   CF_TOKEN_SECRET  Secret Manager secret holding the Cloudflare API token (Workers KV edit)
#   USGS_KEY_SECRET  optional: Secret Manager secret holding a USGS Water Data API key (api.data.gov)
#   SNAPSHOT_STORE   gs://bucket/prefix the snapshot job saves the server's datasets to
#   FORECAST_STORE   gs://bucket/prefix the forecast job archives HRRR at the stations to
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
cp "$REPO/stations/stations.json" "$REPO/stations/shore.json" "$REPO/stations/rivers.json" "$REPO/stations/usgs-tidal.json" "$CTX/stations/"
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

SECRETS="CLOUDFLARE_API_TOKEN=${CF_TOKEN_SECRET}:latest"
[ -n "${USGS_KEY_SECRET:-}" ] && SECRETS="${SECRETS},USGS_API_KEY=${USGS_KEY_SECRET}:latest"

# Per job: timeout and memory. `fields` reads the model mesh and satellite grids, so it gets the most memory;
# `snapshot` holds one dataset's whole record at a time.
declare -A TIMEOUT=([live]=20m [latest]=5m [history]=30m [fields]=30m [snapshot]=45m [forecast]=30m)
declare -A MEMORY=([live]=512Mi [latest]=512Mi [history]=1Gi [fields]=2Gi [snapshot]=1Gi [forecast]=2Gi)
for mode in live latest history fields snapshot forecast; do
  gcloud run jobs deploy "lhzn-blue-${mode}" \
    --project "$GCP_PROJECT" --region "$GCP_REGION" --image "$IMAGE" \
    --service-account "$JOB_SA" --args "$mode" \
    --set-env-vars "LHZN_BLUE_OUT=${DATA_STORE},LHZN_BLUE_SNAPSHOTS=${SNAPSHOT_STORE},LHZN_BLUE_FORECASTS=${FORECAST_STORE}" \
    --set-secrets "$SECRETS" \
    --tasks 1 --max-retries 1 --task-timeout "${TIMEOUT[$mode]}" \
    --cpu 1 --memory "${MEMORY[$mode]}"
done

# The HRRR backfill: never scheduled; run by hand with its dates, e.g.
#   gcloud run jobs execute lhzn-blue-forecast-backfill --tasks 250 \
#     --args=forecast-backfill,-v,--start,2024-01-01T00,--end,2024-12-31T23
# Each task takes every 250th cycle (about 100 cycles for 2024 to 2026, 20 minutes on one vCPU, inside the timeout);
# create-only writes, so a rerun only fills gaps.
gcloud run jobs deploy "lhzn-blue-forecast-backfill" \
  --project "$GCP_PROJECT" --region "$GCP_REGION" --image "$IMAGE" \
  --service-account "$JOB_SA" --args "forecast-backfill" \
  --set-env-vars "LHZN_BLUE_OUT=${DATA_STORE},LHZN_BLUE_FORECASTS=${FORECAST_STORE}" \
  --set-secrets "$SECRETS" \
  --tasks 1 --parallelism 20 --max-retries 1 --task-timeout 60m \
  --cpu 1 --memory 2Gi
