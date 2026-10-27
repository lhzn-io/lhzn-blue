/** Where a waterway's data files are (and its forecast page), and the one redraw that follows models arriving: data
 * landing together (station histories, the forecasts, the advisories) costs one redraw, a moment after the last
 * arrival, not one each. */

export let DATA = "/data/v1";
export let FORECAST_PAGE = "";
export function configureData(o: { data: string; forecastPage: string }): void {
  DATA = o.data;
  FORECAST_PAGE = o.forecastPage;
}

let redraw: () => void = () => undefined;
let pending = 0;
/** What the page redraws when a model's data arrives. */
export function onModelData(fn: () => void): void {
  redraw = fn;
}
export function requestRedraw(): void {
  window.clearTimeout(pending);
  pending = window.setTimeout(() => redraw(), 60);
}
