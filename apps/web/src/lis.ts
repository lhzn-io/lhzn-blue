/** The Long Island Sound page (/long-island-sound/): the engine's waterway page (waterway/page.ts), mounted with the
 * Sound's config, its data adapter and its own parts. */
import "./site.css";
import "./away-links";

import promptTemplate from "../../../configs/prompts/visitor_prompt.txt?raw";
import * as adapter from "./adapters/sound";
import { LONG_ISLAND_SOUND } from "./waterways/long-island-sound";
import { gaugeAboutHtml, setUsgsWq, stationAboutHtml, usgsWqHtml } from "./waterways/sound-page";
import { configureSchematic, syncSchematic } from "./waterways/sound-schematic";
import { mountWaterwayPage } from "./waterway/page";

mountWaterwayPage(LONG_ISLAND_SOUND, {
  adapter,
  promptTemplate,
  stationAbout: stationAboutHtml,
  gaugeAbout: gaugeAboutHtml,
  shoreTable: usgsWqHtml,
  shoreData: (u) => setUsgsWq(u as adapter.UsgsTidal | null),
  diagram: { configure: configureSchematic, sync: syncSchematic },
});
