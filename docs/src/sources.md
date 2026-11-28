# Where the data come from

Each series names its source beside its values, on the page and in the data files. Data are used with credit under
each source's terms. The site has no public data API; the sources publish the observations directly.

## Observations

Moored buoys
: [LISICOS](https://lisicos.uconn.edu/), University of Connecticut Department of Marine Sciences: water temperature,
  salinity, dissolved oxygen and turbidity by depth; weather; waves. Read from the
  [LISICOS ERDDAP server](https://merlin.dms.uconn.edu/erddap/), or transcribed from LISICOS station panels during
  server outages ([Design principles](principles.md)).

Shore and tidal stations
: [NOAA CO-OPS](https://tidesandcurrents.noaa.gov/) stations at Kings Point, Bridgeport, New Haven and New London:
  water temperature, water level, tide predictions, weather. [USGS](https://waterdata.usgs.gov/) tidal gauges.

Coastal airports
: NWS ASOS stations KBDR (Sikorsky) and KHVN (Tweed), via the
  [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/): wind, gusts, air temperature, pressure.

Rivers
: [USGS Water Data for the Nation](https://waterdata.usgs.gov/): flow, river turbidity.

Surface currents (HF radar)
: NOAA IOOS HF Radar National Network (HFRNet) hourly totals, served by NOAA NDBC. Western Sound coverage comes from
  LISICOS radar sites.

Current meter
: NOAA CO-OPS New London PORTS meter nl0101, Groton, Thames River.

## Satellite fields

- MUR sea surface temperature analysis, NASA JPL ({ref}`Chin et al., 2017 <ref-chin2017mur>`).
- VIIRS chlorophyll-a and Kd490 (S-NPP, NOAA-20, NOAA-21), via
  [NOAA NESDIS CoastWatch](https://coastwatch.noaa.gov/).

## Models

- **HRRR** (NOAA; 3 km, hourly): wind, gusts, air temperature, pressure
  ({ref}`Dowell et al., 2022 <ref-dowell2022hrrr>`).
- **GFS** (NOAA; 0.25 degree, 6-hourly): wind past HRRR's 48 hours.
- **NWPS** (NWS New York; SWAN, 1.8 km): waves ({ref}`Booij et al., 1999 <ref-booij1999swan>`).
- **NECOFS/UMASSD** (FVCOM, UMass Dartmouth School for Marine Science and Technology): currents, waves
  ({ref}`Chen et al., 2003 <ref-chen2003fvcom>`; {ref}`Chen et al., 2006 <ref-chen2006fvcom>`).
- **DOPPIO** (Rutgers ROMS, for MARACOOS): Northeast U.S. Shelf page.
- **NOAA CO-OPS tidal current predictions:** reference points along the Sound.

[forcingkit](https://github.com/lhzn-io/forcingkit) reads the models; [insitukit](https://github.com/lhzn-io/insitukit)
reads NOAA CO-OPS and ERDDAP.

## Advisories

NWS New York (OKX) marine advisories for the Sound's zones: Iowa Environmental Mesonet VTEC archive, 2005 onward.
Zone outlines: api.weather.gov.

## Regional view

[NERACOOS Mariners' Dashboard](https://mariners.neracoos.org/).

## Client identification

Job requests carry a User-Agent naming the site and a contact address.
