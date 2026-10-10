#!/bin/bash
# Build the ingest image and (re)deploy the Cloud Run jobs: `live` (hourly), `history` and `fields` (daily).
# Settings come from ~/.config/lhzn-blue/env (never committed):
#   GCP_PROJECT      Google Cloud project id
#   GCP_REGION       e.g. us-central1
#   DATA_STORE       kv://<cloudflare account id>/<KV namespace id> the jobs write to
#   JOB_SA           service account email the jobs run as
#   CF_TOKEN_SECRET  Secret Manager secret holding the Cloudflare API token (Workers KV edit)
#   USGS_KEY_SECRET  optional: Secret Manager secret holding a USGS Water Data API key (api.data.gov)
# Scheduling is separate (scripts/schedule-jobs.sh), so redeploying code does not touch triggers.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
set -a; . "$HOME/.config/lhzn-blue/env"; set +a
: "${GCP_PROJECT:?}" "${GCP_REGION:?}" "${DATA_STORE:?}" "${JOB_SA:?}" "${CF_TOKEN_SECRET:?}"

# Stage a build context with the Dockerfile at its root, plus the station registry.
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT
mkdir -p "$CTX/jobs" "$CTX/stations"
cp -R "$REPO/jobs/pyproject.toml" "$REPO/jobs/src" "$CTX/jobs/"
[ -f "$REPO/jobs/README.md" ] && cp "$REPO/jobs/README.md" "$CTX/jobs/"
cp "$REPO/stations/stations.json" "$REPO/stations/shore.json" "$REPO/stations/rivers.json" "$CTX/stations/"
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

# Per job: timeout and memory. `fields` reads the model mesh and satellite grids, so it gets the most memory.
declare -A TIMEOUT=([live]=10m [history]=30m [fields]=20m)
declare -A MEMORY=([live]=512Mi [history]=1Gi [fields]=2Gi)
for mode in live history fields; do
  gcloud run jobs deploy "lhzn-blue-${mode}" \
    --project "$GCP_PROJECT" --region "$GCP_REGION" --image "$IMAGE" \
    --service-account "$JOB_SA" --args "$mode" \
    --set-env-vars "LHZN_BLUE_OUT=${DATA_STORE}" \
    --set-secrets "$SECRETS" \
    --tasks 1 --max-retries 1 --task-timeout "${TIMEOUT[$mode]}" \
    --cpu 1 --memory "${MEMORY[$mode]}"
done
