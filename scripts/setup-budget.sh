#!/bin/bash
# A monthly budget on the project with e-mail alerts at 50, 90 and 100% (to the billing account's admins), so a
# runaway cost shows up within days. Safe to re-run: an existing budget with the same name is updated.
# Settings come from ~/.config/lhzn-blue/env: GCP_PROJECT; optional BUDGET_USD (default 10).
set -euo pipefail
set -a; . "$HOME/.config/lhzn-blue/env"; set +a
: "${GCP_PROJECT:?}"
AMOUNT="${BUDGET_USD:-10}"
NAME="longhorizon.blue monthly"

gcloud services enable billingbudgets.googleapis.com --project "$GCP_PROJECT"
ACCOUNT="$(gcloud billing projects describe "$GCP_PROJECT" --format='value(billingAccountName)')"
ACCOUNT="${ACCOUNT#billingAccounts/}"
: "${ACCOUNT:?the project has no billing account}"
NUMBER="$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')"

EXISTING="$(gcloud billing budgets list --billing-account "$ACCOUNT" --filter="displayName=\"$NAME\"" --format='value(name)' | head -1)"
RULES=(--threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0)
if [ -n "$EXISTING" ]; then
  gcloud billing budgets update "$EXISTING" --billing-account "$ACCOUNT" --budget-amount "${AMOUNT}USD" \
    --clear-threshold-rules "${RULES[@]}"
else
  gcloud billing budgets create --billing-account "$ACCOUNT" --display-name "$NAME" --budget-amount "${AMOUNT}USD" \
    --filter-projects "projects/$NUMBER" "${RULES[@]}"
fi
gcloud billing budgets list --billing-account "$ACCOUNT" --format='table(displayName,amount.specifiedAmount.units,thresholdRules)'
