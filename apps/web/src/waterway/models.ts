/** What a waterway page supplies to the engine's cells, readouts and figures: its view and colours, and what is still
 * its own at a station (its wave sensors). Set once, before the first table; read `M` live. Each
 * model moves into the engine in a later stage, and this shrinks with it. */
import type { WaveObs } from "../series";
import type { VarKey } from "./station-data";

export interface PageModels {
  view(): VarKey;
  palette(): { now: string; delayed: string; line: string; contrast: string; miss: string; depth: Record<string, string> };
  waveSensor(id: string): { sensor: boolean } | null;
  wavePanel(id: string): string | undefined;
  wavesText(id: string, short?: boolean): string;
  lastWave(id: string): WaveObs | null;
  wavesPublished(id: string): boolean;
}

export let M: PageModels;
export function configureModels(models: PageModels): void {
  M = models;
}
