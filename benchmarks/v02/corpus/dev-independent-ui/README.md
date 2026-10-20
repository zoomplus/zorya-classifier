# Independent controlled Geany UI oracle supplement

This dev-only supplement has seven positive and three explicit absence cases from one locally rendered Geany 2.0 screen. Geany is GPL-2-or-later; the source ledger records package and copyright-file hashes, plus rendered GTK, icon-theme, font, and window-manager components. The PNG is retained only in the ignored local corpus cache and is not tracked or included in a distributable package.

The image was rendered in an owned Xvfb display with a private profile and task-authored unsaved text. A harness-only GTK CSS provider paints a visible 2px magenta outline around toolbar controls. AT-SPI supplies each control's semantic name and allocation; captured pixels verify all four allocation edges. Boxes cover the whole painted button allocation, including the displayed icon, not the glyph. The seven controls are New, Open, Save, Revert, Close, Back, and Forward.

The three negative cases ask for visible toolbar buttons named Print, Undo, and Cut. The complete AT-SPI tree for the exact screenshot contains the full visible toolbar inventory; none of these names is present there. Absence claims are scoped to visible toolbar buttons, not menu commands elsewhere in Geany.

This is a controlled-real-application supplement, not natural user capture. It has one application source group and does not qualify as broad UI coverage. Earlier model-assisted files remain unchanged.
