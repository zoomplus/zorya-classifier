package zorya.mapprobe;

/** Checks the optional pre-game nation-selection start gate without loading a game UI. */
public final class FreeColNationSelectionFixture {
    private FreeColNationSelectionFixture() {}

    public static void main(String[] arguments) {
        check(FreeColProbe.nationSelectionShouldAttempt(true, false), "requested selection is attempted");
        check(!FreeColProbe.nationSelectionShouldAttempt(true, true), "selection is attempted only once");
        check(!FreeColProbe.nationSelectionShouldAttempt(false, false), "legacy default skips selection");
        check(!FreeColProbe.nationSelectionAllowsStart(true, false, false), "start waits for attempt");
        check(!FreeColProbe.nationSelectionAllowsStart(true, true, false), "start waits for observed confirmation");
        check(!FreeColProbe.nationSelectionAllowsStart(true, true, false), "mismatch or timeout keeps start withheld");
        check(FreeColProbe.nationSelectionAllowsStart(true, true, true), "matching player model permits normal start");
        check(FreeColProbe.nationSelectionAllowsStart(false, false, false), "legacy default preserves ordinary start");
        check(FreeColProbe.nationSelectionModelsMatch("model.nation.english", "model.nationType.immigration",
                "model.nation.english", "model.nationType.immigration",
                "model.nation.english", "model.nationType.immigration"), "client and server models confirm both requested IDs");
        check(!FreeColProbe.nationSelectionModelsMatch("model.nation.english", "model.nationType.immigration",
                "model.nation.french", "model.nationType.immigration",
                "model.nation.english", "model.nationType.immigration"), "client mismatch blocks confirmation");
        check(!FreeColProbe.nationSelectionModelsMatch("model.nation.english", "model.nationType.immigration",
                "model.nation.english", "model.nationType.immigration",
                "model.nation.english", "model.nationType.default"), "server mismatch blocks confirmation");
        check(FreeColProbe.nationSelectionStartIndex(new String[]{"receipt", "1000", "model.nation.english", "model.nationType.immigration"}) == 2,
                "selection-only agent arguments are decoded");
        check(FreeColProbe.nationSelectionStartIndex(new String[]{"receipt", "1000", "/tmp/save.fsg", "model.nation.english", "model.nationType.immigration"}) == 3,
                "launcher save-path-first argument layout is decoded");
        check(FreeColProbe.nationSelectionStartIndex(new String[]{"receipt", "1000", "bad", "bad", "bad"}) == -1,
                "unsafe agent arguments are rejected");
        check(!FreeColProbe.validAgentArgumentCount(6), "legacy malformed capture argument count is rejected");
        check(!FreeColProbe.validAgentArgumentCount(9), "nation selection cannot add unsupported capture fields");
        check(FreeColProbe.validAgentArgumentCount(2) && FreeColProbe.validAgentArgumentCount(3)
                && FreeColProbe.validAgentArgumentCount(7) && FreeColProbe.validAgentArgumentCount(8),
                "all legacy agent argument layouts remain accepted");
        System.out.println("nation-selection-fixtures: 17 passed");
    }

    private static void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label);
    }
}
