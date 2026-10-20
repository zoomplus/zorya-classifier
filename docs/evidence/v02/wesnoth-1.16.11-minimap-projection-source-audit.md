# Wesnoth 1.16.11 minimap projection source audit

This is a source-only geometry audit. It does not qualify any captured screenshot, inspect cohort pixels or truth, or establish that a capture used the expected map/layout.

## Pinned sources

All source links refer to the upstream `1.16.11` tag, not current master.

| Source                                                                                                                 | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`src/minimap.cpp`](https://raw.githubusercontent.com/wesnoth/wesnoth/1.16.11/src/minimap.cpp)                         | `e889375b80b7f886b403954e3ee02ee48c16240fb8d24bbecdb5a9224ed6c030` |
| [`src/display.cpp`](https://raw.githubusercontent.com/wesnoth/wesnoth/1.16.11/src/display.cpp)                         | `20203f564470d3f8ddf01bd560472257f9785f1ad178422c38f60a77e0b465b0` |
| [`src/sdl/utils.cpp`](https://raw.githubusercontent.com/wesnoth/wesnoth/1.16.11/src/sdl/utils.cpp)                     | `ee66d5a2b3d1b8aa6205aba69e5215963a7c8c77d801a1c0401b6f6afbe4e249` |
| [`src/map/map.hpp`](https://raw.githubusercontent.com/wesnoth/wesnoth/1.16.11/src/map/map.hpp)                         | `33e13a400bdbd8e4c9b16d3ece31226c4f0c20a2c6512db153b86021d9e376bc` |
| [`src/map/map.cpp`](https://raw.githubusercontent.com/wesnoth/wesnoth/1.16.11/src/map/map.cpp)                         | `91627ad840ec9c7a0d09e5d90b8dbaf5141d568f47347fccd26be6f2786a684a` |
| [`src/terrain/translation.cpp`](https://raw.githubusercontent.com/wesnoth/wesnoth/1.16.11/src/terrain/translation.cpp) | `535930dd53ee6e897796e355dc37e3faf23968db18087eaacdcbb1dabcb1c91f` |

The curator capture scripts audited read-only were `capture_wesnoth.py` (`8762609d2eb22e4f70086135824dcc48e0adbb65c32b89f14609f2e0a3b10178`) and `capture_wesnoth_layer.py` (`df2c25850d9b4bf835d4ef7cfe0416c84718dbdb9d37cb865bad659700c9c84c`).

## Projection before compositing

`read_game_map` stores serialized `map_data[row][column]` at the same tile-array coordinates; `gamemap::read` supplies border offset `(1,1)`. The playable game coordinate for raw map cell `(c,r)` is therefore `(x,y)=(c-1,r-1)`. A playable raw cell has `1 <= c < Wraw-1` and `1 <= r < Hraw-1`.

`getMinimap` uses `s=24` if terrain drawing and terrain coding are both enabled, and `s=4` otherwise. The unscaled bitmap is `Cw=map.w()*3s/4`, `Ch=map.h()*s`; the map border is excluded from these dimensions. For game coordinate `(x,y)`, the loop computes:

```text
left = x * 3s/4 - s/4
top  = y * s + (s/4) * (odd(x) ? 1 : -1) - s/4
```

Thus odd columns have `top=y*s`, even columns `top=y*s-s/2`. The village draw fills the half-open rectangle `[left,left+3s/4) × [top,top+s)` with an opaque RGB color after drawing that cell's terrain. The fill is clipped to the unscaled minimap bitmap. These coordinates describe the cell's requested fill, not necessarily the final support after later drawing operations.

## Compositing caveat and correction

The loop is row-major (`y` outer, `x` inner), and terrain is drawn before the village fill for each cell. An initial review incorrectly concluded that this guarantees the full target fill survives: it assumed a target cell would be drawn again in the next row. That is false—the next-row cell at the same `x` is a different game cell and its hex is vertically shifted.

For example, with `s=24`, target `(x=1,y=1)` requests fill `[12,30) × [24,48)`. Later cell `(x=0,y=2)` draws terrain into `[-6,18) × [36,60)`, overlapping `[12,18) × [36,48)` after the target's village fill. Terrain tiles come from `image::HEXED` and are alpha-composited; without the specific terrain image's alpha values, source code alone cannot say whether those overlap pixels preserve or overwrite the village signal. Therefore the fill rectangle is only a geometric upper bound on final changed support in terrain-coded mode. Do not claim its full rectangle as the final mask or exact bounding box from formulas alone.

In non-terrain-coded mode, terrain uses fill rectangles with the same `3s/4 × s` footprint, so the above 24×24 alpha-tile overlap does not apply. The source-level statement still does not validate screenshot layout or capture correctness.

## Resampling and placement

The minimap bitmap is fitted into requested area `(areaW,areaH)` with `q=min(areaW/Cw, areaH/Ch)`, then dimensions are truncated: `Fw=int(Cw*q)`, `Fh=int(Ch*q)`. `scale_surface_sharp` samples source pixels using accumulated float ratios `xratio=Cw/Fw`, `yratio=Ch/Fh`, with source indices `floor(xsrc),floor(ysrc)` and each coordinate advanced by its ratio per output pixel. The destination is therefore nearest-neighbor-like; its exact mask depends on the unscaled composite bitmap, not merely continuous box scaling.

`display::draw_minimap` centers the resulting bitmap at `ox=area.x+(area.w-Fw)/2`, `oy=area.y+(area.h-Fh)/2`, and clips drawing to `area`. Add that origin to bitmap coordinates; pixels outside the clipping rectangle are not part of the minimap. This assumes the capture pixels are at the same rendered resolution and do not undergo external display scaling.

## Qualification limits

The source establishes formulas and a compositing risk, not observed screenshot geometry. An A/B/A capture can establish whether a controlled change produced a repeatable pixel difference, but exact final support needs the relevant terrain tile alpha and actual capture/layout evidence. No application was launched and no new pixels or truth were inspected for this audit.
