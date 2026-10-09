# Ingest jobs for Cloud Run. Built by scripts/deploy-jobs.sh from a staging directory that holds
# jobs/ and stations/ (so the station registry ships with the image).
FROM python:3.12-slim
WORKDIR /app
COPY jobs/ /app/jobs/
COPY stations/ /app/stations/
RUN pip install --no-cache-dir /app/jobs
ENV LHZN_BLUE_STATIONS=/app/stations/stations.json \
    LHZN_BLUE_SHORE_STATIONS=/app/stations/shore.json \
    PYTHONUNBUFFERED=1
ENTRYPOINT ["lhzn-blue-jobs"]
