/** What a waterway page supplies to the engine's cells, readouts and figures: its view and colours, and its models at a
 * station (the forecast, the wave model, the tide predictions). Set once, before the first table; read `M` live. Each
 * model moves into the engine in a later stage, and this shrinks with it. */
import type { Hourly, WaveObs } from "../series";
import type { FcStats, FcValue, StationData, VarKey } from "./station-data";

export interface PageModels {
  view(): VarKey;
  palette(): { now: string; delayed: string; line: string };
  forecastAt(id: string, t: number): FcValue | null; // the newest forecast run covering the hour
  typicalError(id: string, lead: number, key: keyof FcStats): number;
  standIn(d: StationData, t: number): FcValue | null; // the forecast under a buoy's fault (buoys only)
  loadWaves(): void; // the wave model, loaded on first need
  wavesAt(id: string, t: number): { hs: number; tp: number; dir: number; lead: number; issue: number } | null;
  waveSensor(id: string): { sensor: boolean } | null;
  wavePanel(id: string): string | undefined;
  wavesText(id: string, short?: boolean): string;
  lastWave(id: string): WaveObs | null;
  wavesPublished(id: string): boolean;
  tidePred(id: string): { t0: string; step: number; ft: (number | null)[] } | undefined;
  departure(d: StationData): Hourly | null; // observed minus predicted water level, hourly
  predictedHour(id: string, t: number): number;
  verTag(t: number, id?: string): string; // the forecast's verification, linked
  floodMinor(id: string): number | null; // NWS minor flood level at a shore station, ft above MLLW
}

export let M: PageModels;
export function configureModels(models: PageModels): void {
  M = models;
}
