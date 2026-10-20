# Wesnoth 1.16.11 minimap projection source audit

This is a source-only geometry audit. It does not qualify any captured screenshot, inspect cohort pixels or truth, or establish that a capture used the expected map/layout.

## Pinned sources

All source links refer to the upstream `1.16.11` tag, not current master.

| Source                                                                                                                 | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`src/minimap.cpp`](https://raw.githubusercontent.com/wesnoth/wesnoth/1.16.11/src/minimap.cpp)                         | `e889375b80b7f886b403954e3ee02ee48c16240fb8d24bbecdb5a9224ed6c030` |
| [`src/display.cpp`](https://raw.githubusercontent.com/wesnoth/wesnoth/1.16.11/src/display.cpp)                         | `20203f564470d3f8ddf01bd560472257f9785f1ad178422c38f60a77e0b465b0` |
| [`src/sdl/utils.cpp`](https://raw.githubusercontent.com/wesnoth/wesnoth/1.16.11/src/sdl/utils.cpp)                     | `ee66d5a2b3d1b8aa6205aba69e5215963a7c8c77d801a1c0401b6f6afbe4e249` |
| [`src/sdl/rect.hpp`](https://raw.githubusercontent.com/wesnoth/wesnoth/1.16.11/src/sdl/rect.hpp)                       | `c4e1bc99a269a7242ffe4d272d87c41f995a209263f078f7342b512d79f1c6a8` |
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

The minimap bitmap is fitted into requested area `(areaW,areaH)` with `q=min(areaW/Cw, areaH/Ch)`, then dimensions are truncated: `Fw=int(Cw*q)`, `Fh=int(Ch*q)`. `scale_surface_sharp` stores `xratio=Cw/Fw` and `yratio=Ch/Fh` as C++ `float`, initializes `xsrc` and `ysrc` to `0.0f`, and advances each accumulator by its ratio after each destination pixel. The index read is `static_cast<int>(xsrc)` / `static_cast<int>(ysrc)` (truncation, equal to floor for these nonnegative positions). It is not equivalent at every edge to calculating `int(destinationIndex * ratio)` independently with floating-point multiplication.

For the 4p map geometry used by the excluded proof, the unscaled bitmap is `648×864` and output bitmap is `159×212`. Both axes therefore use the same ratio, `648/159 = 864/212`, stored as float32 `4.075471878051758` (`0x40826a44`). Repeating the source expression `ysrc += yratio` yields `ysrc=215.99992370605469` at destination row `53`, so the sampled source index is `215`. Computing the row independently as a rounded float32 multiplication gives `float32(53*yratio)=216.00001525878906`, which truncates to `216`. The same recurrence/multiply difference occurs at destination row `106` (`431` versus `432`). This is the source-level reason a sample immediately before an exclusive source edge can survive at an output position where ideal-rational projection puts it outside.

The minimap forms village fill rectangles with integer `{left,top,width=scale*3/4,height=scale}` and calls `sdl::fill_surface_rect`. In `src/sdl/rect.hpp` that helper directly calls `SDL_FillRect`. Its integer rectangle extent is half-open: `[left,left+width) × [top,top+height)`. Thus if the source bottom is `216`, row `215` is filled and row `216` is excluded; the float32 accumulator case above samples the included row at destination `53`. A source-faithful recurrence produces the projected X/Y arrays for the `648×864` to `159×212` transform; the complete arrays are preserved in ignored audit metadata `wesnoth-scale-sampler-f32-v1.json` (SHA-256 `9835e6843e246396f2460df94af97a99a1ed2183ab9febf0aefe49f4258f6396`).

An independent, excluded-proof pixel review by root is recorded in [`wesnoth-proof-root-review-20261020-v1.json`](wesnoth-proof-root-review-20261020-v1.json). Its metadata reports that float32 repeated sampling covers all 1,297 changed pixels, while ideal-rational sampling leaves three bottom-edge pixels outside. This is independent empirical confirmation, not part of this source-only review: I did not inspect its image files or recompute its pixel masks. It also reports 66 projected pixels unchanged, consistent with the earlier painter-overdraw caveat; projected fill remains an upper bound rather than an exact foreground mask.

`display::draw_minimap` centers the resulting bitmap at `ox=area.x+(area.w-Fw)/2`, `oy=area.y+(area.h-Fh)/2`, and clips drawing to `area`. Add that origin to bitmap coordinates; pixels outside the clipping rectangle are not part of the minimap. This assumes the capture pixels are at the same rendered resolution and do not undergo external display scaling.

## Qualification limits

The source establishes formulas and a compositing risk, not observed screenshot geometry. An A/B/A capture can establish whether a controlled change produced a repeatable pixel difference, but exact final support needs the relevant terrain tile alpha and actual capture/layout evidence. No application was launched, no provider calls were made, and no cohort pixels or truth were inspected for this audit. The excluded proof reference above is separately produced and reviewed evidence; it does not change this scope statement.
