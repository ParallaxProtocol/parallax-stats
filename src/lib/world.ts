// The world map behind the node map: country outlines, projected once and
// cached into the static shell. Viewers project node coordinates with the
// same parameters.

import { cacheLife } from "next/cache";
import { geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import countriesTopology from "world-atlas/countries-110m.json";
import { geoMiller } from "./projection.ts";

export interface Country {
  /** ISO 3166-1 alpha-2, as nodes are located by; "" for a territory without one. */
  code: string;
  d: string;
}

export interface WorldMap {
  countries: Country[];
  width: number;
  height: number;
  scale: number;
  translate: [number, number];
}

/** Antarctica runs no nodes and would take a fifth of the map's height. */
const ANTARCTICA = "010";

/** Natural Earth's short names that are not the name Intl gives the same code. */
const NAMED: Record<string, string> = {
  "W. Sahara": "EH",
  "United States of America": "US",
  "Dem. Rep. Congo": "CD",
  "Dominican Rep.": "DO",
  "Falkland Is.": "FK",
  "Fr. S. Antarctic Lands": "TF",
  "Côte d'Ivoire": "CI",
  "Central African Rep.": "CF",
  Congo: "CG",
  "Eq. Guinea": "GQ",
  eSwatini: "SZ",
  Palestine: "PS",
  Myanmar: "MM",
  Turkey: "TR",
  "Solomon Is.": "SB",
  "Bosnia and Herz.": "BA",
  Macedonia: "MK",
  "Trinidad and Tobago": "TT",
  "S. Sudan": "SS",
};

/** codesByName maps each region's English name to its two-letter code. */
function codesByName(): Map<string, string> {
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const codes = new Map<string, string>();

  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);

      try {
        const name = names.of(code);
        // Retired and alias codes (UK, BU, DD) share a current code's name, and are not what nodes are located by
        const current = Intl.getCanonicalLocales(`und-${code}`)[0] === `und-${code}`;

        if (name && name !== code && current) codes.set(name, code);
      } catch {
        // Not a region code
      }
    }
  }

  return codes;
}

export async function getWorld(): Promise<WorldMap> {
  "use cache";
  cacheLife("max");

  const width = 960;
  const topology = countriesTopology as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
  const all = feature(topology, topology.objects.countries) as FeatureCollection<Feature["geometry"], { name: string }>;
  const countries: FeatureCollection<Feature["geometry"], { name: string }> = {
    type: "FeatureCollection",
    features: all.features.filter((f) => f.id !== ANTARCTICA),
  };

  // Fitted to the width, with the height the land takes: no empty bands above or below
  const projection = geoMiller().fitWidth(width - 8, countries);
  const [x, y] = projection.translate();

  // A margin all round, so outlines at the edges are not cut
  projection.translate([x + 4, y + 4]);
  const path = geoPath(projection.precision(0.5));
  const height = Math.ceil(path.bounds(countries)[1][1]) + 4;
  const byName = codesByName();

  return {
    // Territories without a code of their own (Northern Cyprus, Somaliland) stay unpainted
    countries: countries.features.map((f) => ({
      code: NAMED[f.properties.name] ?? byName.get(f.properties.name) ?? "",
      d: path(f) ?? "",
    })),
    width,
    height,
    scale: projection.scale(),
    translate: projection.translate(),
  };
}
