#!/bin/bash
# Create or update the Cloud Scheduler triggers: `live` at 20 minutes past each hour, `history` and `fields` daily,
# `latest` at 5, 35 and 50 past the hour, `snapshot` three times a week. Three triggers are the free allowance per
# billing account; each further one costs $0.10 a month.
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

for job in lhzn-blue-live lhzn-blue-latest lhzn-blue-history lhzn-blue-fields lhzn-blue-snapshot lhzn-blue-forecast lhzn-blue-panels \
  lhzn-blue-region-live lhzn-blue-region-daily lhzn-blue-region-wind; do
  gcloud run jobs add-iam-policy-binding "$job" --project "$GCP_PROJECT" --region "$GCP_REGION" \
    --member "serviceAccount:$SCHEDULER_SA" --role roles/run.invoker >/dev/null
done

# The buoys report every 15 minutes and the server publishes about an hour later; hourly is enough
# for 36-hour means and gentle on the server.
trigger lhzn-blue-live "20 * * * *" lhzn-blue-live
# The buoys between hourly runs, so the page trails the server by at most about 15 minutes. The server posts
# readings about 70 to 80 minutes late; each quick run asks for the last 3 hours of 8 small datasets.
trigger lhzn-blue-latest "5,35,50 * * * *" lhzn-blue-latest
trigger lhzn-blue-history "15 3 * * *" lhzn-blue-history
# Surface fields once a day, after the morning NECOFS forecast (posted by about 07:00) and the daily MUR analysis.
trigger lhzn-blue-fields "30 8 * * *" lhzn-blue-fields
# Saved copies of the server's datasets on Monday, Wednesday and Friday, after the history build: a few hundred
# requests each, so not daily.
trigger lhzn-blue-snapshot "45 4 * * 1,3,5" lhzn-blue-snapshot
# HRRR at the stations, hourly: each run archives the complete cycles of the last 4 hours not yet kept.
trigger lhzn-blue-forecast "40 * * * *" lhzn-blue-forecast
# The LISICOS station panels while the data server is down (a stopgap): weather every 10 minutes, waves and water
# quality every 30 (the job decides). Pause this trigger when the server returns, or if LISICOS asks.
trigger lhzn-blue-panels "*/10 * * * *" lhzn-blue-panels
# The Piscataqua Region (region.py), about 37 Workers KV writes a day: its observations hourly, between the Sound's
# runs; its rivers' record, currents and SST daily, after the Sound's fields; its HRRR wind every 3 hours.
trigger lhzn-blue-region-live "25 * * * *" lhzn-blue-region-live
trigger lhzn-blue-region-daily "45 8 * * *" lhzn-blue-region-daily
trigger lhzn-blue-region-wind "10 */3 * * *" lhzn-blue-region-wind
