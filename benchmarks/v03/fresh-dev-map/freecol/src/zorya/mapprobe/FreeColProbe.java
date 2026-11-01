package zorya.mapprobe;

import java.awt.Point;
import java.awt.Rectangle;
import java.awt.Window;
import java.awt.Component;
import java.awt.Container;
import java.awt.Graphics2D;
import java.awt.Robot;
import java.awt.Toolkit;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.InvocationTargetException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.concurrent.atomic.AtomicReference;
import javax.swing.SwingUtilities;
import javax.swing.AbstractButton;
import javax.swing.JButton;
import javax.imageio.ImageIO;

/** Read-only, one-shot observer for an explicitly launched FreeCol diagnostic. */
public final class FreeColProbe {
    static record UiPanelFact(String className, Rectangle screenBounds, boolean showing, boolean boundsAvailable) {}
    private record UnitResourceEvidence(String json, boolean returnedPixelsMatchBaseImage) {}
    private record OverlayEvidence(String json, boolean geometryAvailable, boolean bboxUnchangedAfterKnownChip,
                                   boolean otherOverlayIntersectsSprite, Point chipOriginInTile, BufferedImage chipImage) {}
    private record VisibleSpriteBounds(Rectangle bounds, int fullyOccludedOpaquePixels) {}
    private record UiOverlapEvidence(String json, boolean intersectsTarget) {}
    private record CaptureUiEvidence(String json, boolean componentInventoryComplete, int externalShowingWindowCount,
                                     List<UiPanelFact> visibleFreeColPanels, int visibleComponentCount) {}

    private static final String FRAME = "net.sf.freecol.client.gui.FreeColFrame";
    private static final long POLL_MS = 500;
    private static final int MAX_MAP_CELLS = 50_000;
    private static final int MAX_MAP_UNIT_ROWS = 8_192;
    private static final int MAX_FRONT_SPRITE_ROWS = 4_096;
    private static final int MAX_UI_ROWS = 48;
    private static final int MAX_CAPTURE_UI_COMPONENTS = 2_048;
    private static final int MAX_START_ACTION_OBSERVATIONS = 16;
    private static final int MAX_NATION_SELECTION_DIAGNOSTIC_CHARS = 180;
    private static final Pattern SENSITIVE_DIAGNOSTIC = Pattern.compile("(?i)(token|password|secret|authorization)(\\s*[=:]\\s*)[^\\s,;]+");
    private static final Set<Object> START_PANELS_CLICKED = Collections.newSetFromMap(new IdentityHashMap<>());
    private static final Set<Object> INFORMATION_PANELS_DISMISSED = Collections.newSetFromMap(new IdentityHashMap<>());
    private static final List<String> START_ACTION_OBSERVATIONS = new ArrayList<>();
    private static final List<String> INFORMATION_PANEL_ACTION_OBSERVATIONS = new ArrayList<>();
    private static String lastUiState = "{\"visiblePanels\":[],\"visibleButtons\":[]}";
    private static String latestStateSignature;
    private static String captureScreenPath;
    private static String captureSpritePath;
    private static String captureTargetUnitId;
    private static String captureAbsentUnitTypeId;
    private static String expectedCaptureStateSignature;
    private static String officialSavePath;
    private static String requestedNationId;
    private static String requestedNationTypeId;
    private static boolean nationSelectionAttempted;
    private static boolean nationSelectionConfirmed;
    private static String nationSelectionStatus = "not-requested";
    private static String nationSelectionJson = "{\"status\":\"not-requested\"}";
    private static String nationSelectionLastObservedNationId;
    private static String nationSelectionLastObservedNationTypeId;
    private static String nationSelectionLastServerNationId;
    private static String nationSelectionLastServerNationTypeId;
    private static String nationSelectionFailureType;
    private static String nationSelectionFailureMessage;
    private static String nationSelectionLastObservationStatus;
    private static int nationSelectionObservationCount;
    private static Map<String, BufferedImage> latestTargetSprites = new LinkedHashMap<>();
    private static Map<String, Boolean> latestTargetResourceVerified = new LinkedHashMap<>();
    private static Set<String> latestValidUnitTypeIds = new HashSet<>();
    private static Map<String, Integer> latestMapUnitTypeCounts = new TreeMap<>();
    private static Map<String, Integer> latestViewportFrontUnitTypeCounts = new TreeMap<>();
    private static boolean latestMapUnitInventoryComplete;
    private static Map<String, Rectangle> latestTargetScreenBounds = new LinkedHashMap<>();
    private static Map<String, Point> latestTargetSpriteOrigins = new LinkedHashMap<>();
    private static Map<String, Point> latestTargetChipOrigins = new LinkedHashMap<>();
    private static Map<String, BufferedImage> latestTargetChips = new LinkedHashMap<>();
    private static Map<String, Boolean> latestTargetOverlaySafe = new LinkedHashMap<>();
    private static Map<String, Boolean> latestTargetBboxUnchanged = new LinkedHashMap<>();
    private static Rectangle latestScreenViewport;
    private static Rectangle latestFrameBounds;
    private static boolean latestVisibleFrontInventoryComplete;
    private static int latestVisibleFreeColPanelCount;
    private static String latestCaptureUiGateJson = "{\"status\":\"not-observed\"}";
    private static boolean latestCaptureUiGateSafe;
    private static Point latestFrameOrigin = new Point(0, 0);

    private FreeColProbe() {}

    public static void premain(String arguments, Instrumentation instrumentation) {
        String[] parts = arguments == null ? new String[0] : arguments.split(",", -1);
        if (!validAgentArgumentCount(parts.length)) return;
        Path output = Path.of(parts[0]);
        long timeoutMillis;
        try {
            timeoutMillis = Math.max(1_000L, Math.min(600_000L, Long.parseLong(parts[1])));
        } catch (NumberFormatException exception) {
            return;
        }
        if (parts.length == 3) {
            officialSavePath = dashToNull(parts[2]);
            if (officialSavePath == null) return;
        } else if (parts.length == 4 || parts.length == 5) {
            int selectionStart = nationSelectionStartIndex(parts);
            if (selectionStart < 0) return;
            requestedNationId = dashToNull(parts[selectionStart]);
            requestedNationTypeId = dashToNull(parts[selectionStart + 1]);
            if (parts.length == 5) {
                int saveIndex = selectionStart == 2 ? 4 : 2;
                officialSavePath = dashToNull(parts[saveIndex]);
                if (officialSavePath == null) return;
            }
        } else if (parts.length == 7 || parts.length == 8) {
            captureScreenPath = dashToNull(parts[2]);
            captureSpritePath = dashToNull(parts[3]);
            captureTargetUnitId = dashToNull(parts[4]);
            captureAbsentUnitTypeId = dashToNull(parts[5]);
            expectedCaptureStateSignature = dashToNull(parts[6]);
            if (captureScreenPath == null || expectedCaptureStateSignature == null
                    || ((captureTargetUnitId == null) == (captureAbsentUnitTypeId == null))) return;
            if ((captureTargetUnitId == null) != (captureSpritePath == null)) return;
            if (parts.length == 8) {
                officialSavePath = dashToNull(parts[7]);
                if (officialSavePath == null) return;
            }
        }
        Thread observer = new Thread(() -> observe(output, timeoutMillis), "freecol-state-preflight");
        observer.setDaemon(true);
        observer.start();
    }

    private static String dashToNull(String value) {
        return "-".equals(value) ? null : value;
    }

    private static boolean validNationIds(String nationId, String nationTypeId) {
        return nationId != null && nationTypeId != null
                && nationId.matches("model\\.nation\\.[A-Za-z0-9._-]{1,96}")
                && nationTypeId.matches("model\\.nationType\\.[A-Za-z0-9._-]{1,96}");
    }

    static int nationSelectionStartIndex(String[] arguments) {
        if (arguments.length == 4 && validNationIds(arguments[2], arguments[3])) return 2;
        if (arguments.length == 5 && validNationIds(arguments[3], arguments[4])) return 3;
        return -1;
    }

    static boolean validAgentArgumentCount(int argumentCount) {
        return argumentCount == 2 || argumentCount == 3 || argumentCount == 4 || argumentCount == 5
                || argumentCount == 7 || argumentCount == 8;
    }

    private static void observe(Path output, long timeoutMillis) {
        long deadline = System.nanoTime() + timeoutMillis * 1_000_000L;
        String lastStableSignature = null;
        int stableObservationCount = 0;
        while (System.nanoTime() < deadline) {
            try {
                AtomicReference<String> result = new AtomicReference<>();
                AtomicReference<Exception> failure = new AtomicReference<>();
                SwingUtilities.invokeAndWait(() -> {
                    try {
                        result.set(snapshot());
                    } catch (Exception exception) {
                        failure.set(exception);
                    }
                });
                if (failure.get() != null) throw failure.get();
                String json = result.get();
                if (json != null) {
                    if (latestStateSignature.equals(lastStableSignature)) stableObservationCount++;
                    else {
                        lastStableSignature = latestStateSignature;
                        stableObservationCount = 1;
                    }
                    if (stableObservationCount >= 3) {
                        if (captureScreenPath != null && !expectedCaptureStateSignature.equals(latestStateSignature)) {
                            writeAtomically(output, withCapture(json, "{\"status\":\"state-signature-mismatch\",\"observedStateSignatureSha256\":"
                                    + quote(latestStateSignature) + ",\"expectedStateSignatureSha256\":" + quote(expectedCaptureStateSignature) + "}") + "\n");
                            return;
                        }
                        if (officialSavePath != null) {
                            AtomicReference<String> saveReceipt = new AtomicReference<>();
                            AtomicReference<Exception> saveFailure = new AtomicReference<>();
                            SwingUtilities.invokeAndWait(() -> {
                                try {
                                    saveReceipt.set(saveOfficialGame(Path.of(officialSavePath)));
                                } catch (Exception exception) {
                                    saveFailure.set(exception);
                                }
                            });
                            if (saveFailure.get() != null) throw saveFailure.get();
                            json = withOfficialSave(json, saveReceipt.get());
                            officialSavePath = null;
                        }
                        if (captureScreenPath != null) {
                            AtomicReference<String> capture = new AtomicReference<>();
                            AtomicReference<Exception> captureFailure = new AtomicReference<>();
                            SwingUtilities.invokeAndWait(() -> {
                                try {
                                    capture.set(captureActualScreen());
                                } catch (Exception exception) {
                                    captureFailure.set(exception);
                                }
                            });
                            if (captureFailure.get() != null) throw captureFailure.get();
                            json = withCapture(json, capture.get());
                        }
                        writeAtomically(output, json + "\n");
                        return;
                    }
                }
                Thread.sleep(POLL_MS);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception exception) {
                try {
                    String message = exception.getMessage() == null ? "" : exception.getMessage();
                    if (message.length() > 400) message = message.substring(0, 400);
                    writeAtomically(output, "{\"schemaVersion\":1,\"status\":\"probe-error\",\"errorType\":" + quote(exception.getClass().getSimpleName()) + ",\"errorMessage\":" + quote(message) + ",\"errorStack\":[" + errorStackJson(exception) + "]}\n");
                } catch (IOException ignored) {
                    // The owner observes the absent receipt and bounded JVM log.
                }
                return;
            }
        }
        try {
            AtomicReference<String> timeoutReceipt = new AtomicReference<>();
            SwingUtilities.invokeAndWait(() -> timeoutReceipt.set(timeoutJson()));
            writeAtomically(output, timeoutReceipt.get() + "\n");
        } catch (Exception ignored) {
            // The owner observes the absent receipt and bounded JVM log.
        }
    }

