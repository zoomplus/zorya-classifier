package zorya.mapprobe;

import java.awt.Rectangle;
import java.awt.Point;
import java.awt.image.BufferedImage;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** Fixture checks for the conservative persistent-HUD capture policy. */
public final class FreeColCaptureUiGateFixture {
    private static final String INFO_PANEL = "net.sf.freecol.client.gui.panel.InfoPanel";
    private static final String MODAL_PANEL = "net.sf.freecol.client.gui.panel.InformationPanel";

    private FreeColCaptureUiGateFixture() {}

    public static void main(String[] arguments) throws Exception {
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
        String signature = "a".repeat(64);
        if (!FreeColProbe.validAgentArgumentCount(10) || FreeColProbe.validAgentArgumentCount(9)
                || FreeColProbe.validAgentArguments(new String[]{"out", "1", "wrong", "a", "b", "c", "d", "e", "f"})
                || !FreeColProbe.validAgentArguments(new String[]{"out", "1", "CLEAR-OCEAN-CAPTURE", "s", "p", "unit:1", "-", signature, "unit:1"})
                || !FreeColProbe.validAgentArguments(new String[]{"out", "1", "CLEAR-OCEAN-EVIDENCE", "unit:1", signature})) {
            throw new AssertionError("named clear-ocean protocol must be explicit and exact");
        }
        if (FreeColProbe.shouldCollectAboveTileEvidence(false, "unit:1", "unit:1")
                || FreeColProbe.shouldCollectAboveTileEvidence(true, "unit:1", "unit:2")
                || !FreeColProbe.shouldCollectAboveTileEvidence(true, "unit:1", "unit:1")) {
            throw new AssertionError("named overlay proof must be opt-in and limited to its selected unit");
        }
        if (FreeColProbe.cursorMayBeVisible(false, false)
                || !FreeColProbe.cursorMayBeVisible(false, true)
                || !FreeColProbe.cursorMayBeVisible(true, false)
                || !FreeColProbe.cursorMayBeVisible(true, true)) {
            throw new AssertionError("a running cursor blink timer must include both active and inactive phases");
        }
        verifyNativeOverlayContract();
        verifyCanonicalSignatureFocus();
        verifyMovementSnapshotAfterConfirmation();
        verifyLauncherEvidenceDispatch(arguments, signature);
        BufferedImage source = new BufferedImage(55, 58, BufferedImage.TYPE_INT_ARGB);
        source.setRGB(2, 2, 0x01010203);
        source.setRGB(51, 54, 0x01010203);
        source.setRGB(3, 4, 0xff112233);
        source.setRGB(45, 53, 0xff445566);
        if (!new Rectangle(2, 2, 50, 53).equals(FreeColProbe.alphaBounds(source))) {
            throw new AssertionError("nonzero-alpha extent must include translucent edge pixels");
        }
        if (!new Rectangle(3, 4, 43, 50).equals(FreeColProbe.opaqueBounds(source))) {
            throw new AssertionError("opaque extent must remain separate from the alpha extent");
        }
        BufferedImage exactOpaqueScreenshot = new BufferedImage(1024, 768, BufferedImage.TYPE_INT_ARGB);
        Point screenshotOrigin = new Point(100, 80);
        for (int y = 0; y < source.getHeight(); y++) {
            for (int x = 0; x < source.getWidth(); x++) {
                int pixel = source.getRGB(x, y);
                if ((pixel >>> 24) == 255) exactOpaqueScreenshot.setRGB(screenshotOrigin.x + x, screenshotOrigin.y + y, pixel);
            }
        }
        FreeColProbe.CapturePixelEvidence edgeEvidence = FreeColProbe.compareOpaqueSpritePixels(
                exactOpaqueScreenshot, source, screenshotOrigin, null, null);
        if (edgeEvidence.opaquePixels() != 2 || edgeEvidence.matchedPixels() != 2 || edgeEvidence.mismatchedPixels() != 0
                || edgeEvidence.matchedOpaqueExtentEqualsSourceAlphaBounds()
                || !edgeEvidence.matchedOpaqueExtentEqualsSourceOpaqueBounds()
                || !edgeEvidence.unoccludedPositiveAdmission()) {
            throw new AssertionError("semi-transparent edges must keep the legacy alpha extent false while opaque extent and admission pass");
        }
        BufferedImage edge = new BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB);
        edge.setRGB(1, 1, 0x01000000);
        if (FreeColProbe.alphaIntersectionPixels(source, new Point(10, 10), edge, new Point(11, 11)) != 1
                || FreeColProbe.alphaIntersectionPixels(source, new Point(10, 10), edge, new Point(100, 100)) != 0) {
            throw new AssertionError("alpha footprint intersection must count translucent pixels exactly");
        }
        System.out.println("capture-ui-gate-fixtures: 13 passed; native-overlay-contract-fixtures: 20 passed; canonical-focus-signature-fixtures: 2 passed; movement-snapshot-order-fixtures: 2 passed");
    }

    private static void verifyCanonicalSignatureFocus() throws Exception {
        Point origin = new Point(0, 31);
        java.awt.Dimension viewport = new java.awt.Dimension(1024, 737);
        String cameraAtStart = FreeColProbe.stateSignatureAtFocus(40, 100, List.of("tile-row"), List.of("unit-row"),
                origin, viewport, 1.0f, 38, 36, 4, "{\"ui\":\"stable\"}");
        String cameraAtActiveUnit = FreeColProbe.stateSignatureAtFocus(40, 100, List.of("tile-row"), List.of("unit-row"),
                origin, viewport, 1.0f, 35, 36, 4, "{\"ui\":\"stable\"}");
        String repeatedCanonical = FreeColProbe.stateSignatureAtFocus(40, 100, List.of("tile-row"), List.of("unit-row"),
                origin, viewport, 1.0f, 35, 36, 4, "{\"ui\":\"stable\"}");
        if (cameraAtStart.equals(cameraAtActiveUnit) || !cameraAtActiveUnit.equals(repeatedCanonical)) {
            throw new AssertionError("canonical state producer must preserve exact camera focus and be deterministic");
        }
    }

    private static void verifyMovementSnapshotAfterConfirmation() throws Exception {
        AtomicInteger captures = new AtomicInteger();
        try {
            FreeColProbe.snapshotAfterConfirmedMovement(3, 2, 31, 59, () -> {
                captures.incrementAndGet();
                return new FreeColProbe.ConfirmedMovementSnapshot("stale", "a".repeat(64), null, 30, 59);
            });
            throw new AssertionError("movement snapshot must wait for the final confirmation");
        } catch (IllegalStateException expected) {
            if (captures.get() != 0) throw new AssertionError("pre-confirmation snapshot supplier must not run");
        }
        FreeColProbe.ConfirmedMovementSnapshot refreshed = FreeColProbe.snapshotAfterConfirmedMovement(
                3, 3, 31, 59, () -> {
                    captures.incrementAndGet();
                    return new FreeColProbe.ConfirmedMovementSnapshot("fresh", "b".repeat(64), "c".repeat(64), 31, 59);
                });
        if (captures.get() != 1 || !"fresh".equals(refreshed.liveStateJson())
                || !"b".repeat(64).equals(refreshed.stateSignatureSha256())
                || !"c".repeat(64).equals(refreshed.canonicalReloadStateSignatureSha256())
                || refreshed.unitX() != 31 || refreshed.unitY() != 59) {
            throw new AssertionError("post-confirmation snapshot must carry fresh final tile and signatures");
        }
    }

    private static void verifyLauncherEvidenceDispatch(String[] arguments, String fallbackSignature) {
        if (arguments.length != 3) throw new AssertionError("expected exact Python-built evidence, movement, and capture arguments");
        String[] argv = arguments[0].split(",", -1);
        FreeColProbe.AgentOptions parsed = FreeColProbe.parseAgentArguments(argv);
        if (parsed == null || parsed.mode() != FreeColProbe.AgentMode.CLEAR_OCEAN_EVIDENCE
                || !"unit:5880".equals(parsed.clearOceanUnitId())
                || !fallbackSignature.equals(parsed.expectedStateSignature())
                || parsed.timeoutMillis() != 180_000L) {
            throw new AssertionError("production parser must retain launcher mode, selected target, state signature, and timeout");
        }
        FreeColProbe.AgentOptions movement = FreeColProbe.parseAgentArguments(arguments[1].split(",", -1));
        if (movement == null || movement.mode() != FreeColProbe.AgentMode.MOVE_WEST
                || !"unit:5859".equals(movement.targetUnitId()) || !"unit:5859".equals(movement.clearOceanUnitId())
                || !fallbackSignature.equals(movement.expectedStateSignature())
                || movement.moveStartX() != 30 || movement.moveStartY() != 13
                || movement.moveFinalX() != 27 || movement.moveFinalY() != 13
                || !"/tmp/official-state.fsg".equals(movement.officialSavePath())) {
            throw new AssertionError("production parser must retain full native movement contract from launcher argv");
        }
        FreeColProbe.AgentOptions capture = FreeColProbe.parseAgentArguments(arguments[2].split(",", -1));
        if (capture == null || capture.mode() != FreeColProbe.AgentMode.CLEAR_OCEAN_CAPTURE
                || !"unit:5859".equals(capture.targetUnitId()) || !"unit:5859".equals(capture.clearOceanUnitId())
                || !fallbackSignature.equals(capture.expectedStateSignature())
                || !"/tmp/official-state.fsg".equals(capture.officialSavePath())) {
            throw new AssertionError("production parser must retain full clear-ocean capture contract from launcher argv");
        }
        FreeColProbe.AgentOptions legacy = FreeColProbe.parseAgentArguments(new String[]{"/tmp/map.json", "180000"});
        if (legacy == null || legacy.mode() != FreeColProbe.AgentMode.MAP || legacy.clearOceanUnitId() != null) {
            throw new AssertionError("legacy map arguments must remain in their unchanged default mode");
        }
        Thread observer = FreeColProbe.startObserverForFixture(parsed);
        boolean observerStarted = observer != null && observer.getState() != Thread.State.NEW;
        if (observer == null || !"freecol-state-preflight".equals(observer.getName()) || !observer.isDaemon()
                || FreeColProbe.lastStartedAgentOptions == null
                || FreeColProbe.lastStartedAgentOptions.mode() != FreeColProbe.AgentMode.CLEAR_OCEAN_EVIDENCE
                || !"unit:5880".equals(FreeColProbe.lastStartedAgentOptions.clearOceanUnitId()) || !observerStarted) {
            throw new AssertionError("valid metadata launcher args must start the production observer with parsed clear-ocean mode");
        }
        try {
            observer.join(2_000L);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError("fixture interrupted while waiting for its bounded test observer", error);
        }
        if (observer.isAlive()) throw new AssertionError("fixture test observer did not close at its 1000ms test deadline");
        System.out.println("launcher-dispatch-fixture: evidence=" + parsed.mode() + ", movement=" + movement.mode()
                + ", capture=" + capture.mode() + ", legacy=" + legacy.mode() + ", observerStarted=" + observerStarted);
    }

    private static void verifyNativeOverlayContract() {
        try {
            Class<?> client = Class.forName("net.sf.freecol.client.FreeColClient");
            Class<?> holder = Class.forName("net.sf.freecol.client.control.FreeColClientHolder");
            Class<?> viewer = Class.forName("net.sf.freecol.client.gui.mapviewer.MapViewer");
            Class<?> state = Class.forName("net.sf.freecol.client.gui.mapviewer.MapViewerState");
            Class<?> cursor = Class.forName("net.sf.freecol.client.gui.mapviewer.TerrainCursor");
            Class<?> bounds = Class.forName("net.sf.freecol.client.gui.mapviewer.MapViewerBounds");
            Class<?> tile = Class.forName("net.sf.freecol.common.model.Tile");
            Class<?> settlement = Class.forName("net.sf.freecol.common.model.Settlement");
            Class<?> player = Class.forName("net.sf.freecol.common.model.Player");
            Class<?> options = Class.forName("net.sf.freecol.client.ClientOptions");
            Class<?> imageLibrary = Class.forName("net.sf.freecol.client.gui.ImageLibrary");
            Class<?> tileBounds = Class.forName("net.sf.freecol.client.gui.mapviewer.TileBounds");
            Class<?> pathNode = Class.forName("net.sf.freecol.common.model.PathNode");
            Class<?> graphics = java.awt.Graphics2D.class;
            Class<?> rescale = java.awt.image.RescaleOp.class;
            requireAccess(client, "getClientOptions", new Class<?>[0], Modifier.PUBLIC);
            requireAccess(holder, "getClientOptions", new Class<?>[0], Modifier.PROTECTED);
            requireAccess(viewer, "displaySettlementLabels",
                    new Class<?>[]{graphics, settlement, player, int.class, rescale}, Modifier.PRIVATE);
            requireAccess(viewer, "shouldFogOfWarBeDisplayed", new Class<?>[]{player, options}, Modifier.PRIVATE);
            requireAccess(viewer, "displayPath", new Class<?>[]{graphics, pathNode}, Modifier.PRIVATE);
            requireAccess(viewer, "getVisibleCursorTile", new Class<?>[0], Modifier.PRIVATE);
            requireAccess(bounds, "tileToPoint", new Class<?>[]{tile}, 0);
            requireAccess(bounds, "calculateTilePosition", new Class<?>[]{tile, boolean.class}, Modifier.PUBLIC);
            requireAccess(viewer, "getTileBounds", new Class<?>[0], Modifier.PUBLIC);
            requireAccess(tileBounds, "getWidth", new Class<?>[0], 0);
            requireAccess(tileBounds, "getHeight", new Class<?>[0], 0);
            requireAccess(state, "getUnitPath", new Class<?>[0], 0);
            requireAccess(state, "getGotoPath", new Class<?>[0], Modifier.PUBLIC);
            requireAccess(state, "getCursor", new Class<?>[0], 0);
            requireAccess(state, "isRangedAttackMode", new Class<?>[0], Modifier.PUBLIC);
            requireAccess(state, "getViewMode", new Class<?>[0], Modifier.PUBLIC);
            requireAccess(cursor, "isActive", new Class<?>[0], 0);
            Field blinkTimer = cursor.getDeclaredField("blinkTimer");
            if (blinkTimer.getType() != javax.swing.Timer.class || !Modifier.isPrivate(blinkTimer.getModifiers())) {
                throw new AssertionError("TerrainCursor.blinkTimer must be the private Swing timer inspected by the proof");
            }
            requireAccess(javax.swing.Timer.class, "isRunning", new Class<?>[0], Modifier.PUBLIC);
            requireAccess(imageLibrary, "getScaledImage", new Class<?>[]{String.class}, Modifier.PUBLIC);
            requireAccess(imageLibrary, "getScaledAboveTileImage", new Class<?>[]{tile}, Modifier.PUBLIC);
        } catch (ReflectiveOperationException error) {
            throw new AssertionError("installed FreeCol 1.1.0 native overlay API contract mismatch", error);
        }
    }

    private static void requireAccess(Class<?> owner, String name, Class<?>[] parameters, int expectedModifier)
            throws ReflectiveOperationException {
        Method method = owner.getDeclaredMethod(name, parameters);
        int modifiers = method.getModifiers();
        int visibility = modifiers & (Modifier.PUBLIC | Modifier.PROTECTED | Modifier.PRIVATE);
        if (visibility != expectedModifier) {
            throw new AssertionError(owner.getName() + "." + name + " has visibility " + Modifier.toString(visibility)
                    + ", expected " + Modifier.toString(expectedModifier));
        }
    }

    private static void expect(boolean expected, List<FreeColProbe.UiPanelFact> panels, int otherWindows,
                               boolean inventoryComplete, Rectangle target, String description) {
        boolean actual = FreeColProbe.captureUiPanelsAllowed(panels, otherWindows, inventoryComplete, target);
        if (actual != expected) throw new AssertionError(description + ": expected " + expected + ", got " + actual);
    }
}
