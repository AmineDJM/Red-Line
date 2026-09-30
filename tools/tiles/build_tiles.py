#!/usr/bin/env python3
"""
Red Line — imagerie satellite sombre en PMTiles.

Source : NASA Blue Marble Next Generation, « topography and bathymetry », juillet 2004
(domaine public, voir README.md). Traitement : masque terre/mer Natural Earth, désaturation et
assombrissement vers des gris bleu nuit (le relief ombré de la source reste lisible), mers
presque noires ; reprojection Web Mercator ; tuiles WebP 256 px ; archive PMTiles v3.

Exemples :
  python build_tiles.py --maxzoom 5 --out ../../data/tiles/satellite-lowzoom.pmtiles
  python build_tiles.py --maxzoom 8 --out ../../data/tiles/satellite.pmtiles
  python build_tiles.py --preview ../../data/tiles/satellite-lowzoom.pmtiles 4 7 4 10 6 apercu.png
"""
from __future__ import annotations

import argparse
import io
import json
import math
import multiprocessing as mp
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from pmtiles.tile import Compression, TileType, zxy_to_tileid, tileid_to_zxy
from pmtiles.writer import Writer

Image.MAX_IMAGE_PIXELS = None

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
# Juillet 2004 : couvert neigeux minimal dans l'hémisphère nord (décembre = 73909 / 200412).
NASA = "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73751"
BM = "world.topo.bathy.200407.3x{}"
NE_GEOJSON = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
# terres + plates-formes glaciaires antarctiques (rendues comme de la terre)
MASK_LAYERS = ["ne_10m_land", "ne_10m_antarctic_ice_shelves_polys"]
GRADE_VERSION = 7  # à incrémenter quand la fonction de couleur change (invalide le cache)
TILE = 256
WEBP_QUALITY = 80
MAX_LAT = 85.05112878

# Dalles 21600×21600 (90° × 90°) : colonne A..D de -180° à 180°, ligne 1 (nord) / 2 (sud).
QUADS = [(c, r) for r in (1, 2) for c in "ABCD"]


# ----------------------------------------------------------------------------------------------
# Téléchargements
# ----------------------------------------------------------------------------------------------