    private static String withOfficialSave(String json, String saveReceipt) {
        return json.substring(0, json.length() - 1) + ",\"officialSave\":" + saveReceipt + "}";
    }

    private static String saveOfficialGame(Path target) throws Exception {
        Path normalized = target.toAbsolutePath().normalize();
        if (Files.exists(normalized) || normalized.getParent() == null || !Files.isDirectory(normalized.getParent())) {
            throw new IOException("official save target must be a new file in its existing owned run directory");
        }
        Window frame = null;
        for (Window window : Window.getWindows()) {
            if (window.isShowing() && window.getClass().getName().equals(FRAME)) {
                frame = window;
                break;
            }
        }
        if (frame == null) throw new IllegalStateException("FreeCol frame disappeared before official save");
        Object client = field(frame, "freeColClient");
        Object controller = invoke(client, "getInGameController");
        Method saveGame = controller.getClass().getDeclaredMethod("saveGame", File.class);
        saveGame.setAccessible(true);
        boolean saved = Boolean.TRUE.equals(saveGame.invoke(controller, normalized.toFile()));
        if (!saved || !Files.isRegularFile(normalized)) throw new IOException("FreeCol official save API did not produce a save file");
        long bytes = Files.size(normalized);
        if (bytes <= 0 || bytes > 100L * 1024L * 1024L) throw new IOException("FreeCol save file size is outside the bounded evidence limit");
        return "{\"status\":\"saved\",\"api\":\"InGameController.saveGame(File)\",\"path\":" + quote(normalized.toString())
                + ",\"bytes\":" + bytes + ",\"sha256\":" + quote(sha256(normalized)) + "}";
    }

