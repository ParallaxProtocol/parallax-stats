// The world outline behind the node map, projected once and cached into
// the static shell. Viewers project node coordinates with the same
// parameters.

import { cacheLife } from "next/cache";
import { geoEqualEarth, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { MultiPolygon, Position } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import landTopology from "world-atlas/land-110m.json";

export interface WorldMap {
  path: string;
  width: number;
  height: number;
  scale: number;
  translate: [number, number];
}

/** Polygons wholly south of this latitude (Antarctica) are left off the map. */
const SOUTH_CUTOFF = -58;

export async function getWorld(): Promise<WorldMap> {
  "use cache";
  cacheLife("max");

  const width = 960;
  const height = 440;
  const topology = landTopology as unknown as Topology<{ land: GeometryCollection }>;
  const land = feature(topology, topology.objects.land);
  const geometry = land.features[0].geometry as MultiPolygon;

  geometry.coordinates = geometry.coordinates.filter((polygon: Position[][]) =>
    polygon[0].some(([, lat]) => lat > SOUTH_CUTOFF),
  );

  const projection = geoEqualEarth().fitExtent(
    [
      [4, 4],
      [width - 4, height - 4],
    ],
    land,
  );

  return {
    path: geoPath(projection.precision(0.5))(land) ?? "",
    width,
    height,
    scale: projection.scale(),
    translate: projection.translate(),
  };
}
