# Ingest jobs for Cloud Run. Built by scripts/deploy-jobs.sh from a staging directory that holds
# jobs/ and stations/ (so the station registry ships with the image).
FROM python:3.12-slim
WORKDIR /app
COPY jobs/ /app/jobs/
COPY stations/ /app/stations/
# Tesseract (with English) reads the LISICOS station panels in the `panels` job.
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir /app/jobs
ENV LHZN_BLUE_STATIONS=/app/stations/stations.json \
    LHZN_BLUE_SHORE_STATIONS=/app/stations/shore.json \
    LHZN_BLUE_RIVERS=/app/stations/rivers.json \
    LHZN_BLUE_USGS_TIDAL=/app/stations/usgs-tidal.json \
    LHZN_BLUE_ASOS=/app/stations/asos.json \
    LHZN_BLUE_RIPS=/app/stations/rips-lis.json \
    LHZN_BLUE_REGION=/app/stations/piscataqua-region.json \
    PYTHONUNBUFFERED=1
ENTRYPOINT ["lhzn-blue-jobs"]