    private static String snapshot() throws Exception {
        Window[] windows = Window.getWindows();
        Window frame = null;
        for (Window window : windows) {
            if (window.isShowing() && window.getClass().getName().equals(FRAME)) {
                frame = window;
                break;
            }
        }
        if (frame == null) return null;

        advanceStartPanel(frame);
        advanceInformationPanel(frame);
        lastUiState = uiStateJson(frame);
        latestFrameOrigin = frame.getLocationOnScreen();
        latestFrameBounds = new Rectangle(latestFrameOrigin.x, latestFrameOrigin.y, frame.getWidth(), frame.getHeight());

        Object client = field(frame, "freeColClient");
        Object game = invoke(client, "getGame");
        if (game == null) return null;
        Object map = invoke(game, "getMap");
        if (map == null) return null;

        Object gui = invoke(client, "getGUI");
        Object viewer = field(gui, "mapViewer");
        Object canvas = field(gui, "canvas");
        if (viewer == null || canvas == null) return null;
        CaptureUiEvidence captureUiEvidence = inspectCaptureUi(frame);
        latestCaptureUiGateJson = captureUiEvidence.json();
        latestCaptureUiGateSafe = captureUiPanelsAllowed(captureUiEvidence.visibleFreeColPanels(),
                captureUiEvidence.externalShowingWindowCount(), captureUiEvidence.componentInventoryComplete(), null);
        Object bounds = invoke(viewer, "getMapViewerBounds");
        Object state = invoke(viewer, "getMapViewerState");
        Object imageLibrary = invoke(gui, "getScaledImageLibrary");
        Object focus = invoke(bounds, "getFocus");
        if (focus == null) return null;
        Object viewportValue = invokeDeclared(bounds, "getSize");
        Object tileSizeValue = invoke(imageLibrary, "getTileSize");
        float scaleFactor = ((Number) invoke(imageLibrary, "getScaleFactor")).floatValue();
        Object viewportOrigin = canvas.getClass().getMethod("getLocationOnScreen").invoke(canvas);
        Point origin = (Point) viewportOrigin;
        java.awt.Dimension viewport = (java.awt.Dimension) viewportValue;
        int mapWidth = ((Number) invoke(map, "getWidth")).intValue();
        int mapHeight = ((Number) invoke(map, "getHeight")).intValue();

        List<String> rows = new ArrayList<>();
        latestTargetSprites.clear();
        latestTargetResourceVerified.clear();
        latestTargetScreenBounds.clear();
        latestTargetSpriteOrigins.clear();
        latestTargetChipOrigins.clear();
        latestTargetChips.clear();
        latestTargetOverlaySafe.clear();
        latestTargetBboxUnchanged.clear();
        Class<?> unitClass = Class.forName("net.sf.freecol.common.model.Unit");
        Class<?> tileClass = Class.forName("net.sf.freecol.common.model.Tile");
        Method getTile = map.getClass().getMethod("getTile", int.class, int.class);
        Method getTileUnitList = tileClass.getMethod("getUnitList");
        Method calculateTilePosition = bounds.getClass().getMethod("calculateTilePosition", tileClass, boolean.class);
        Method tileToPoint = findDeclaredMethod(bounds.getClass(), "tileToPoint", tileClass);
        Method spriteMethod = imageLibrary.getClass().getMethod("getScaledUnitImage", unitClass, boolean.class);
        Method positionMethod = findDeclaredMethod(viewer.getClass(), "calculateUnitImagePositionInTile", BufferedImage.class);
        Method findUnitInFront = state.getClass().getMethod("findUnitInFront", tileClass);
        Object myPlayer = invoke(client, "getMyPlayer");
        Method canSee = myPlayer == null ? null : myPlayer.getClass().getMethod("canSee", tileClass);
        Object animator = invoke(state, "getUnitAnimator");
        Method isOutForAnimation = animator.getClass().getMethod("isOutForAnimation", unitClass);
        positionMethod.setAccessible(true);
        tileToPoint.setAccessible(true);
        int mapCellCount = Math.multiplyExact(mapWidth, mapHeight);
        boolean mapCellInventoryTruncated = mapCellCount > MAX_MAP_CELLS;
        int cellsToInspect = Math.min(mapCellCount, MAX_MAP_CELLS);
        int scannedMapCells = 0;
        int strictVisibleTileCount = 0;
        int mapUnitCount = 0;
        int unknownTileTypeCount = 0;
        int visibleTileOccupantCount = 0;
        int frontUnitCount = 0;
        int animatedFrontUnitCount = 0;
        int spriteIntersectingViewportCount = 0;
        boolean mapUnitInventoryConsistent = true;
        boolean mapUnitRowsTruncated = false;
        Map<String, Integer> mapUnitTypeCounts = new TreeMap<>();
        Map<String, Integer> viewportFrontUnitTypeCounts = new TreeMap<>();
        Set<String> mapUnitIds = new HashSet<>();
        List<String> mapUnitRows = new ArrayList<>();
        TreeSet<String> mapTileLines = new TreeSet<>();
        TreeSet<String> mapUnitLines = new TreeSet<>();
        List<String> validGameUnitTypeIds = new ArrayList<>();
        Object specification = invoke(game, "getSpecification");
        for (Object type : (List<?>) invoke(specification, "getUnitTypeList")) {
            validGameUnitTypeIds.add(String.valueOf(invoke(type, "getId")));
        }
        Collections.sort(validGameUnitTypeIds);
        latestValidUnitTypeIds = new HashSet<>(validGameUnitTypeIds);
        Rectangle screenViewport = new Rectangle(origin.x, origin.y, viewport.width, viewport.height);
        latestScreenViewport = screenViewport;

        for (int y = 0; y < mapHeight && scannedMapCells < cellsToInspect; y++) {
            for (int x = 0; x < mapWidth && scannedMapCells < cellsToInspect; x++) {
                scannedMapCells++;
                Object tile = getTile.invoke(map, x, y);
                if (tile == null) {
                    mapTileLines.add(x + "," + y + "|<null>");
                    continue;
                }
                Object tileType = invoke(tile, "getType");
                Object tileOwner = invoke(tile, "getOwner");
                String tileOwnerId = tileOwner == null ? "" : String.valueOf(invoke(tileOwner, "getId"));
                String tileTypeId = tileType == null ? "<null-type>" : String.valueOf(invoke(tileType, "getId"));
                if (tileType == null) unknownTileTypeCount++;
                mapTileLines.add(x + "," + y + "|" + tileTypeId + "|" + tileOwnerId + "|" + invoke(tile, "isExplored"));
                List<?> tileUnits = (List<?>) getTileUnitList.invoke(tile);
                List<String> tileUnitLines = new ArrayList<>();
                for (Object mapUnit : tileUnits) {
                    String mapUnitId = String.valueOf(invoke(mapUnit, "getId"));
                    Object mapUnitType = invoke(mapUnit, "getType");
                    String mapUnitTypeId = String.valueOf(invoke(mapUnitType, "getId"));
                    Object mapUnitOwner = invoke(mapUnit, "getOwner");
                    String mapUnitOwnerId = mapUnitOwner == null ? "" : String.valueOf(invoke(mapUnitOwner, "getId"));
                    Object unitTile = invoke(mapUnit, "getTile");
                    if (unitTile != tile || !mapUnitIds.add(mapUnitId)) mapUnitInventoryConsistent = false;
                    mapUnitCount++;
                    mapUnitTypeCounts.merge(mapUnitTypeId, 1, Integer::sum);
                    tileUnitLines.add(mapUnitId + "|" + mapUnitTypeId + "|" + mapUnitOwnerId + "|" + x + "," + y);
                    if (mapUnitRows.size() < MAX_MAP_UNIT_ROWS) {
                        mapUnitRows.add("{\"id\":" + quote(mapUnitId) + ",\"typeId\":" + quote(mapUnitTypeId)
                                + ",\"ownerId\":" + (mapUnitOwner == null ? "null" : quote(mapUnitOwnerId))
                                + ",\"tile\":{\"x\":" + x + ",\"y\":" + y + "}}");
                    } else {
                        mapUnitRowsTruncated = true;
                    }
                }
                Collections.sort(tileUnitLines);
                mapUnitLines.addAll(tileUnitLines);
                Point strictVisibleTilePoint = (Point) calculateTilePosition.invoke(bounds, tile, false);
                if (strictVisibleTilePoint != null) {
                    strictVisibleTileCount++;
                    visibleTileOccupantCount += tileUnits.size();
                }
                Point tilePoint = (Point) tileToPoint.invoke(bounds, tile);
                Object unit = findUnitInFront.invoke(state, tile);
                if (unit == null) continue;
                if (!tileUnits.contains(unit)) throw new IllegalStateException("front unit is absent from its tile unit list");
                frontUnitCount++;
                boolean outForAnimation = (Boolean) isOutForAnimation.invoke(animator, unit);
                boolean playerCanSee = myPlayer != null && (Boolean) canSee.invoke(myPlayer, tile);
                boolean fade = "SENTRY".equals(String.valueOf(invoke(unit, "getState"))) || !playerCanSee;
                BufferedImage sprite = (BufferedImage) spriteMethod.invoke(imageLibrary, unit, fade);
                Point imageOffset = (Point) positionMethod.invoke(viewer, sprite);
                Rectangle alpha = alphaBounds(sprite);
                Rectangle screenSprite = alpha == null ? null : new Rectangle(
                        origin.x + tilePoint.x + imageOffset.x + alpha.x,
                        origin.y + tilePoint.y + imageOffset.y + alpha.y,
                        alpha.width, alpha.height);
                if (screenSprite == null || !screenViewport.intersects(screenSprite)) continue;
                spriteIntersectingViewportCount++;
                if (rows.size() >= MAX_FRONT_SPRITE_ROWS) continue;
                Object type = invoke(unit, "getType");
                String typeId = String.valueOf(invoke(type, "getId"));
                viewportFrontUnitTypeCounts.merge(typeId, 1, Integer::sum);
                if (outForAnimation) {
                    animatedFrontUnitCount++;
                    continue;
                }
                Object owner = invoke(unit, "getOwner");
                String ownerId = owner == null ? null : String.valueOf(invoke(owner, "getId"));
                UnitResourceEvidence resourceEvidence = unitResourceEvidence(imageLibrary, unit, type, owner, fade, sprite);
                String unitId = String.valueOf(invoke(unit, "getId"));
                OverlayEvidence overlayEvidence = unitOverlayEvidence(imageLibrary, canvas, unit, tile, sprite, imageOffset, viewport);
                UiOverlapEvidence uiOverlap = visibleUiComponentOverlap(frame, canvas, screenSprite);
                latestTargetSprites.put(unitId, sprite);
                latestTargetResourceVerified.put(unitId, resourceEvidence.returnedPixelsMatchBaseImage());
                latestTargetScreenBounds.put(unitId, screenSprite);
                latestTargetSpriteOrigins.put(unitId, new Point(origin.x + tilePoint.x + imageOffset.x,
                        origin.y + tilePoint.y + imageOffset.y));
                if (overlayEvidence.chipOriginInTile() != null && overlayEvidence.chipImage() != null) {
                    latestTargetChipOrigins.put(unitId, new Point(origin.x + tilePoint.x + overlayEvidence.chipOriginInTile().x,
                            origin.y + tilePoint.y + overlayEvidence.chipOriginInTile().y));
                    latestTargetChips.put(unitId, overlayEvidence.chipImage());
                }
                latestTargetOverlaySafe.put(unitId, overlayEvidence.geometryAvailable()
                        && overlayEvidence.bboxUnchangedAfterKnownChip()
                        && !overlayEvidence.otherOverlayIntersectsSprite() && !uiOverlap.intersectsTarget()
                        && captureUiPanelsAllowed(captureUiEvidence.visibleFreeColPanels(),
                        captureUiEvidence.externalShowingWindowCount(), captureUiEvidence.componentInventoryComplete(), screenSprite));
                latestTargetBboxUnchanged.put(unitId, overlayEvidence.bboxUnchangedAfterKnownChip());
                rows.add("{\"id\":" + quote(String.valueOf(invoke(unit, "getId")))
                        + ",\"typeId\":" + quote(String.valueOf(invoke(type, "getId")))
                        + ",\"ownerId\":" + (ownerId == null ? "null" : quote(ownerId))
                        + ",\"ownedByPlayer\":" + (owner == myPlayer)
                        + ",\"playerCanSeeTile\":" + playerCanSee
                        + ",\"tileExplored\":" + invoke(tile, "isExplored")
                        + ",\"unitState\":" + quote(String.valueOf(invoke(unit, "getState")))
                        + ",\"tile\":{\"x\":" + x + ",\"y\":" + y + "}"
                        + ",\"tileTopLeftScreen\":{\"x\":" + (origin.x + tilePoint.x) + ",\"y\":" + (origin.y + tilePoint.y) + "}"
                        + ",\"spriteDimensions\":{\"width\":" + sprite.getWidth() + ",\"height\":" + sprite.getHeight() + "}"
                        + ",\"spriteAlphaBounds\":" + rectangleJson(alpha)
                        + ",\"estimatedAlphaScreenBounds\":" + rectangleJson(screenSprite)
                        + ",\"spritePixelsSha256\":" + quote(pixelSha256(sprite))
                        + ",\"resource\":" + resourceEvidence.json()
                        + ",\"renderOverlayEvidence\":" + overlayEvidence.json()
                        + ",\"visibleUiComponentOverlap\":" + uiOverlap.intersectsTarget()
                        + ",\"visibleUiComponentOverlapDetails\":" + uiOverlap.json()
                        + ",\"engineFrontUnitIdAtTile\":" + quote(String.valueOf(invoke(unit, "getId"))) + "}");
            }
        }
        latestStateSignature = stateSignature(mapWidth, mapHeight, mapTileLines, mapUnitLines, origin, viewport, scaleFactor, focus, lastUiState);
        boolean mapUnitInventoryComplete = !mapCellInventoryTruncated && scannedMapCells == mapCellCount && mapUnitInventoryConsistent;
        latestMapUnitInventoryComplete = mapUnitInventoryComplete;
        latestMapUnitTypeCounts = new TreeMap<>(mapUnitTypeCounts);
        latestViewportFrontUnitTypeCounts = new TreeMap<>(viewportFrontUnitTypeCounts);
        String mapTileStateSha256 = sha256Lines(mapTileLines);
        String allMapUnitInventorySha256 = sha256Lines(mapUnitLines);
        boolean frontSpriteInventoryTruncated = spriteIntersectingViewportCount > rows.size();
        boolean visibleTileFrontInventoryComplete = !mapCellInventoryTruncated && !frontSpriteInventoryTruncated && animatedFrontUnitCount == 0;
        latestVisibleFrontInventoryComplete = visibleTileFrontInventoryComplete;
        String feasibility = spriteIntersectingViewportCount == 0 ? "no-front-sprite"
                : !visibleTileFrontInventoryComplete ? "inventory-incomplete" : "source-metadata-observed";

        String jarPath = Path.of("/usr/share/java/FreeCol-1.1.0.jar").toString();
        return "{\"schemaVersion\":2,\"status\":\"live-map-observed\",\"oracleScope\":\"source-metadata-only\",\"startActionObservations\":[" + String.join(",", START_ACTION_OBSERVATIONS)
                + "],\"nationSelection\":" + nationSelectionJson
                + ",\"informationPanelActionObservations\":[" + String.join(",", INFORMATION_PANEL_ACTION_OBSERVATIONS)
                + "],\"uiState\":" + lastUiState + ",\"sourceStateFeasibility\":" + quote(feasibility)
                + ",\"clientJar\":" + quote(jarPath) + ",\"clientJarSha256\":" + quote(sha256(Path.of(jarPath)))
                + ",\"frame\":{" + "\"x\":" + frame.getX() + ",\"y\":" + frame.getY() + ",\"width\":" + frame.getWidth() + ",\"height\":" + frame.getHeight() + "}"
                + ",\"canvasScreenOrigin\":{" + "\"x\":" + origin.x + ",\"y\":" + origin.y + "}"
                + ",\"viewport\":{" + "\"width\":" + viewport.width + ",\"height\":" + viewport.height + "}"
                + ",\"mapScaleFactor\":" + scaleFactor
                + ",\"tileSize\":{" + "\"width\":" + ((java.awt.Dimension) tileSizeValue).width + ",\"height\":" + ((java.awt.Dimension) tileSizeValue).height + "}"
                + ",\"map\":{" + "\"width\":" + mapWidth + ",\"height\":" + mapHeight + "}"
                + ",\"focusTile\":{" + "\"x\":" + invoke(focus, "getX") + ",\"y\":" + invoke(focus, "getY") + "}"
                + ",\"mapCellCount\":" + mapCellCount + ",\"scannedMapCells\":" + scannedMapCells
                + ",\"mapCellInventoryTruncated\":" + mapCellInventoryTruncated
                + ",\"unknownTileTypeCount\":" + unknownTileTypeCount
                + ",\"strictVisibleTileCount\":" + strictVisibleTileCount
                + ",\"visibleTileOccupantCount\":" + visibleTileOccupantCount
                + ",\"engineFrontUnitCount\":" + frontUnitCount
                + ",\"animatedFrontUnitCount\":" + animatedFrontUnitCount
                + ",\"spriteIntersectingViewportCount\":" + spriteIntersectingViewportCount
                + ",\"viewportFrontUnitTypeCounts\":" + integerMapJson(viewportFrontUnitTypeCounts)
                + ",\"frontSpriteInventoryTruncated\":" + frontSpriteInventoryTruncated
                + ",\"visibleTileFrontInventoryComplete\":" + visibleTileFrontInventoryComplete
                + ",\"mapUnitInventory\":{"
                + "\"complete\":" + mapUnitInventoryComplete
                + ",\"consistent\":" + mapUnitInventoryConsistent
                + ",\"rowListTruncated\":" + mapUnitRowsTruncated
                + ",\"unitCount\":" + mapUnitCount
                + ",\"unitTypeCounts\":" + integerMapJson(mapUnitTypeCounts)
                + ",\"inventorySha256\":" + quote(allMapUnitInventorySha256)
                + ",\"rows\":[" + String.join(",", mapUnitRows) + "]}"
                + ",\"validGameUnitTypeIds\":[" + quotedList(validGameUnitTypeIds) + "]"
                + ",\"mapTileStateSha256\":" + quote(mapTileStateSha256)
                + ",\"stateSignatureSha256\":" + quote(latestStateSignature)
                + ",\"captureUiGate\":" + latestCaptureUiGateJson
                + ",\"units\":[" + String.join(",", rows) + "]"
                + ",\"visibilityVerdict\":\"not-established\",\"completeVisibleNegativeInventory\":false"
                + ",\"screenshotCreated\":false,\"corpusCaseCreated\":false}";
    }

