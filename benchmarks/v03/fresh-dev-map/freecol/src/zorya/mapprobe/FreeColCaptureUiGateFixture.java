package zorya.mapprobe;

import java.awt.Rectangle;
import java.util.List;

/** Fixture checks for the conservative persistent-HUD capture policy. */
public final class FreeColCaptureUiGateFixture {
    private static final String INFO_PANEL = "net.sf.freecol.client.gui.panel.InfoPanel";
    private static final String MODAL_PANEL = "net.sf.freecol.client.gui.panel.InformationPanel";

    private FreeColCaptureUiGateFixture() {}

    public static void main(String[] arguments) {
        Rectangle hud = new Rectangle(900, 40, 120, 650);
        Rectangle target = new Rectangle(460, 335, 85, 88);
        expect(true, List.of(new FreeColProbe.UiPanelFact(INFO_PANEL, hud, true, true)), 0, true, target,
                "nonoverlapping persistent map HUD is allowed");
        expect(false, List.of(new FreeColProbe.UiPanelFact(INFO_PANEL, target, true, true)), 0, true, target,
                "target overlapping persistent map HUD is vetoed");
        expect(false, List.of(new FreeColProbe.UiPanelFact(MODAL_PANEL, hud, true, true)), 0, true, target,
                "unknown transient dialog is vetoed");
        expect(false, List.of(new FreeColProbe.UiPanelFact(INFO_PANEL, hud, true, true)), 1, true, target,
                "external showing window is vetoed");
        expect(false, List.of(new FreeColProbe.UiPanelFact(INFO_PANEL, hud, true, true)), 0, false, target,
                "incomplete component inventory is vetoed");
        expect(false, List.of(new FreeColProbe.UiPanelFact(INFO_PANEL, null, true, false)), 0, true, target,
                "unknown HUD bounds are vetoed");
        expect(false, List.of(new FreeColProbe.UiPanelFact(INFO_PANEL, hud, true, true),
                new FreeColProbe.UiPanelFact(INFO_PANEL, hud, true, true)), 0, true, target,
                "ambiguous duplicate persistent HUD is vetoed");
        System.out.println("capture-ui-gate-fixtures: 7 passed");
    }

    private static void expect(boolean expected, List<FreeColProbe.UiPanelFact> panels, int otherWindows,
                               boolean inventoryComplete, Rectangle target, String description) {
        boolean actual = FreeColProbe.captureUiPanelsAllowed(panels, otherWindows, inventoryComplete, target);
        if (actual != expected) throw new AssertionError(description + ": expected " + expected + ", got " + actual);
    }
}
