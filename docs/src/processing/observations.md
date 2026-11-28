# From readings to hourly series

Buoys report every few minutes, NOAA stations every 6 minutes, river gauges every 15 minutes. The jobs reduce each
source to one hourly UTC series; all derived values come from those hours.

## Quality control

Buoy readings pass three tests before averaging. A failed reading becomes a gap.

Gross range
: Temperature -2 to 35 °C, salinity 5 to 36, dissolved oxygen 0 to 20 mg/L; narrower where a waterway sets its own
  range.

Spike
: Dropped if more than 1.5 °C, 1.5 salinity or 2 mg/L from the median of the 13 surrounding readings (about 3 h).

Placeholder
: Whole-number runs are dropped; the server has published day counts in a salinity column.

Water quality gets no flat-line test. Turbidity: values repeated for 2 h or more are dropped; a day whose lowest
tenth exceeds 5 NTU is flagged as likely fouling.

## Hourly means

Each hourly value averages the QC-passed readings in `[hour, hour + 1)` UTC and carries the hour's start as its label.
Missing hours stay missing.

## Browser calculations

The jobs publish hourly series only. The browser computes 36-hour means, 7-day change, year comparisons, seasonal
percentiles and surface-minus-bottom differences. Plots and the "Ask your AI" prompt share one implementation.

Coverage
: A 36-hour mean needs 24 hours present. A year appears in a year comparison only with 80% window coverage.

Percentiles
: A value ranks against the same dates, plus or minus one week, in each earlier year with half that fortnight
  covered. At least three earlier years are required.

Thresholds
: Fixed in code; stated on the page.

## Record sources

The daily build reads each dataset's full record. Saved dataset copies supply hours a source has stopped publishing
([Design principles](../principles.md)).