    private static void advanceStartPanel(Window frame) throws Exception {
        List<Component> components = new ArrayList<>();
        collectComponents(frame, components);
        List<Component> panels = components.stream()
                .filter(component -> component.getClass().getName().equals("net.sf.freecol.client.gui.panel.StartGamePanel"))
                .filter(Component::isShowing)
                .toList();
        if (panels.size() != 1 || START_ACTION_OBSERVATIONS.size() >= MAX_START_ACTION_OBSERVATIONS) return;
        Component panel = panels.get(0);
        if (nationSelectionShouldAttempt(requestedNationId != null, nationSelectionAttempted)) {
            attemptNationSelection(frame);
            return;
        }
        if (!nationSelectionAllowsStart(requestedNationId != null, nationSelectionAttempted,
                nationSelectionConfirmed)) {
            if (nationSelectionRequestFailed()) return;
            confirmNationSelection(frame);
            if (!nationSelectionAllowsStart(requestedNationId != null, nationSelectionAttempted,
                    nationSelectionConfirmed)) return;
        }
        if (requestedNationId != null && !START_ACTION_OBSERVATIONS.isEmpty()) return;
        if (START_PANELS_CLICKED.contains(panel)) return;
        Field startField = panel.getClass().getDeclaredField("start");
        startField.setAccessible(true);
        Object value = startField.get(panel);
        if (!(value instanceof JButton button)) return;
        if (!panel.isEnabled() || !button.isShowing() || !button.isEnabled()) return;

        AtomicReference<Boolean> actionObserved = new AtomicReference<>(false);
        ActionListener receiptListener = (ActionEvent event) -> actionObserved.set(true);
        button.addActionListener(receiptListener);
        try {
            button.doClick(0);
        } finally {
            button.removeActionListener(receiptListener);
        }
        START_PANELS_CLICKED.add(panel);
        START_ACTION_OBSERVATIONS.add("{\"panelClass\":" + quote(panel.getClass().getName())
                + ",\"panelIdentity\":" + System.identityHashCode(panel)
                + ",\"panelShowing\":true,\"panelEnabled\":true"
                + ",\"buttonClass\":" + quote(button.getClass().getName())
                + ",\"buttonIdentity\":" + System.identityHashCode(button)
                + ",\"buttonText\":" + quote(shortText(button.getText()))
                + ",\"actionCommand\":" + quote(shortText(button.getActionCommand()))
                + ",\"buttonShowing\":true,\"buttonEnabled\":true"
                + ",\"normalDoClickCalled\":true,\"actionEventObserved\":" + actionObserved.get() + "}");
    }

    static boolean nationSelectionShouldAttempt(boolean requested, boolean attempted) {
        return requested && !attempted;
    }

    static boolean nationSelectionAllowsStart(boolean requested, boolean attempted, boolean confirmed) {
        return !requested || (attempted && confirmed);
    }

    static boolean nationSelectionModelsMatch(String requestedNation, String requestedNationType,
                                              String clientNation, String clientNationType,
                                              String serverNation, String serverNationType) {
        return requestedNation != null && requestedNationType != null
                && requestedNation.equals(clientNation) && requestedNationType.equals(clientNationType)
                && requestedNation.equals(serverNation) && requestedNationType.equals(serverNationType);
    }

    private static boolean nationSelectionRequestFailed() {
        return "requested-id-not-found".equals(nationSelectionStatus)
                || "pre-game-controller-unavailable".equals(nationSelectionStatus)
                || "selection-request-failed".equals(nationSelectionStatus);
    }

    private static void attemptNationSelection(Window frame) {
        nationSelectionAttempted = true;
        try {
            Object client = field(frame, "freeColClient");
            Object game = invoke(client, "getGame");
            Object specification = invoke(game, "getSpecification");
            Object nation = invoke(specification, "getNation", new Class<?>[]{String.class}, requestedNationId);
            Object nationType = invoke(specification, "getNationType", new Class<?>[]{String.class}, requestedNationTypeId);
            if (nation == null || nationType == null) {
                nationSelectionStatus = "requested-id-not-found";
                nationSelectionJson = nationSelectionReceipt(null, null, null, null, false, nationSelectionStatus);
                return;
            }
            Object controller = invoke(client, "getPreGameController");
            if (controller == null) {
                nationSelectionStatus = "pre-game-controller-unavailable";
                nationSelectionJson = nationSelectionReceipt(null, null, null, null, false, nationSelectionStatus);
                return;
            }
            Class<?> nationClass = Class.forName("net.sf.freecol.common.model.Nation");
            Class<?> nationTypeClass = Class.forName("net.sf.freecol.common.model.NationType");
            Method setNation = controller.getClass().getMethod("setNation", nationClass);
            Method setNationType = controller.getClass().getMethod("setNationType", nationTypeClass);
            setNation.invoke(controller, nation);
            setNationType.invoke(controller, nationType);
            nationSelectionStatus = "selection-requested-awaiting-model-confirmation";
            nationSelectionJson = nationSelectionReceipt(null, null, null, null, false, nationSelectionStatus);
        } catch (Exception exception) {
            nationSelectionStatus = "selection-request-failed";
            recordNationSelectionFailure(exception);
            nationSelectionJson = nationSelectionReceipt(null, null, null, null, false, nationSelectionStatus);
        }
    }

    private static void confirmNationSelection(Window frame) {
        try {
            Object client = field(frame, "freeColClient");
            Object player = invoke(client, "getMyPlayer");
            nationSelectionObservationCount++;
            if (player == null) {
                nationSelectionStatus = "awaiting-player-model";
                nationSelectionLastObservationStatus = nationSelectionStatus;
                nationSelectionJson = nationSelectionReceipt(null, null, null, null, false, nationSelectionStatus);
                return;
            }
            Object nation = invoke(player, "getNation");
            Object nationType = invoke(player, "getNationType");
            String observedNationId = nation == null ? null : String.valueOf(invoke(nation, "getId"));
            String observedNationTypeId = nationType == null ? null : String.valueOf(invoke(nationType, "getId"));
            nationSelectionLastObservedNationId = observedNationId;
            nationSelectionLastObservedNationTypeId = observedNationTypeId;
            Object server = invoke(client, "getFreeColServer");
            if (server == null) {
                nationSelectionStatus = "awaiting-local-server-model";
                nationSelectionLastObservationStatus = nationSelectionStatus;
                nationSelectionJson = nationSelectionReceipt(observedNationId, observedNationTypeId,
                        null, null, false, nationSelectionStatus);
                return;
            }
            Object serverGame = invoke(server, "getGame");
            Class<?> playerClass = Class.forName("net.sf.freecol.common.model.Player");
            Object serverPlayer = invoke(serverGame, "getFreeColGameObject",
                    new Class<?>[]{String.class, Class.class}, String.valueOf(invoke(player, "getId")), playerClass);
            if (serverPlayer == null) {
                nationSelectionStatus = "awaiting-server-player-model";
                nationSelectionLastObservationStatus = nationSelectionStatus;
                nationSelectionJson = nationSelectionReceipt(observedNationId, observedNationTypeId,
                        null, null, false, nationSelectionStatus);
                return;
            }
            Object serverNation = invoke(serverPlayer, "getNation");
            Object serverNationType = invoke(serverPlayer, "getNationType");
            nationSelectionLastServerNationId = serverNation == null ? null : String.valueOf(invoke(serverNation, "getId"));
            nationSelectionLastServerNationTypeId = serverNationType == null ? null : String.valueOf(invoke(serverNationType, "getId"));
            nationSelectionConfirmed = nationSelectionModelsMatch(requestedNationId, requestedNationTypeId,
                    observedNationId, observedNationTypeId, nationSelectionLastServerNationId,
                    nationSelectionLastServerNationTypeId);
            nationSelectionStatus = nationSelectionConfirmed ? "confirmed-by-client-and-server-models" : "player-model-mismatch";
            nationSelectionLastObservationStatus = nationSelectionStatus;
            nationSelectionJson = nationSelectionReceipt(observedNationId, observedNationTypeId,
                    nationSelectionLastServerNationId, nationSelectionLastServerNationTypeId,
                    nationSelectionConfirmed, nationSelectionStatus);
        } catch (Exception exception) {
            nationSelectionStatus = "confirmation-observation-failed";
            nationSelectionLastObservationStatus = nationSelectionStatus;
            recordNationSelectionFailure(exception);
            nationSelectionJson = nationSelectionReceipt(null, null, nationSelectionLastServerNationId,
                    nationSelectionLastServerNationTypeId, false, nationSelectionStatus);
        }
    }

    private static String nationSelectionReceipt(String observedNationId, String observedNationTypeId,
                                                  String observedServerNationId, String observedServerNationTypeId,
                                                  boolean confirmed, String status) {
        return "{\"requestedNationId\":" + quote(requestedNationId)
                + ",\"requestedNationTypeId\":" + quote(requestedNationTypeId)
                + ",\"selectionAttempted\":" + nationSelectionAttempted
                + ",\"selectionMethod\":\"FreeColClient.getPreGameController().setNation/setNationType\""
                + ",\"observedPlayerNationId\":" + (observedNationId == null ? "null" : quote(observedNationId))
                + ",\"observedPlayerNationTypeId\":" + (observedNationTypeId == null ? "null" : quote(observedNationTypeId))
                + ",\"observedServerNationId\":" + (observedServerNationId == null ? "null" : quote(observedServerNationId))
                + ",\"observedServerNationTypeId\":" + (observedServerNationTypeId == null ? "null" : quote(observedServerNationTypeId))
                + ",\"confirmationObservationCount\":" + nationSelectionObservationCount
                + ",\"clientModelObserved\":" + (observedNationId != null && observedNationTypeId != null)
                + ",\"serverModelObserved\":" + (observedServerNationId != null && observedServerNationTypeId != null)
                + ",\"confirmed\":" + confirmed + ",\"startActionWithheldUntilConfirmed\":true"
                + ",\"status\":" + quote(status)
                + ",\"lastObservationStatus\":" + (nationSelectionLastObservationStatus == null
                ? "null" : quote(nationSelectionLastObservationStatus))
                + ",\"failureType\":" + (nationSelectionFailureType == null ? "null" : quote(nationSelectionFailureType))
                + ",\"failureMessage\":" + (nationSelectionFailureMessage == null ? "null" : quote(nationSelectionFailureMessage))
                + "}";
    }

    private static void recordNationSelectionFailure(Exception exception) {
        Throwable cause = exception;
        while (cause instanceof InvocationTargetException invocation && invocation.getCause() != null) {
            cause = invocation.getCause();
        }
        nationSelectionFailureType = cause.getClass().getSimpleName();
        String message = cause.getMessage() == null ? "" : cause.getMessage();
        message = message.replaceAll("[\\p{Cntrl}&&[^\\n\\t]]", " ").replaceAll("\\s+", " ").trim();
        message = SENSITIVE_DIAGNOSTIC.matcher(message).replaceAll("$1$2[redacted]");
        if (message.length() > MAX_NATION_SELECTION_DIAGNOSTIC_CHARS) {
            message = message.substring(0, MAX_NATION_SELECTION_DIAGNOSTIC_CHARS);
        }
        nationSelectionFailureMessage = message;
    }

