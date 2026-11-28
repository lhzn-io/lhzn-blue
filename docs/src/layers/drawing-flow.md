# Drawing flow and waves

The currents layer draws streamlines with streamlets; the waves layer draws crests. Both replace a grid of arrows.
Evenly spaced lines with head-heavy marks show flow direction better than gridded arrows, and the best spacing is a
fixed screen distance ({ref}`Ware, Kelley and Pilar, 2014 <ref-ware2014improving>`;
{ref}`Laidlaw et al., 2005 <ref-laidlaw2005comparing>`). The map key's "lines | arrows" switch restores the arrows.

## Streamlines (currents)

- Lines follow the NECOFS triangles, or grid cells split into triangle pairs. Node values average the adjacent
  cells; values inside a triangle interpolate linearly. A line stops at the model's water edge.
- Lines are placed by the {ref}`Jobard and Lefer (1997) <ref-jobard1997evenly>` method, 44 px apart, or as close as
  22 px where model cells are smaller on screen. Denser lines indicate a finer mesh.
- Streamlets sit at even travel-time intervals, so they bunch where flow is slow. Animated, they move at flow speed
  times one common factor: 1 m/s crosses the view in 20 s.
- Lines show the flow at the selected hour, not a water parcel's path over the tide.

## Crests (waves)

- Crest lines run across the travel direction, with a short tick on the downwave side. They follow the NWPS cells
  and skip land cells.
- Crest spacing does not represent wavelength; a 4 s wave is about 25 m long. Animated crests move at one fixed
  rate, not wave speed.
- The key's "height | period" switch shades cells by significant height or peak period (0 to 14 s). "wind" adds HRRR
  10 m wind as light streamlines.

## Measurements in gold

Gold marks measurements. Each LISICOS wave buoy appears as a gold ring, filled with its latest significant height or
dominant period on the map's scale, and empty for future hours. The buoys report no direction, so rings carry no
crest. HF radar currents are gold; model currents run sage, teal, navy.

## Color scales

Current speed uses cmocean tempo ({ref}`Thyng et al., 2016 <ref-thyng2016cmocean>`) on a logarithmic axis; faster
water is darker, and the dark theme reverses the ramp. Scales are fixed: a color means one value every day.
