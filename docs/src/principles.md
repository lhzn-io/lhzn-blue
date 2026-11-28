# Design principles: staying up

The site reads about a dozen public data services. At any hour, one may be unreachable, slow, or publishing partial
data. The jobs follow four rules.

## Keep the last good values

A run that cannot reach a source records the failure and leaves the published values in place. Each value shows its
age, so a held-over value reads as old. A one-line notice states the outage and the last reading's time.

## Never drop an hour held

The daily build rebuilds each record from its source and merges it over the previous build. A held hour survives
when its source drops it: a withdrawn or renamed dataset, or a failed request. Saved copies of the source datasets,
taken three times a week, back the record. A held value is replaced only by a better value for the same hour; a
source value replaces a transcribed or model value. Gaps stay gaps.

## Mark stand-in data

A buoy outage brings in two kinds of stand-in. Plots, tables, readouts and the "Ask your AI" prompt label both.

Transcribed readings
: Read from LISICOS station panel images while the data server is unreachable. Each value is checked against its
  printed unit conversions and a plausible range, marked "transcribed" and credited to LISICOS. Server values
  replace them once the server answers.

Model values
: HRRR weather and NWPS waves at the buoy's location and hour, labeled as a model. The outage notice stays.

## Fail fast on upstream outages

After a server fails every connection retry, the run's remaining requests to it fail immediately, and the run moves
on. A server that connects but stalls is cut off after a fixed total time. Without the cutoff, one unreachable
server once held the hourly run to its time limit and froze the shore stations and rivers published after the buoys.

The jobs also cap their load on each source. Requests run one at a time, spaced apart. Retry-After is honored. Each
job has a fixed request allowance. Hourly runs fetch only recent days; full records rebuild daily. Each run logs its
requests.