    private static void advanceInformationPanel(Window frame) throws Exception {
        List<Component> components = new ArrayList<>();
        collectComponents(frame, components);
        List<Component> panels = components.stream()
                .filter(component -> component.getClass().getName().equals("net.sf.freecol.client.gui.panel.InformationPanel"))
                .filter(Component::isShowing)
                .toList();
        if (panels.size() != 1 || INFORMATION_PANEL_ACTION_OBSERVATIONS.size() >= MAX_START_ACTION_OBSERVATIONS) return;
        Component panel = panels.get(0);
        if (INFORMATION_PANELS_DISMISSED.contains(panel) || !panel.isEnabled()) return;
        Object value = field(panel, "okButton");
        if (!(value instanceof JButton button) || !button.isShowing() || !button.isEnabled()
                || !"OK".equals(button.getActionCommand())) return;
        AtomicReference<Boolean> actionObserved = new AtomicReference<>(false);
        ActionListener receiptListener = (ActionEvent event) -> actionObserved.set("OK".equals(event.getActionCommand()));
        button.addActionListener(receiptListener);
        try {
            button.doClick(0);
        } finally {
            button.removeActionListener(receiptListener);
        }
        INFORMATION_PANELS_DISMISSED.add(panel);
        INFORMATION_PANEL_ACTION_OBSERVATIONS.add("{\"panelClass\":" + quote(panel.getClass().getName())
                + ",\"panelIdentity\":" + System.identityHashCode(panel)
                + ",\"buttonClass\":" + quote(button.getClass().getName())
                + ",\"buttonIdentity\":" + System.identityHashCode(button)
                + ",\"actionCommand\":\"OK\",\"normalDoClickCalled\":true,\"actionEventObserved\":" + actionObserved.get()
                + ",\"sourceBytecodeAction\":\"FreeColPanel.actionPerformed(OK) calls GUI.removeComponent(panel)\"}");
    }

    private static String timeoutJson() {
        if (requestedNationId != null && !nationSelectionConfirmed && !nationSelectionRequestFailed()) {
            nationSelectionStatus = "confirmation-deadline-exhausted";
            nationSelectionJson = nationSelectionReceipt(nationSelectionLastObservedNationId,
                    nationSelectionLastObservedNationTypeId, nationSelectionLastServerNationId,
                    nationSelectionLastServerNationTypeId, false, nationSelectionStatus);
        }
        return "{\"schemaVersion\":2,\"status\":\"timeout-no-live-map\",\"startActionObservations\":["
                + String.join(",", START_ACTION_OBSERVATIONS) + "],\"nationSelection\":" + nationSelectionJson
                + ",\"informationPanelActionObservations\":["
                + String.join(",", INFORMATION_PANEL_ACTION_OBSERVATIONS) + "],\"uiState\":" + lastUiState
                + (captureScreenPath == null ? "" : ",\"actualScreenCapture\":{\"status\":\"timeout-no-live-map\",\"screenshotCreated\":false}") + "}";
    }

    private static String withCapture(String liveJson, String captureJson) {
        String updated = captureJson.contains("\"screenshotCreated\":true")
                ? liveJson.replace("\"screenshotCreated\":false", "\"screenshotCreated\":true") : liveJson;
        int end = updated.lastIndexOf('}');
        return end < 0 ? liveJson : updated.substring(0, end) + ",\"actualScreenCapture\":" + captureJson + updated.substring(end);
    }

    private static String captureActualScreen() throws Exception {
        String refreshed = snapshot();
        if (refreshed == null || !expectedCaptureStateSignature.equals(latestStateSignature)) {
            return "{\"status\":\"state-changed-before-capture\",\"screenshotCreated\":false,\"observedStateSignatureSha256\":"
                    + quote(latestStateSignature == null ? "" : latestStateSignature) + "}";
        }
        if (!latestMapUnitInventoryComplete || !latestVisibleFrontInventoryComplete || !latestCaptureUiGateSafe) {
            return "{\"status\":\"capture-veto-incomplete-or-blocked-state\",\"screenshotCreated\":false"
                    + ",\"mapUnitInventoryComplete\":" + latestMapUnitInventoryComplete
                    + ",\"visibleFrontInventoryComplete\":" + latestVisibleFrontInventoryComplete
                    + ",\"captureUiGateSafe\":" + latestCaptureUiGateSafe
                    + ",\"captureUiGate\":" + latestCaptureUiGateJson + "}";
        }
        BufferedImage targetSprite = null;
        Rectangle targetBounds = null;
        String targetEvidence;
        if (captureTargetUnitId != null) {
            targetSprite = latestTargetSprites.get(captureTargetUnitId);
            targetBounds = latestTargetScreenBounds.get(captureTargetUnitId);
            if (targetSprite == null || targetBounds == null || !Boolean.TRUE.equals(latestTargetResourceVerified.get(captureTargetUnitId))
                    || !Boolean.TRUE.equals(latestTargetOverlaySafe.get(captureTargetUnitId))
                    || !Boolean.TRUE.equals(latestTargetBboxUnchanged.get(captureTargetUnitId))) {
                return "{\"status\":\"capture-veto-target-ambiguous\",\"screenshotCreated\":false"
                        + ",\"targetUnitId\":" + quote(captureTargetUnitId)
                        + ",\"resourcePixelsVerified\":" + Boolean.TRUE.equals(latestTargetResourceVerified.get(captureTargetUnitId))
                        + ",\"bboxUnchangedAfterKnownChip\":" + Boolean.TRUE.equals(latestTargetBboxUnchanged.get(captureTargetUnitId))
                        + ",\"rendererAndUiOverlaysClear\":" + Boolean.TRUE.equals(latestTargetOverlaySafe.get(captureTargetUnitId)) + "}";
            }
            for (Map.Entry<String, Rectangle> entry : latestTargetScreenBounds.entrySet()) {
                if (!entry.getKey().equals(captureTargetUnitId) && targetBounds.intersects(entry.getValue())) {
                    return "{\"status\":\"capture-veto-overlapping-unit-bounds\",\"screenshotCreated\":false,\"overlappingUnitId\":"
                            + quote(entry.getKey()) + "}";
                }
            }
            targetEvidence = "{\"kind\":\"positive-unit\",\"unitId\":" + quote(captureTargetUnitId)
                    + ",\"estimatedAlphaScreenBounds\":" + rectangleJson(targetBounds)
                    + ",\"sourceSpritePixelSha256\":" + quote(pixelSha256(targetSprite))
                    + ",\"resourcePixelIdentityVerified\":true,\"boxOnlyGeometryGatePassed\":true"
                    + ",\"alphaBoundsUnchangedAfterKnownChip\":true,\"pixelUnoccludedStatus\":\"pending-exact-screen-comparison\"}";
        } else {
            if (!latestValidUnitTypeIds.contains(captureAbsentUnitTypeId)) {
                return "{\"status\":\"capture-veto-unknown-unit-type\",\"screenshotCreated\":false,\"unitTypeId\":"
                        + quote(captureAbsentUnitTypeId) + "}";
            }
            int count = latestMapUnitTypeCounts.getOrDefault(captureAbsentUnitTypeId, 0);
            if (count != 0) {
                return "{\"status\":\"capture-veto-unit-type-present\",\"screenshotCreated\":false,\"unitTypeId\":"
                        + quote(captureAbsentUnitTypeId) + ",\"count\":" + count + "}";
            }
            int viewportCount = latestViewportFrontUnitTypeCounts.getOrDefault(captureAbsentUnitTypeId, 0);
            if (viewportCount != 0) {
                return "{\"status\":\"capture-veto-unit-type-render-visible\",\"screenshotCreated\":false,\"unitTypeId\":"
                        + quote(captureAbsentUnitTypeId) + ",\"count\":" + viewportCount + "}";
            }
            targetEvidence = "{\"kind\":\"negative-global-type-absence\",\"unitTypeId\":"
                    + quote(captureAbsentUnitTypeId) + ",\"validSpecificationType\":true,\"countOnAllMapTiles\":0"
                    + ",\"countInCompleteViewportFrontInventory\":0}";
        }

        java.awt.Dimension screen = Toolkit.getDefaultToolkit().getScreenSize();
        if (screen.width != 1024 || screen.height != 768) {
            return "{\"status\":\"capture-veto-unexpected-display-size\",\"screenshotCreated\":false,\"width\":"
                    + screen.width + ",\"height\":" + screen.height + "}";
        }
        if (targetBounds != null && (!new Rectangle(0, 0, screen.width, screen.height).contains(targetBounds)
                || latestScreenViewport == null || !latestScreenViewport.contains(targetBounds))) {
            return "{\"status\":\"capture-veto-clipped-target\",\"screenshotCreated\":false,\"targetBounds\":"
                    + rectangleJson(targetBounds) + "}";
        }

        Toolkit.getDefaultToolkit().sync();
        BufferedImage fullScreen = new Robot().createScreenCapture(new Rectangle(0, 0, screen.width, screen.height));
        CapturePixelEvidence pixelEvidence = targetSprite == null ? null : compareOpaqueSpritePixels(
                fullScreen, targetSprite, latestTargetSpriteOrigins.get(captureTargetUnitId),
                latestTargetChips.get(captureTargetUnitId), latestTargetChipOrigins.get(captureTargetUnitId));
        Path screenPath = Path.of(captureScreenPath).toAbsolutePath().normalize();
        if (!screenPath.getParent().equals(Path.of(captureSpritePath == null ? captureScreenPath : captureSpritePath).toAbsolutePath().normalize().getParent())) {
            return "{\"status\":\"capture-veto-output-paths-differ\",\"screenshotCreated\":false}";
        }
        writePngAtomically(screenPath, fullScreen);
        String spriteReceipt = "null";
        if (targetSprite != null) {
            Path spritePath = Path.of(captureSpritePath).toAbsolutePath().normalize();
            writePngAtomically(spritePath, targetSprite);
            spriteReceipt = "{\"path\":" + quote(spritePath.toString()) + ",\"sha256\":" + quote(sha256(spritePath))
                    + ",\"pixelSha256\":" + quote(pixelSha256(targetSprite))
                    + ",\"width\":" + targetSprite.getWidth() + ",\"height\":" + targetSprite.getHeight() + "}";
        }
        return "{\"status\":\"captured\",\"screenshotCreated\":true,\"captureMethod\":\"java.awt.Robot full physical display\""
                + ",\"screenBounds\":{\"x\":0,\"y\":0,\"width\":" + screen.width + ",\"height\":" + screen.height + "}"
                + ",\"screenshot\":{\"path\":" + quote(screenPath.toString()) + ",\"sha256\":" + quote(sha256(screenPath))
                + ",\"bytes\":" + Files.size(screenPath) + ",\"width\":" + fullScreen.getWidth() + ",\"height\":" + fullScreen.getHeight() + "}"
                + ",\"sourceSprite\":" + spriteReceipt
                + ",\"target\":" + targetEvidence
                + ",\"visiblePixelEvidence\":" + (pixelEvidence == null ? "null" : pixelEvidence.json())
                + ",\"stateSignatureSha256\":" + quote(latestStateSignature)
                + ",\"frameScreenOrigin\":{" + "\"x\":" + latestFrameOrigin.x + ",\"y\":" + latestFrameOrigin.y + "}}";
    }

    private record CapturePixelEvidence(String json) {}

