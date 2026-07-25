# Visualization layer

Interactive three.js visualization of the sensing pipeline in
`optimal_sensing_ELwing` (Weber, Daniel & Brunton 2021). Full design in
[`../LLM_context/VISUALIZATION_PLAN.md`](../LLM_context/VISUALIZATION_PLAN.md).

## Phase 0 — data bridge (✅ done, execution-verified)

Exports one schema-validation set from MATLAB and confirms the JS loader can
read it. This is the riskiest piece of Tier 1: capturing `deform` (which the
existing pipeline discards) and getting the JSON shapes right before any
front-end is built on top of them. Ran successfully end-to-end; see the
finding below on macOS/cvx before you try it yourself.

### macOS + Apple Silicon note: cvx needs an Intel MATLAB via Rosetta

**cvx (last updated 2020) only ships `x86_64` MEX solver binaries** — they
will not load in a native `arm64` MATLAB process on Apple Silicon Macs
(fails silently at `cvx_setup`/solve time, not at install time). If you're
on Apple Silicon:

1. Install a **second**, Intel-targeted MATLAB alongside your normal one.
   Recent MATLAB releases' default macOS download is Apple-Silicon-only —
   look for an older release (e.g. R2025b) that still offers a separate
   "macOS (Intel)" installer option.
2. Run `cvx_setup` and all cvx-dependent commands through that Intel copy,
   forced under Rosetta 2:
   ```bash
   arch -x86_64 /Applications/MATLAB_R2025b.app/bin/matlab -batch "..."
   ```
   (Rosetta 2 must be installed: `softwareupdate --install-rosetta`.)
3. `cvx_setup` saves cvx to that MATLAB's persistent path — no need to add
   it to the repo or re-run setup per session.

On Intel Macs, Linux, or Windows this isn't an issue — cvx's MEX binaries
already match those native architectures.

Also worth knowing: `license('test','Symbolic_Toolbox')` returns true if
your license merely *entitles* you to Symbolic Math Toolbox, even if the
toolbox files aren't actually installed. The real check is calling `syms x`
and seeing if it errors. If it does, install it via MATLAB's Home tab →
Add-Ons → Manage Add-Ons (no full reinstall needed).

### 1. Run the MATLAB export (quick mode)

From MATLAB, with the repo root (`optimal_sensing_ELwing/`) added to the
path (`addpath('visualization/export')`) and as the working directory (same
convention as `wing_sensors_main.m`), and with **cvx** installed and set up
(`cvx_setup`, see http://cvxr.com/cvx/ — and the Apple Silicon note above):

```matlab
cd optimal_sensing_ELwing            % repo root, not visualization/export
addpath('visualization/export')
exportForViz()   % quick mode (default): one set, yaw axis, stiffness factor 1
```

Or from the shell, on Apple Silicon:
```bash
cd optimal_sensing_ELwing
arch -x86_64 /Applications/MATLAB_R2025b.app/bin/matlab -batch \
  "addpath('visualization/export'); exportForViz()"
```

This writes `visualization/public/data/manifest.json`,
`set_E1.00_yaw.json`, and `set_E1.00_yaw_strain.bin`. **Quick-mode output is
for schema validation only** — it runs at reduced time resolution
(`sampFreq=1000`, ~5 wingbeats) for speed, so the resulting accuracy/sensor
numbers are not scientifically meaningful. It exists only to prove the
export pipeline and JSON/binary schema are correct end to end. Running it
overwrites the real Medium-grid data checked into the repo — regenerate the
full export (below) afterward, or `git checkout` the data directory to
restore it.

### 2. Validate the schema from the browser side

No build step needed for this check. From the `visualization/` directory:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/app/validate.html>. It loads
`public/data/manifest.json` and every set file through the same
`app/src/data.js` loader the real front-end will use later, and reports
pass/fail with descriptive errors on any shape mismatch.

(Serving over HTTP is required — `fetch()` of local JSON generally fails
under a bare `file://` URL.)

### The full export (Phase 5 — ✅ done, this is what's deployed)

```matlab
exportForViz('quick', false)   % Medium grid: 10 stiffness values × 3 axes = 30 sets
```

This is the real, scientifically valid dataset the deployed site ships —
full `sampFreq`/`simEnd` from `makeParameterStruct.m`, all three rotation
axes (`yaw`, `pitch`, `roll`), denser stiffness sampling near stiffness
factor 1 (`[0.7/3, 0.35, 0.5, 0.7, 0.85, 1.0, 1.15, 1.4, 2.0, 3.3]` — the
floor matches the Euler-Lagrange model's convergence limit, ~0.7 GPa). Each
set exports as a `set_<id>.json` (metadata, deform, optimal sensors,
accuracy) plus a `set_<id>_strain.bin` sidecar (native-resolution strain,
float32, see the Data delivery note below).

On the reference machine (M-series Mac, Intel MATLAB under Rosetta) this
took **~110s/set, ~55 minutes total** for all 30 sets — budget accordingly
if re-running.

## File layout

```
visualization/
├── export/
│   ├── exportForViz.m   # MATLAB: run the pipeline over a grid → JSON + binary strain sidecar (Tier 1)
│   └── runJob.m         # (Phase 6) MATLAB: single entry point for the GitHub Actions worker
├── app/
│   ├── validate.html    # Phase 0: schema-check page, no build step
│   └── src/
│       └── data.js      # loadManifest / loadSet / validateSetPayload — shared with later phases
└── public/data/         # exported JSON + binary strain sidecars (tracked in git, see below)
```

## Data delivery note

`visualization/public/data/` is **intentionally tracked in git, not
git-ignored** — continuous deployment (`VISUALIZATION_PLAN.md` §11) means
the live site needs data present from Phase 1 onward. It currently holds
the real Phase 5 Medium-grid export (30 sets, ~264 MB uncompressed on disk,
31 JSON files + 30 `.bin` sidecars, all well under GitHub's 100 MB
per-file limit so no Git LFS is needed).

**Finding from building Phase 0, resolved in Phase 5 — the plan's original
~30 MB gzipped estimate was too optimistic.** Two things the original
estimate didn't account for:

1. `strain` must ship at **native time resolution** (`sampFreq`, e.g. 400
   samples/wingbeat in full mode), not the coarse ~90-frame animation
   resolution — `encoding.js` (Phase 2) needs that resolution to
   reconvolve `manifest.encoding.staFilt` accurately. `deform` stays
   coarse (90 frames is fine, it's only for the visual wing shape).
2. JSON encodes floating-point numbers as **text** (~12 bytes/number),
   not raw 4-byte binary — a ~3x inflation the original estimate missed.

An all-JSON Medium-grid export (30 sets) would have been closer to
**~450 MB uncompressed**, not ~60 MB. Phase 5 fixed this by shipping
`strain` as a packed binary `Float32Array` `.bin` sidecar instead — each
`set_<id>.json` holds everything except strain (deform, optimal sensors,
accuracy) plus a `strainFile` pointer; `set_<id>_strain.bin` holds both
conditions' strain arrays back-to-back, sensor-major (each sensor's full
time series contiguous), written via `exportForViz.m`'s
`writeStrainBinary()` and reconstructed client-side as zero-copy
`Float32Array` views by `data.js`'s `loadSet()`/`reconstructStrain()`. This
brought the real export down to the actual **264 MB uncompressed**
committed to the repo.
