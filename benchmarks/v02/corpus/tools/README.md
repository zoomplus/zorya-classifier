# Controlled Geany capture harness

`geany-controlled-capture.py` runs a fresh Geany instance with a private XDG
profile, records its AT-SPI tree, and checks toolbar widget allocations against
the pixels from a single Xvfb screenshot. The harness injects a GTK CSS
provider after GTK initialization; the magenta outline is an oracle aid, not a
model input or a claim about the natural theme. It captures no user desktop,
microphone, or game state.

Run it inside an owned Xvfb and D-Bus session, giving it a new output path each
time:

```sh
dbus-run-session -- xvfb-run -a -s '-screen 0 1280x800x24' \
  python3 benchmarks/v02/corpus/tools/geany-controlled-capture.py \
  --output-dir .run/v02-geany-dev-oracle-YYYYMMDD-NN
```

The output directory must not already exist. The harness copies its driver,
CSS, and C shim into that directory, builds its private shim there, and writes
the screenshot and evidence without overwriting existing files. The current
annotated image and its source-geometry labels live in the ignored local cache;
the tracked manifest carries hashes and metadata only.