    private static CapturePixelEvidence compareOpaqueSpritePixels(BufferedImage screen, BufferedImage sprite,
                                                                  Point spriteOrigin, BufferedImage chip,
                                                                  Point chipOrigin) {
        if (spriteOrigin == null) return new CapturePixelEvidence("{\"status\":\"unavailable-sprite-origin\"}");
        Rectangle alphaBounds = alphaBounds(sprite);
        if (alphaBounds == null) return new CapturePixelEvidence("{\"status\":\"empty-source-alpha\"}");
        int opaquePixels = 0;
        int matchedPixels = 0;
        int mismatchedPixels = 0;
        int chipOverlapPixels = 0;
        int chipOverlapScreenshotMatchesChip = 0;
        int chipOverlapScreenshotDiffersFromSprite = 0;
        int minMatchedX = sprite.getWidth(), minMatchedY = sprite.getHeight(), maxMatchedX = -1, maxMatchedY = -1;
        for (int y = 0; y < sprite.getHeight(); y++) {
            for (int x = 0; x < sprite.getWidth(); x++) {
                int source = sprite.getRGB(x, y);
                if ((source >>> 24) != 255) continue;
                opaquePixels++;
                int sx = spriteOrigin.x + x;
                int sy = spriteOrigin.y + y;
                if (sx < 0 || sy < 0 || sx >= screen.getWidth() || sy >= screen.getHeight()) {
                    mismatchedPixels++;
                    continue;
                }
                int observed = screen.getRGB(sx, sy) & 0x00ffffff;
                if (observed == (source & 0x00ffffff)) {
                    matchedPixels++;
                    minMatchedX = Math.min(minMatchedX, x);
                    minMatchedY = Math.min(minMatchedY, y);
                    maxMatchedX = Math.max(maxMatchedX, x);
                    maxMatchedY = Math.max(maxMatchedY, y);
                } else {
                    mismatchedPixels++;
                }
                if (chip != null && chipOrigin != null) {
                    int cx = sx - chipOrigin.x;
                    int cy = sy - chipOrigin.y;
                    if (cx >= 0 && cy >= 0 && cx < chip.getWidth() && cy < chip.getHeight()
                            && (chip.getRGB(cx, cy) >>> 24) == 255) {
                        chipOverlapPixels++;
                        if (observed == (chip.getRGB(cx, cy) & 0x00ffffff)) chipOverlapScreenshotMatchesChip++;
                        if (observed != (source & 0x00ffffff)) chipOverlapScreenshotDiffersFromSprite++;
                    }
                }
            }
        }
        boolean matchedExtent = minMatchedX == alphaBounds.x && minMatchedY == alphaBounds.y
                && maxMatchedX == alphaBounds.x + alphaBounds.width - 1
                && maxMatchedY == alphaBounds.y + alphaBounds.height - 1;
        boolean chipOcclusionConfirmed = chipOverlapPixels > 0
                && chipOverlapScreenshotMatchesChip == chipOverlapPixels
                && chipOverlapScreenshotDiffersFromSprite == chipOverlapPixels;
        boolean unoccluded = opaquePixels > 0 && mismatchedPixels == 0;
        return new CapturePixelEvidence("{\"status\":\"compared\",\"opaqueSpritePixels\":" + opaquePixels
                + ",\"screenshotMatchesOpaqueSpritePixels\":" + matchedPixels
                + ",\"screenshotDiffersFromOpaqueSpritePixels\":" + mismatchedPixels
                + ",\"matchedOpaqueExtentEqualsSourceAlphaBounds\":" + matchedExtent
                + ",\"matchedOpaqueSourceBounds\":" + (maxMatchedX < 0 ? "null" : rectangleJson(new Rectangle(minMatchedX, minMatchedY, maxMatchedX - minMatchedX + 1, maxMatchedY - minMatchedY + 1)))
                + ",\"sourceAlphaBounds\":" + rectangleJson(alphaBounds)
                + ",\"chipOverlapOpaquePixels\":" + chipOverlapPixels
                + ",\"chipOverlapScreenshotMatchesChipPixels\":" + chipOverlapScreenshotMatchesChip
                + ",\"chipOverlapScreenshotDiffersFromSpritePixels\":" + chipOverlapScreenshotDiffersFromSprite
                + ",\"chipOcclusionConfirmedByScreenshotPixels\":" + chipOcclusionConfirmed
                + ",\"unoccludedPositiveAdmission\":" + unoccluded + "}");
    }

