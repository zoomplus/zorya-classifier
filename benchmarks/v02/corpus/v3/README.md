# Controlled real-application and game-map oracle sources

These scripts document the independent source-geometry methods for a private heldout extension. Raw screenshots, world saves, masks, case positions, case mappings, manifests, and truth remain in an ignored run directory. The tracked source contains only generic capture/oracle code and does not define new examples or expected labels.

## Mousepad toolbar

Mousepad 0.6.1 is run in a private Xvfb display, Openbox session, isolated HOME/XDG directories, and a private D-Bus session. A preload-only GTK CSS provider applies a known opaque green fill and a square magenta border to actual toolbar buttons. AT-SPI supplies the accessible action identity, toolbar membership, and widget allocation. The pixel oracle accepts a button only when all four painted border edges and interior fill are visible within that allocation; it uses the painted pixel bounds as the whole visible button body. It does not use classifier geometry or the glyph bounds. Targets and negative scopes are limited to the visible toolbar.

The controlled CSS changes the app's normal theme. This is a controlled real-application stratum, not a natural user screenshot. All cases belong to one Mousepad application family. Screenshots are private because they contain redistributable application artwork under upstream licensing.

## Minetest minimap

Minetest 5.6.1 with Minetest Game renders its actual circular 2D minimap. Each capture uses a private Xvfb/Openbox session and a separate world/profile. The input is a fixed 150×150 crop aligned to the actual minimap in the client window. A private transparent player-marker texture override removes the player's own marker as a confound; time and clouds are frozen and player motion is held. The target is an actual `oracle:map_marker` sprite using the upstream `object_marker_red.png` asset and the engine's normal `show_on_minimap` draw path.

A positive is captured as hidden A, entity present, hidden B in one application session. The source oracle derives observed target presence by enumerating objects within a documented 500-node radius and reading their actual entity names and `show_on_minimap` properties; the assigned object reference is not used as presence evidence. It requires exact hidden-crop pixel equality and verifies the shown-vs-hidden pixel delta against the full 6×6 draw rectangle and nearest-sampled alpha support of the hash-pinned upstream `object_marker_red.png` sprite. This follows Minetest 5.6.1's `draw2DImage` call and the `2 * int(.025 * viewportWidth)` destination sizing rule; the viewport is 150 pixels wide in these captures. The enumeration is a bounded engine-object observation, not an introspection of the renderer's private inventory. A negative requires zero observed target/minimap objects in that scope plus identical hidden crops. The inputs cover only the minimap, not the 3D game scene. This is a controlled single-game/single-renderer family and does not claim diversity across games or natural user captures.

The local Minetest executable/game data and screenshots are not included in the package. Minetest code and Minetest Game assets retain their respective upstream licenses; attribution and license evidence are stored with the private source ledger. The player-marker override and authored controlled world are documented in that ledger.
