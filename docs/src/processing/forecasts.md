# Forecasts and model values

Model output appears uncorrected and labeled with its model. It is never blended with measurements or other models.

## Station values

HRRR: nearest water cells (3 km). GFS: four nearest 0.25 degree water cells, inverse-distance-squared weights. NWPS:
nearest water cell. NECOFS: the triangle or node containing the point. Land cells are excluded.

## Stitched forecast

HRRR runs hourly. Hourly runs reach 18 h ahead; 00, 06, 12 and 18 UTC runs reach 48 h. Each hour comes from the
newest run reaching it, so hours past 18 h come from a 48-hour run up to 6 h older than the newest. GFS extends the
forecast to 7 days in its own color. A step where the models meet is a model difference, not a weather change.

## Typical error

The forecast band is the model's mean absolute error against the four buoys, by lead time, since January 2024. About
6 in 10 forecast hours fall within it. [Forecast verification](https://longhorizon.blue/long-island-sound/forecast/)
gives scores by lead time and wind speed.

## Past hours

A past hour's model value is the HRRR run issued 1 h earlier, or 2 to 3 h earlier when that run is missing. Past-hour
values are short-lead forecasts, not observations.

## Buoy outages

During a sensor outage, HRRR weather and NWPS waves at the buoy fill the hour, labeled as a model; the outage notice
stays ([Design principles](../principles.md)).

## Revisions

The wind plot's Revisions switch shows run-to-run changes in one hour's forecast, plus the measured wind once that
hour has passed.