    private static void writePngAtomically(Path target, BufferedImage image) throws IOException {
        if (Files.exists(target) || Files.isSymbolicLink(target)) throw new IOException("capture target already exists or is linked");
        Path temporary = target.resolveSibling(target.getFileName() + ".part");
        if (Files.exists(temporary) || Files.isSymbolicLink(temporary)) throw new IOException("capture temporary target already exists or is linked");
        if (!ImageIO.write(image, "png", temporary.toFile())) throw new IOException("PNG writer unavailable");
        Files.move(temporary, target, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
    }

    static boolean captureUiPanelsAllowed(List<UiPanelFact> panels, int externalShowingWindowCount,
                                          boolean componentInventoryComplete, Rectangle targetBounds) {
        if (!componentInventoryComplete || externalShowingWindowCount != 0) return false;
        int allowedPersistentPanels = 0;
        for (UiPanelFact panel : panels) {
            if (!panel.showing()) continue;
            if (!"net.sf.freecol.client.gui.panel.InfoPanel".equals(panel.className())) return false;
            if (!panel.boundsAvailable() || panel.screenBounds() == null) return false;
            allowedPersistentPanels++;
            if (allowedPersistentPanels > 1) return false;
            if (targetBounds != null && targetBounds.intersects(panel.screenBounds())) return false;
        }
        return true;
    }

    private static CaptureUiEvidence inspectCaptureUi(Window frame) {
        List<Component> components = new ArrayList<>();
        collectComponents(frame, components);
        boolean complete = components.size() < 4_096;
        int visibleCount = 0;
        List<String> componentRows = new ArrayList<>();
        List<UiPanelFact> panels = new ArrayList<>();
        for (Component component : components) {
            if (!component.isShowing()) continue;
            visibleCount++;
            Point origin = null;
            Rectangle bounds = null;
            boolean boundsAvailable = false;
            try {
                origin = component.getLocationOnScreen();
                bounds = new Rectangle(origin.x, origin.y, component.getWidth(), component.getHeight());
                boundsAvailable = component.getWidth() > 0 && component.getHeight() > 0;
            } catch (java.awt.IllegalComponentStateException ignored) {
                complete = false;
            }
            boolean freeColPanel = isFreeColPanelClass(component.getClass());
            if (freeColPanel) panels.add(new UiPanelFact(component.getClass().getName(), bounds, true, boundsAvailable));
            if (componentRows.size() < MAX_CAPTURE_UI_COMPONENTS) {
                boolean opaque = component instanceof javax.swing.JComponent swingComponent && swingComponent.isOpaque();
                componentRows.add("{\"class\":" + quote(component.getClass().getName())
                        + ",\"identity\":" + System.identityHashCode(component)
                        + ",\"enabled\":" + component.isEnabled()
                        + ",\"opaque\":" + opaque
                        + ",\"boundsAvailable\":" + boundsAvailable
                        + ",\"screenBounds\":" + rectangleJson(bounds) + "}");
            } else {
                complete = false;
            }
        }
        int externalWindows = 0;
        List<String> externalWindowRows = new ArrayList<>();
        for (Window window : Window.getWindows()) {
            if (window == frame || !window.isShowing()) continue;
            externalWindows++;
            Rectangle bounds = null;
            try {
                Point origin = window.getLocationOnScreen();
                bounds = new Rectangle(origin.x, origin.y, window.getWidth(), window.getHeight());
            } catch (java.awt.IllegalComponentStateException ignored) {
                complete = false;
            }
            if (externalWindowRows.size() < 64) {
                externalWindowRows.add("{\"class\":" + quote(window.getClass().getName())
                        + ",\"screenBounds\":" + rectangleJson(bounds) + "}");
            } else {
                complete = false;
            }
        }
        boolean safe = captureUiPanelsAllowed(panels, externalWindows, complete, null);
        String json = "{\"status\":" + quote(safe ? "known-map-hud-only" : "blocked-or-incomplete-ui")
                + ",\"captureAllowedBeforeTargetOverlapCheck\":" + safe
                + ",\"componentInventoryComplete\":" + complete
                + ",\"visibleComponentCount\":" + visibleCount
                + ",\"visibleComponentInventory\":[" + String.join(",", componentRows) + "]"
                + ",\"allowedPersistentHudClass\":\"net.sf.freecol.client.gui.panel.InfoPanel\""
                + ",\"visibleFreeColPanelInventory\":[" + panels.stream().map(panel -> "{\"class\":" + quote(panel.className())
                        + ",\"showing\":" + panel.showing() + ",\"boundsAvailable\":" + panel.boundsAvailable()
                        + ",\"screenBounds\":" + rectangleJson(panel.screenBounds()) + "}").collect(java.util.stream.Collectors.joining(",")) + "]"
                + ",\"externalShowingWindowCount\":" + externalWindows
                + ",\"externalShowingWindows\":[" + String.join(",", externalWindowRows) + "]}";
        return new CaptureUiEvidence(json, complete, externalWindows, List.copyOf(panels), visibleCount);
    }

    private static String uiStateJson(Window frame) {
        List<Component> components = new ArrayList<>();
        collectComponents(frame, components);
        List<String> panels = new ArrayList<>();
        List<String> buttons = new ArrayList<>();
        List<String> startPanels = new ArrayList<>();
        latestVisibleFreeColPanelCount = 0;
        for (Component component : components) {
            String className = component.getClass().getName();
            if (className.equals("net.sf.freecol.client.gui.panel.StartGamePanel") && startPanels.size() < MAX_UI_ROWS) {
                String buttonState = "null";
                try {
                    Field start = component.getClass().getDeclaredField("start");
                    start.setAccessible(true);
                    Object value = start.get(component);
                    if (value instanceof AbstractButton button) {
                        buttonState = "{\"class\":" + quote(button.getClass().getName())
                                + ",\"text\":" + quote(shortText(button.getText()))
                                + ",\"showing\":" + button.isShowing()
                                + ",\"enabled\":" + button.isEnabled() + "}";
                    }
                } catch (ReflectiveOperationException ignored) {
                    buttonState = "null";
                }
                startPanels.add("{\"identity\":" + System.identityHashCode(component)
                        + ",\"showing\":" + component.isShowing()
                        + ",\"enabled\":" + component.isEnabled()
                        + ",\"startButton\":" + buttonState + "}");
            }
            if (!component.isShowing()) continue;
            if (isFreeColPanelClass(component.getClass())) latestVisibleFreeColPanelCount++;
            if (className.startsWith("net.sf.freecol.client.gui.panel.") && panels.size() < MAX_UI_ROWS) {
                panels.add("{\"class\":" + quote(className) + ",\"enabled\":" + component.isEnabled() + "}");
            }
            if (component instanceof AbstractButton button && buttons.size() < MAX_UI_ROWS) {
                buttons.add("{\"class\":" + quote(className)
                        + ",\"text\":" + quote(shortText(button.getText()))
                        + ",\"actionCommand\":" + quote(shortText(button.getActionCommand()))
                        + ",\"enabled\":" + button.isEnabled() + "}");
            }
        }
        return "{\"startGamePanelCandidates\":[" + String.join(",", startPanels)
                + "],\"visiblePanels\":[" + String.join(",", panels)
                + "],\"visibleButtons\":[" + String.join(",", buttons) + "]}";
    }

    private static boolean isFreeColPanelClass(Class<?> type) {
        for (Class<?> cursor = type; cursor != null; cursor = cursor.getSuperclass()) {
            if (cursor.getName().equals("net.sf.freecol.client.gui.panel.FreeColPanel")) return true;
        }
        return false;
    }

    private static void collectComponents(Component component, List<Component> target) {
        if (target.size() >= 4096) return;
        target.add(component);
        if (component instanceof Container container) {
            for (Component child : container.getComponents()) {
                if (target.size() >= 4096) break;
                collectComponents(child, target);
            }
        }
    }

    private static String shortText(String value) {
        if (value == null) return "";
        String normalized = value.replace('\n', ' ').replace('\r', ' ');
        return normalized.length() <= 80 ? normalized : normalized.substring(0, 80);
    }

    private static UnitResourceEvidence unitResourceEvidence(Object imageLibrary, Object unit, Object type, Object owner,
                                                             boolean faded, BufferedImage sprite) throws Exception {
        Class<?> typeClass = Class.forName("net.sf.freecol.common.model.UnitType");
        Class<?> playerClass = Class.forName("net.sf.freecol.common.model.Player");
        Method keyMethod = imageLibrary.getClass().getDeclaredMethod(
                "getUnitTypeImageKey", typeClass, playerClass, String.class, boolean.class);
        keyMethod.setAccessible(true);
        Object role = invoke(unit, "getRole");
        String roleId = String.valueOf(invoke(role, "getId"));
        boolean nativeEthnicity = (Boolean) invoke(unit, "hasNativeEthnicity");
        String key = String.valueOf(keyMethod.invoke(null, type, owner, roleId, nativeEthnicity));
        Class<?> resourceManager = Class.forName("net.sf.freecol.common.resources.ResourceManager");
        Method getImageResource = resourceManager.getMethod("getImageResource", String.class, boolean.class);
        Object resource = getImageResource.invoke(null, key, false);
        if (resource == null) {
            return new UnitResourceEvidence("{\"key\":" + quote(key) + ",\"resolved\":false}", false);
        }
        URI locator = (URI) invoke(resource, "getResourceLocator");
        BufferedImage baseImage = (BufferedImage) invoke(resource, "getImage");
        String basePixelHash = baseImage == null ? "" : pixelSha256(baseImage);
        String spritePixelHash = pixelSha256(sprite);
        String locatorSha = localResourceSha256(locator);
        List<String> alternatives = new ArrayList<>();
        Object altValue = field(resource, "alternativeLocators");
        if (altValue instanceof List<?> locators) {
            for (Object alternative : locators) {
                if (alternatives.size() >= 16) break;
                URI uri = (URI) alternative;
                String sha = localResourceSha256(uri);
                alternatives.add("{\"uri\":" + quote(uri.toString()) + ",\"sha256\":" + (sha.isEmpty() ? "null" : quote(sha)) + "}");
            }
        }
        String json = "{\"key\":" + quote(key)
                + ",\"resolved\":true"
                + ",\"locator\":" + quote(locator.toString())
                + ",\"locatorSha256\":" + (locatorSha.isEmpty() ? "null" : quote(locatorSha))
                + ",\"baseImagePixelSha256\":" + (basePixelHash.isEmpty() ? "null" : quote(basePixelHash))
                + ",\"returnedSpritePixelSha256\":" + quote(spritePixelHash)
                + ",\"returnedPixelsMatchBaseImage\":" + (!faded && basePixelHash.equals(spritePixelHash))
                + ",\"faded\":" + faded
                + ",\"alternatives\":[" + String.join(",", alternatives) + "]}";
        return new UnitResourceEvidence(json, !faded && basePixelHash.equals(spritePixelHash));
    }

    private static OverlayEvidence unitOverlayEvidence(Object imageLibrary, Object canvas, Object unit, Object tile,
                                                       BufferedImage sprite, Point imageOffset,
                                                       java.awt.Dimension tileSize) {
        Graphics2D graphics = null;
        try {
            if (!(canvas instanceof Component component) || !(component.getGraphics() instanceof Graphics2D actualGraphics)) {
                return new OverlayEvidence("{\"geometryAvailable\":false}", false, false, true, null, null);
            }
            graphics = actualGraphics;
            Class<?> unitClass = Class.forName("net.sf.freecol.common.model.Unit");
            Class<?> playerClass = Class.forName("net.sf.freecol.common.model.Player");
            Class<?> templateClass = Class.forName("net.sf.freecol.common.model.StringTemplate");
            Object player = invoke(unit, "getOwner");
            Object template = unitClass.getMethod("getOccupationLabel", playerClass, boolean.class).invoke(unit, player, false);
            String label = String.valueOf(Class.forName("net.sf.freecol.common.i18n.Messages")
                    .getMethod("message", templateClass).invoke(null, template));
            BufferedImage chip = (BufferedImage) imageLibrary.getClass()
                    .getMethod("getOccupationIndicatorChip", Graphics2D.class, unitClass, String.class)
                    .invoke(imageLibrary, graphics, unit, label);
            Class<?> tileViewerClass = Class.forName("net.sf.freecol.client.gui.mapviewer.TileViewer");
            int stateOffsetX = staticInt(tileViewerClass, "STATE_OFFSET_X");
            int chipX = scaleInt(imageLibrary, stateOffsetX);
            Rectangle chipAlpha = alphaBounds(chip);
            boolean chipOverlap = chipAlpha != null && alphaOverlap(sprite, imageOffset, chip, new Point(chipX, 0));
            VisibleSpriteBounds visibleAfterChip = alphaBoundsAfterOpaqueChip(sprite, imageOffset, chip, new Point(chipX, 0));
            Rectangle rawAlphaBounds = alphaBounds(sprite);
            boolean bboxUnchangedAfterChip = rawAlphaBounds != null && rawAlphaBounds.equals(visibleAfterChip.bounds());

            Class<?> tileBoundsClass = Class.forName("net.sf.freecol.client.gui.mapviewer.TileBounds");
            int unitCount = ((Number) invoke(tile, "getTotalUnitCount")).intValue();
            boolean stackPresent = unitCount > 1;
            boolean stackOverlap = false;
            int stackX1 = scaleInt(imageLibrary, stateOffsetX + staticInt(tileBoundsClass, "OTHER_UNITS_OFFSET_X"));
            int stackX2 = scaleInt(imageLibrary, stateOffsetX + staticInt(tileBoundsClass, "OTHER_UNITS_OFFSET_X")
                    + staticInt(tileBoundsClass, "OTHER_UNITS_WIDTH"));
            int stackY = staticInt(tileBoundsClass, "OTHER_UNITS_OFFSET_Y");
            if (stackPresent) {
                int lines = Math.min(unitCount, staticInt(tileBoundsClass, "MAX_OTHER_UNITS"));
                for (int line = 0; line < lines; line++) {
                    stackOverlap |= horizontalLineHitsSprite(sprite, imageOffset, stackX1, stackX2, stackY + line * 2);
                }
            }

            int hitPoints = ((Number) invoke(unit, "getHitPoints")).intValue();
            int maxHitPoints = ((Number) invoke(unit, "getMaximumHitPoints")).intValue();
            boolean healthBarPresent = hitPoints >= 0 && hitPoints < maxHitPoints;
            boolean healthBarOverlap = false;
            Rectangle healthBar = null;
            if (healthBarPresent) {
                int offsetX = scaleInt(imageLibrary, 8);
                int barWidth = scaleInt(imageLibrary, 5);
                int margin = scaleInt(imageLibrary, 5);
                int fullHeight = tileSize.height - 2 * margin;
                int filledHeight = (int) (fullHeight * (((float) hitPoints) / maxHitPoints));
                healthBar = new Rectangle(margin + barWidth + offsetX,
                        margin - scaleInt(imageLibrary, staticInt(tileBoundsClass, "UNIT_OFFSET")),
                        barWidth, Math.max(1, fullHeight));
                healthBarOverlap = rectangleHitsSprite(sprite, imageOffset, healthBar);
            }
            Rectangle chipRect = chipAlpha == null ? null : new Rectangle(chipX + chipAlpha.x, chipAlpha.y, chipAlpha.width, chipAlpha.height);
            String json = "{\"geometryAvailable\":true,\"tileUnitCount\":" + unitCount
                    + ",\"occupationChip\":{\"present\":true,\"label\":" + quote(shortText(label))
                    + ",\"alphaBoundsInTile\":" + rectangleJson(chipRect) + ",\"alphaOverlapsSprite\":" + chipOverlap
                    + ",\"fullyOccludedOpaqueSpritePixels\":" + visibleAfterChip.fullyOccludedOpaquePixels()
                    + ",\"spriteBoundsAfterOpaqueChip\":" + rectangleJson(visibleAfterChip.bounds())
                    + ",\"spriteBoundsUnchanged\":" + bboxUnchangedAfterChip + "}"
                    + ",\"stackIndicator\":{\"present\":" + stackPresent + ",\"overlapsSprite\":" + stackOverlap + "}"
                    + ",\"healthBar\":{\"present\":" + healthBarPresent + ",\"boundsInTile\":" + rectangleJson(healthBar)
                    + ",\"filledHeight\":" + (healthBarPresent ? ((int) ((tileSize.height - 2 * scaleInt(imageLibrary, 5))
                            * (((float) hitPoints) / maxHitPoints))) : 0)
                    + ",\"overlapsSprite\":" + healthBarOverlap + "}}";
            return new OverlayEvidence(json, true, bboxUnchangedAfterChip, stackOverlap || healthBarOverlap, new Point(chipX, 0), chip);
        } catch (Exception exception) {
            return new OverlayEvidence("{\"geometryAvailable\":false,\"errorType\":" + quote(exception.getClass().getSimpleName())
                    + ",\"errorMessage\":" + quote(shortText(exception.getMessage()))
                    + ",\"errorStack\":[" + errorStackJson(exception) + "]}", false, false, true, null, null);
        } finally {
            if (graphics != null) graphics.dispose();
        }
    }

    private static UiOverlapEvidence visibleUiComponentOverlap(Window frame, Object canvasObject, Rectangle targetBounds) {
        if (!(canvasObject instanceof Component canvas)) {
            return new UiOverlapEvidence("{\"available\":false,\"components\":[]}", true);
        }
        List<Component> components = new ArrayList<>();
        collectComponents(frame, components);
        List<String> overlaps = new ArrayList<>();
        for (Component component : components) {
            if (component == frame || component == canvas || !component.isShowing() || isAncestorOf(component, canvas)) continue;
            if (component.getClass().getName().equals("net.sf.freecol.client.gui.mapviewer.CanvasMapViewer")) continue;
            if (component.getWidth() <= 0 || component.getHeight() <= 0) continue;
            try {
                Point origin = component.getLocationOnScreen();
                Rectangle bounds = new Rectangle(origin.x, origin.y, component.getWidth(), component.getHeight());
                if (targetBounds.intersects(bounds) && overlaps.size() < 32) {
                    boolean opaque = component instanceof javax.swing.JComponent swingComponent && swingComponent.isOpaque();
                    overlaps.add("{\"class\":" + quote(component.getClass().getName())
                            + ",\"opaque\":" + opaque + ",\"bounds\":" + rectangleJson(bounds) + "}");
                }
            } catch (java.awt.IllegalComponentStateException exception) {
                if (overlaps.size() < 32) overlaps.add("{\"class\":" + quote(component.getClass().getName()) + ",\"boundsUnavailable\":true}");
            }
        }
        return new UiOverlapEvidence("{\"available\":true,\"components\":[" + String.join(",", overlaps) + "]}", !overlaps.isEmpty());
    }

    private static boolean isAncestorOf(Component ancestor, Component component) {
        for (Component cursor = component.getParent(); cursor != null; cursor = cursor.getParent()) {
            if (cursor == ancestor) return true;
        }
        return false;
    }

    private static boolean horizontalLineHitsSprite(BufferedImage sprite, Point imageOffset, int x1, int x2, int tileY) {
        for (int tileX = Math.min(x1, x2); tileX <= Math.max(x1, x2); tileX++) {
            int x = tileX - imageOffset.x;
            int y = tileY - imageOffset.y;
            if (x >= 0 && y >= 0 && x < sprite.getWidth() && y < sprite.getHeight()
                    && (sprite.getRGB(x, y) >>> 24) != 0) return true;
        }
        return false;
    }

    private static boolean alphaOverlap(BufferedImage first, Point firstOffset, BufferedImage second, Point secondOffset) {
        for (int y = 0; y < second.getHeight(); y++) {
            for (int x = 0; x < second.getWidth(); x++) {
                if ((second.getRGB(x, y) >>> 24) == 0) continue;
                int firstX = secondOffset.x + x - firstOffset.x;
                int firstY = secondOffset.y + y - firstOffset.y;
                if (firstX >= 0 && firstY >= 0 && firstX < first.getWidth() && firstY < first.getHeight()
                        && (first.getRGB(firstX, firstY) >>> 24) != 0) return true;
            }
        }
        return false;
    }

    private static VisibleSpriteBounds alphaBoundsAfterOpaqueChip(BufferedImage sprite, Point spriteOffset,
                                                                  BufferedImage chip, Point chipOffset) {
        int minX = sprite.getWidth(), minY = sprite.getHeight(), maxX = -1, maxY = -1, erased = 0;
        for (int y = 0; y < sprite.getHeight(); y++) {
            for (int x = 0; x < sprite.getWidth(); x++) {
                if ((sprite.getRGB(x, y) >>> 24) == 0) continue;
                int chipX = spriteOffset.x + x - chipOffset.x;
                int chipY = spriteOffset.y + y - chipOffset.y;
                boolean fullyCovered = chipX >= 0 && chipY >= 0 && chipX < chip.getWidth() && chipY < chip.getHeight()
                        && (chip.getRGB(chipX, chipY) >>> 24) == 255;
                if (fullyCovered) {
                    erased++;
                    continue;
                }
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
        Rectangle bounds = maxX < minX ? null : new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
        return new VisibleSpriteBounds(bounds, erased);
    }

    private static boolean rectangleHitsSprite(BufferedImage sprite, Point imageOffset, Rectangle rectangle) {
        for (int tileY = Math.max(rectangle.y, imageOffset.y);
             tileY < Math.min(rectangle.y + rectangle.height, imageOffset.y + sprite.getHeight()); tileY++) {
            for (int tileX = Math.max(rectangle.x, imageOffset.x);
                 tileX < Math.min(rectangle.x + rectangle.width, imageOffset.x + sprite.getWidth()); tileX++) {
                if ((sprite.getRGB(tileX - imageOffset.x, tileY - imageOffset.y) >>> 24) != 0) return true;
            }
        }
        return false;
    }

    private static int staticInt(Class<?> owner, String name) throws Exception {
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        return field.getInt(null);
    }

    private static int scaleInt(Object imageLibrary, int value) throws Exception {
        return ((Number) imageLibrary.getClass().getMethod("scaleInt", int.class).invoke(imageLibrary, value)).intValue();
    }

    private static String localResourceSha256(URI uri) throws Exception {
        if (!"file".equalsIgnoreCase(uri.getScheme())) return "";
        Path file = Path.of(uri).normalize();
        Path allowedRoot = Path.of("/usr/share/games/freecol").toRealPath();
        if (!file.startsWith(allowedRoot) || !Files.isRegularFile(file) || Files.isSymbolicLink(file)) return "";
        return sha256(file);
    }

    private static String pixelSha256(BufferedImage image) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update((image.getWidth() + "x" + image.getHeight() + "|").getBytes(StandardCharsets.UTF_8));
        int[] pixels = image.getRGB(0, 0, image.getWidth(), image.getHeight(), null, 0, image.getWidth());
        for (int pixel : pixels) {
            digest.update((byte) (pixel >>> 24));
            digest.update((byte) (pixel >>> 16));
            digest.update((byte) (pixel >>> 8));
            digest.update((byte) pixel);
        }
        return java.util.HexFormat.of().formatHex(digest.digest());
    }

    private static String sha256Lines(Iterable<String> lines) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (String line : lines) {
            digest.update(line.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) '\n');
        }
        return java.util.HexFormat.of().formatHex(digest.digest());
    }