def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    CACHE.mkdir(parents=True, exist_ok=True)
    print(f"  téléchargement {url}", flush=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    subprocess.run(["curl", "-sSfL", "--retry", "3", "-o", str(tmp), url], check=True)
    tmp.rename(dest)
    return dest


def land_polygons() -> list[list[list[tuple[float, float]]]]:
    """Polygones terrestres Natural Earth 1:10 m (anneaux extérieurs et trous)."""
    polys = []
    for layer in MASK_LAYERS:
        map_cache = HERE.parent / "map" / ".cache" / f"{layer}.geojson"
        path = map_cache if map_cache.exists() else fetch(f"{NE_GEOJSON}/{layer}.geojson", CACHE / f"{layer}.geojson")
        data = json.loads(path.read_text())
        for f in data["features"]:
            g = f["geometry"]
            parts = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
            for p in parts:
                polys.append([[(x, y) for x, y in ring] for ring in p])
    return polys


# ----------------------------------------------------------------------------------------------
# Étalonnage des couleurs
# ----------------------------------------------------------------------------------------------

LAND_TINT = np.array([0.78, 0.86, 1.00], dtype=np.float32)
RELIEF_RADIUS = 3.0
RELIEF_GAIN = 0.9
RELIEF_MARGIN = 12
SEA_BASE = np.array([0.018, 0.030, 0.062], dtype=np.float32)
SEA_GAIN = np.array([0.030, 0.052, 0.105], dtype=np.float32)


def grade(rgb: np.ndarray, land: np.ndarray, lat: np.ndarray, margin: int = 0) -> np.ndarray:
    """
    rgb uint8 (h + 2·margin, w, 3), land float32 (h, w) dans [0, 1] → uint8 (h, w, 3).
    Les `margin` lignes au-dessus et au-dessous ne servent qu'au filtre de relief.
    `lat` (h,) : latitude de chaque ligne (réservé aux réglages par latitude).
    """
    c = rgb.astype(np.float32) / 255.0
    lum_full = c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722
    # relief : passe-haut de la luminance (l'ombrage de la source), renforcé après compression
    blur = Image.fromarray(np.clip(lum_full * 255, 0, 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(RELIEF_RADIUS)
    )
    detail_full = lum_full - np.asarray(blur, dtype=np.float32) / 255.0
    sl = slice(margin, c.shape[0] - margin) if margin else slice(None)
    c, lum, detail = c[sl], lum_full[sl], detail_full[sl]
    smooth = np.asarray(blur, dtype=np.float32)[sl] / 255.0
    # Terre : désaturée (15 % de la couleur d'origine), tons compressés (log), teinte gris-bleu.
    gray = lum[..., None]
    desat = np.clip(gray + 0.15 * (c - gray), 0.0, 1.0)
    t = 0.085 + 0.30 * np.log1p(8.0 * desat) / math.log(9.0)
    t = t + RELIEF_GAIN * detail[..., None]
    land_rgb = np.clip(t, 0.0, 1.0) * LAND_TINT
    # Mer : presque noire, bleu très sombre, bathymétrie à peine perceptible.
    sea_rgb = SEA_BASE + np.power(smooth, 1.3)[..., None] * SEA_GAIN
    a = land[..., None]
    out = land_rgb * a + sea_rgb * (1.0 - a)
    return np.clip(out * 255.0 + 0.5, 0, 255).astype(np.uint8)


def land_mask(polys, lon0: float, lat0: float, deg_per_px: float, w: int, h: int) -> np.ndarray:
    """Masque terre (float32, [0, 1], bords adoucis) pour une fenêtre équirectangulaire."""
    ss = 1  # le flou gaussien suffit à adoucir les côtes
    img = Image.new("L", (w * ss, h * ss), 0)
    d = ImageDraw.Draw(img)
    lon1 = lon0 + w * deg_per_px
    lat1 = lat0 - h * deg_per_px
    for poly in polys:
        outer = poly[0]
        xs = [p[0] for p in outer]
        ys = [p[1] for p in outer]
        if max(xs) < lon0 or min(xs) > lon1 or max(ys) < lat1 or min(ys) > lat0:
            continue
        for i, ring in enumerate(poly):
            pts = [((x - lon0) / deg_per_px * ss, (lat0 - y) / deg_per_px * ss) for x, y in ring]
            if len(pts) >= 3:
                d.polygon(pts, fill=255 if i == 0 else 0)
    img = img.filter(ImageFilter.GaussianBlur(0.8 * ss))
    if ss > 1:
        img = img.resize((w, h), Image.BILINEAR)
    return np.asarray(img, dtype=np.float32) / 255.0


# ----------------------------------------------------------------------------------------------
# Niveaux équirectangulaires (pyramide)
# ----------------------------------------------------------------------------------------------


def graded_base(maxzoom: int) -> np.ndarray:
    """Image étalonnée pleine résolution (86 400 px pour le zoom 8, 21 600 px sinon)."""
    if maxzoom <= 6:
        width = 21600
        cache = CACHE / f"graded-{width}-v{GRADE_VERSION}.u8"
        shape = (width // 2, width, 3)
        if cache.exists() and cache.stat().st_size == int(np.prod(shape)):
            return np.memmap(cache, dtype=np.uint8, mode="r", shape=shape)
        src = fetch(f"{NASA}/{BM.format('21600x10800')}.jpg", CACHE / f"{BM.format('21600x10800')}.jpg")
        polys = land_polygons()
        print("  étalonnage 21600×10800", flush=True)
        img = Image.open(src).convert("RGB")
        out = np.memmap(cache.with_suffix(".tmp"), dtype=np.uint8, mode="w+", shape=shape)
        step = 1080
        dpp = 360.0 / width
        for y in range(0, shape[0], step):
            h = min(step, shape[0] - y)
            mg = RELIEF_MARGIN
            strip = np.asarray(img.crop((0, y - mg, width, y + h + mg)))  # hors image = noir
            m = land_mask(polys, -180.0, 90.0 - y * dpp, dpp, width, h)
            lat = 90.0 - (y + np.arange(h) + 0.5) * dpp
            out[y : y + h] = grade(strip, m, lat, mg)
        out.flush()
        del out
        cache.with_suffix(".tmp").rename(cache)
        return np.memmap(cache, dtype=np.uint8, mode="r", shape=shape)

    width = 86400
    shape = (width // 2, width, 3)
    cache = CACHE / f"graded-{width}-v{GRADE_VERSION}.u8"
    if cache.exists() and cache.stat().st_size == int(np.prod(shape)):
        return np.memmap(cache, dtype=np.uint8, mode="r", shape=shape)
    polys = land_polygons()
    out = np.memmap(cache.with_suffix(".tmp"), dtype=np.uint8, mode="w+", shape=shape)
    dpp = 360.0 / width
    for col, row in QUADS:
        name = f"{BM.format('21600x21600')}.{col}{row}.jpg"
        src = fetch(f"{NASA}/{name}", CACHE / name)
        print(f"  étalonnage {name}", flush=True)
        img = Image.open(src).convert("RGB")
        x0 = "ABCD".index(col) * 21600
        y0 = (row - 1) * 21600
        step = 1350
        for y in range(0, 21600, step):
            mg = RELIEF_MARGIN
            strip = np.asarray(img.crop((0, y - mg, 21600, y + step + mg)))
            lon0 = -180.0 + x0 * dpp
            lat0 = 90.0 - (y0 + y) * dpp
            m = land_mask(polys, lon0, lat0, dpp, 21600, step)
            lat = lat0 - (np.arange(step) + 0.5) * dpp
            out[y0 + y : y0 + y + step, x0 : x0 + 21600] = grade(strip, m, lat, mg)
        del img
    out.flush()
    del out
    cache.with_suffix(".tmp").rename(cache)
    return np.memmap(cache, dtype=np.uint8, mode="r", shape=shape)


def halve(a: np.ndarray, cache: Path | None) -> np.ndarray:
    """Réduction 2×2 par moyenne, par bandes (compatible memmap)."""
    h, w = a.shape[0] // 2, a.shape[1] // 2
    if cache is not None:
        if cache.exists() and cache.stat().st_size == h * w * 3:
            return np.memmap(cache, dtype=np.uint8, mode="r", shape=(h, w, 3))
        out = np.memmap(cache.with_suffix(".tmp"), dtype=np.uint8, mode="w+", shape=(h, w, 3))
    else:
        out = np.empty((h, w, 3), dtype=np.uint8)
    step = 512
    for y in range(0, h, step):
        yy = min(step, h - y)
        blk = np.asarray(a[2 * y : 2 * (y + yy), : 2 * w]).astype(np.uint16)
        s = blk[0::2, 0::2] + blk[1::2, 0::2] + blk[0::2, 1::2] + blk[1::2, 1::2]
        out[y : y + yy] = ((s + 2) // 4).astype(np.uint8)
    if cache is not None:
        out.flush()
        del out
        cache.with_suffix(".tmp").rename(cache)
        return np.memmap(cache, dtype=np.uint8, mode="r", shape=(h, w, 3))
    return out


def pyramid(base: np.ndarray) -> list[np.ndarray]:
    levels = [base]
    while levels[-1].shape[1] > 400:
        a = levels[-1]
        big = a.shape[1] >= 40000
        cache = CACHE / f"graded-{a.shape[1] // 2}-v{GRADE_VERSION}-mip.u8" if big else None
        print(f"  niveau {a.shape[1] // 2} px", flush=True)
        levels.append(halve(a, cache))
    return levels


# ----------------------------------------------------------------------------------------------
# Tuiles Web Mercator
# ----------------------------------------------------------------------------------------------

LEVELS: list[np.ndarray] = []


def pick_level(z: int) -> np.ndarray:
    need = TILE * (1 << z)
    best = LEVELS[0]
    for lv in LEVELS:
        if lv.shape[1] >= need:
            best = lv
    return best


def render_tile(z: int, x: int, y: int) -> np.ndarray:
    src = pick_level(z)
    H, W = src.shape[0], src.shape[1]
    n = 1 << z
    px = (np.arange(TILE, dtype=np.float64) + 0.5) / TILE
    lon = (x + px) / n * 360.0 - 180.0
    my = math.pi * (1 - 2 * (y + px) / n)
    lat = np.degrees(np.arctan(np.sinh(my)))
    sx = (lon + 180.0) / 360.0 * W - 0.5
    sy = (90.0 - lat) / 180.0 * H - 0.5
    x0 = int(max(0, math.floor(sx.min())))
    x1 = int(min(W - 1, math.floor(sx.max()) + 1))
    y0 = int(max(0, math.floor(sy.min())))
    y1 = int(min(H - 1, math.floor(sy.max()) + 1))
    blk = np.asarray(src[y0 : y1 + 1, x0 : x1 + 1]).astype(np.float32)
    fx = np.clip(sx - x0, 0, blk.shape[1] - 1)
    fy = np.clip(sy - y0, 0, blk.shape[0] - 1)
    ix = np.minimum(np.floor(fx).astype(np.int64), blk.shape[1] - 2 if blk.shape[1] > 1 else 0)
    iy = np.minimum(np.floor(fy).astype(np.int64), blk.shape[0] - 2 if blk.shape[0] > 1 else 0)
    ax = np.clip(fx - ix, 0, 1)[None, :, None]
    ay = np.clip(fy - iy, 0, 1)[:, None, None]
    ix1 = np.minimum(ix + 1, blk.shape[1] - 1)
    iy1 = np.minimum(iy + 1, blk.shape[0] - 1)
    r0 = blk[iy][:, ix] * (1 - ax) + blk[iy][:, ix1] * ax
    r1 = blk[iy1][:, ix] * (1 - ax) + blk[iy1][:, ix1] * ax
    out = r0 * (1 - ay) + r1 * ay
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def encode(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr, "RGB").save(buf, "WEBP", quality=WEBP_QUALITY, method=4)
    return buf.getvalue()


def work(tileids: list[int]) -> list[tuple[int, bytes]]:
    res = []
    for t in tileids:
        z, x, y = tileid_to_zxy(t)
        res.append((t, encode(render_tile(z, x, y))))
    return res


def build(maxzoom: int, out_path: Path, procs: int) -> None:
    global LEVELS
    t0 = time.time()
    base = graded_base(maxzoom)
    LEVELS = pyramid(base)
    print(f"  pyramide prête ({time.time() - t0:.0f} s)", flush=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".pmtiles.tmp")
    total = sum(4**z for z in range(maxzoom + 1))
    chunk = 64
    chunks = [
        list(range(s, min(s + chunk, total))) for s in range(0, total, chunk)
    ]  # identifiants de tuiles 0..total-1 = zooms 0..maxzoom dans l'ordre de Hilbert
    done = 0
    with open(tmp, "wb") as f:
        w = Writer(f)
        ctx = mp.get_context("fork")
        with ctx.Pool(procs) as pool:
            for res in pool.imap(work, chunks):
                for t, data in res:
                    w.write_tile(t, data)
                done += len(res)
                if done % 8192 < chunk:
                    print(f"  {done}/{total} tuiles ({time.time() - t0:.0f} s)", flush=True)
        w.finalize(
            {
                "tile_type": TileType.WEBP,
                "tile_compression": Compression.NONE,
                "min_zoom": 0,
                "max_zoom": maxzoom,
                "min_lon_e7": -1800000000,
                "min_lat_e7": -850511287,
                "max_lon_e7": 1800000000,
                "max_lat_e7": 850511287,
                "center_zoom": 2,
                "center_lon_e7": 150000000,
                "center_lat_e7": 300000000,
            },
            {
                "name": "Red Line — imagerie sombre",
                "description": "NASA Blue Marble Next Generation (topographie et bathymétrie, juillet 2004), "
                "assombrie et désaturée pour Red Line.",
                "attribution": "Imagerie : NASA Earth Observatory (Blue Marble NG, domaine public) ; "
                "côtes : Natural Earth",
                "version": str(GRADE_VERSION),
                "type": "baselayer",
                "format": "webp",
                "tileSize": TILE,
            },
        )
    tmp.rename(out_path)
    size = out_path.stat().st_size
    print(
        f"OK {out_path} : {total} tuiles, zoom 0–{maxzoom}, {size / 1e6:.1f} Mo, {time.time() - t0:.0f} s",
        flush=True,
    )


# ----------------------------------------------------------------------------------------------
# Aperçu (relit l'archive PMTiles)
# ----------------------------------------------------------------------------------------------


def preview(pm: Path, z: int, xa: int, ya: int, xb: int, yb: int, out: Path) -> None:
    from pmtiles.reader import MmapSource, Reader

    with open(pm, "rb") as f:
        r = Reader(MmapSource(f))
        img = Image.new("RGB", ((xb - xa + 1) * TILE, (yb - ya + 1) * TILE))
        for x in range(xa, xb + 1):
            for y in range(ya, yb + 1):
                data = r.get(z, x, y)
                if data:
                    img.paste(Image.open(io.BytesIO(data)).convert("RGB"), ((x - xa) * TILE, (y - ya) * TILE))
        img.save(out)
    print(f"aperçu {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--maxzoom", type=int, default=5)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--procs", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--preview", nargs=7, metavar=("PMTILES", "Z", "X0", "Y0", "X1", "Y1", "PNG"))
    a = ap.parse_args()
    if a.preview:
        p = a.preview
        preview(Path(p[0]), int(p[1]), int(p[2]), int(p[3]), int(p[4]), int(p[5]), Path(p[6]))
        return
    if not a.out:
        ap.error("--out requis")
    build(a.maxzoom, a.out, a.procs)


if __name__ == "__main__":
    sys.exit(main())
