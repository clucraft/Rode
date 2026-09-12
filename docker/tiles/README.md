# Offline chart tiles

The optional `tiles` compose profile runs [TileServer-GL](https://github.com/maptiler/tileserver-gl)
against the `rode-tiles` named volume. Rode's web app draws the anchor,
swing circle, track, zones and AIS targets over whatever basemap it serves.
Without tiles the app uses the schematic polar view, which is the primary
display anyway; the chart is an addition, not a requirement.

## 1. Get an `.mbtiles` file

Any MBTiles file works. Options, roughly in order of usefulness at anchor:

- **Vector basemap for your cruising area** — download a region extract from
  [OpenMapTiles](https://openmaptiles.org/downloads/) or build one with
  [Planetiler](https://github.com/onthegomap/planetiler). Coastlines,
  harbours and place names; no depths.
- **Raster nautical charts** — where your hydrographic office publishes free
  raster charts (NOAA RNC for the US, for example), convert them to MBTiles
  with `gdal_translate -of MBTILES` + `gdaladdo`. Depths and hazards, at the
  cost of larger files.
- **Satellite/aerial imagery** you are licensed to use offline, converted the
  same way.

Keep the zoom range sensible: anchoring happens at zoom 14–18. A few hundred
square miles of coast at those zooms is typically 200 MB–2 GB.

## 2. Put it in the volume

```
docker compose --profile tiles up -d tiles
docker cp my-area.mbtiles rode-tiles:/data/
docker compose --profile tiles restart tiles
```

TileServer-GL picks up every `.mbtiles` in `/data` and serves:

- `http://<host>:8081/styles/<name>/style.json` — a ready MapLibre style for
  vector data (it generates a basic one automatically)
- `http://<host>:8081/data/<name>.json` — TileJSON, which is what you point
  Rode at for raster data

## 3. Point Rode at it

In `.env`:

```
RODE_TILES_URL=http://192.168.1.50:8081/data/my-area.json
```

Use an address the _phone_ can reach (the boat's LAN IP or the tailnet
name), not `tiles:8081`, because the browser fetches the tiles directly.
Restart `rode`. A "Chart" button appears on the Watch screen; if the style
cannot be loaded the button is disabled with the reason and the polar view
carries on.