    private static String stateSignature(int mapWidth, int mapHeight, Iterable<String> tileLines,
                                         Iterable<String> unitLines, Point origin, java.awt.Dimension viewport,
                                         float scaleFactor, Object focus, String uiState) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update((mapWidth + "x" + mapHeight + "|" + invoke(focus, "getX") + "," + invoke(focus, "getY")
                + "|" + origin.x + "," + origin.y + "|" + viewport.width + "x" + viewport.height + "|" + scaleFactor
                + "|panels=" + latestVisibleFreeColPanelCount + "|ui=" + uiState + "\n")
                .getBytes(StandardCharsets.UTF_8));
        for (String line : tileLines) {
            digest.update(line.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) '\n');
        }
        for (String line : unitLines) {
            digest.update(line.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) '\n');
        }
        return java.util.HexFormat.of().formatHex(digest.digest());
    }

    private static String integerMapJson(Map<String, Integer> counts) {
        List<String> entries = new ArrayList<>();
        for (Map.Entry<String, Integer> entry : counts.entrySet()) {
            entries.add(quote(entry.getKey()) + ":" + entry.getValue());
        }
        return "{" + String.join(",", entries) + "}";
    }

    private static String quotedList(List<String> values) {
        List<String> quoted = new ArrayList<>();
        for (String value : values) quoted.add(quote(value));
        return String.join(",", quoted);
    }

    private static Rectangle alphaBounds(BufferedImage image) {
        if (image == null) return null;
        int minX = image.getWidth(), minY = image.getHeight(), maxX = -1, maxY = -1;
        for (int y = 0; y < image.getHeight(); y++) {
            for (int x = 0; x < image.getWidth(); x++) {
                if ((image.getRGB(x, y) >>> 24) != 0) {
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                }
            }
        }
        return maxX < minX ? null : new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
    }

    private static Method findDeclaredMethod(Class<?> type, String name, Class<?>... parameterTypes) throws NoSuchMethodException {
        for (Class<?> cursor = type; cursor != null; cursor = cursor.getSuperclass()) {
            try {
                Method method = cursor.getDeclaredMethod(name, parameterTypes);
                method.setAccessible(true);
                return method;
            } catch (NoSuchMethodException ignored) {
                // Continue through the class hierarchy using the exact verified parameter types.
            }
        }
        throw new NoSuchMethodException(type.getName() + "." + name + " with verified parameter types");
    }

    private static Object invokeDeclared(Object target, String name) throws Exception {
        Method method = findDeclaredMethod(target.getClass(), name);
        return method.invoke(target);
    }

    private static Object invoke(Object target, String name) throws Exception {
        if (target == null) throw new IllegalStateException("null receiver for method " + name);
        return target.getClass().getMethod(name).invoke(target);
    }

    private static Object invoke(Object target, String name, Class<?>[] parameterTypes, Object... arguments) throws Exception {
        if (target == null) throw new IllegalStateException("null receiver for method " + name);
        return target.getClass().getMethod(name, parameterTypes).invoke(target, arguments);
    }

    private static Object field(Object target, String name) throws Exception {
        if (target == null) throw new IllegalStateException("null receiver for field " + name);
        for (Class<?> cursor = target.getClass(); cursor != null; cursor = cursor.getSuperclass()) {
            try {
                Field field = cursor.getDeclaredField(name);
                field.setAccessible(true);
                return field.get(target);
            } catch (NoSuchFieldException ignored) {
                // Continue through the class hierarchy.
            }
        }
        throw new NoSuchFieldException(target.getClass().getName() + "." + name);
    }

    private static String rectangleJson(Rectangle rectangle) {
        if (rectangle == null) return "null";
        return "{\"x\":" + rectangle.x + ",\"y\":" + rectangle.y + ",\"width\":" + rectangle.width + ",\"height\":" + rectangle.height + "}";
    }

    private static String quote(String value) {
        StringBuilder result = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (current == '"' || current == '\\') result.append('\\').append(current);
            else if (current == '\n') result.append("\\n");
            else if (current == '\r') result.append("\\r");
            else if (current == '\t') result.append("\\t");
            else if (current < 0x20) result.append(String.format("\\u%04x", (int) current));
            else result.append(current);
        }
        return result.append('"').toString();
    }

    private static String errorStackJson(Throwable error) {
        List<String> frames = new ArrayList<>();
        for (StackTraceElement element : error.getStackTrace()) {
            if (frames.size() >= 20) break;
            frames.add(quote(element.getClassName() + "." + element.getMethodName() + ":" + element.getLineNumber()));
        }
        return String.join(",", frames);
    }

    private static String sha256(Path file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (var input = Files.newInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) digest.update(buffer, 0, count);
        }
        return java.util.HexFormat.of().formatHex(digest.digest());
    }

    private static void writeAtomically(Path output, String content) throws IOException {
        Path temporary = output.resolveSibling(output.getFileName() + ".part");
        Files.writeString(temporary, content, StandardCharsets.UTF_8);
        Files.move(temporary, output, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
    }
}
