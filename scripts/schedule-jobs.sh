#!/bin/bash
# Create or update the Cloud Scheduler triggers: `live` at 20 minutes past each hour, `history` daily.
# Uses the same ~/.config/lhzn-blue/env as deploy-jobs.sh, plus:
#   SCHEDULER_SA  service account allowed to run the jobs (roles/run.invoker)
set -euo pipefail
set -a; . "$HOME/.config/lhzn-blue/env"; set +a
: "${GCP_PROJECT:?}" "${GCP_REGION:?}" "${SCHEDULER_SA:?}"

trigger() { # name, cron, job
  local uri="https://run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/jobs/$3:run"
  local verb=create
  gcloud scheduler jobs describe "$1" --project "$GCP_PROJECT" --location "$GCP_REGION" >/dev/null 2>&1 && verb=update
  gcloud scheduler jobs "$verb" http "$1" --project "$GCP_PROJECT" --location "$GCP_REGION" \
    --schedule "$2" --time-zone "America/New_York" --uri "$uri" --http-method POST \
    --oauth-service-account-email "$SCHEDULER_SA" --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform"
}

for job in lhzn-blue-live lhzn-blue-history; do
  gcloud run jobs add-iam-policy-binding "$job" --project "$GCP_PROJECT" --region "$GCP_REGION" \
    --member "serviceAccount:$SCHEDULER_SA" --role roles/run.invoker >/dev/null
done

# The buoys report every 15 minutes and the server publishes about an hour later; hourly is enough
# for 36-hour means and gentle on the server.
trigger lhzn-blue-live "20 * * * *" lhzn-blue-live
trigger lhzn-blue-history "15 3 * * *" lhzn-blue-history
