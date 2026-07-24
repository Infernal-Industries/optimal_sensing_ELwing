import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { divergingColor, sequentialColor } from "./colormap.js";
import { computePFireAll } from "./encoding.js";

// Deform values are in the Euler-Lagrange model's native units (cm-scale
// displacements on a wing a few cm across) -- real bending amplitude is
// small relative to wing size, as is physically expected. This is a visual
// exaggeration factor (not a physical unit conversion) so bending is
// legible; auto-derived per dataset in buildWingMesh() from the actual
// max|deform| rather than hardcoded, since different stiffness/axis
// combinations will have very different real amplitudes (Phase 5+).
const TARGET_BEND_FRACTION_OF_SPAN = 0.22;

const CONDITION_LABELS = { flap: "flapping only", rotate: "flapping + rotation" };

function buildWingGeometry(chordElements, spanElements, chordMm, spanMm) {
  const geometry = new THREE.BufferGeometry();
  const nVerts = chordElements * spanElements;
  const positions = new Float32Array(nVerts * 3);

  for (let ci = 0; ci < chordElements; ci++) {
    for (let si = 0; si < spanElements; si++) {
      const idx = ci * spanElements + si;
      const x = (ci / (chordElements - 1) - 0.5) * chordMm;
      const y = (si / (spanElements - 1)) * spanMm;
      positions[idx * 3 + 0] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = 0;
    }
  }

  const indices = [];
  for (let ci = 0; ci < chordElements - 1; ci++) {
    for (let si = 0; si < spanElements - 1; si++) {
      const a = ci * spanElements + si;
      const b = a + 1;
      const c = a + spanElements;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(nVerts * 3), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function maxAbsDeform(payload) {
  let m = 0;
  for (const cond of ["flap", "rotate"]) {
    for (const frame of payload.conditions[cond].deform) {
      for (const row of frame) {
        for (const v of row) if (Math.abs(v) > m) m = Math.abs(v);
      }
    }
  }
  return m || 1;
}

function maxAbsStrain(payload) {
  let m = 0;
  for (const cond of ["flap", "rotate"]) {
    for (const sensor of payload.conditions[cond].strain) {
      for (const v of sensor) if (Math.abs(v) > m) m = Math.abs(v);
    }
  }
  return m || 1;
}

/**
 * Builds the two-condition (flap-only / flap+rotate) 3D wing scene.
 * @param {HTMLElement} container
 * @param {object} manifest - validated manifest.json
 * @param {object} payload - validated set_*.json payload
 * @param {{onFrame?: (frameIdx:number, timeMs:number) => void}} [opts] -
 *   onFrame is invoked once per rendered frame with the current animation
 *   frame index and the elapsed time (ms) within the wingbeat, so callers
 *   (timelines.js's playhead) can stay in sync without polling.
 * @returns {{dispose: () => void, setColorMode: (mode:'strain'|'pfire') => void, setThreshold: (nldGrad:number, nldShift:number) => void}}
 */
export function createWingScene(container, manifest, payload, opts = {}) {
  const { chordElements, spanElements, chord_mm: chordMm, span_mm: spanMm } = manifest.grid;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);

  // Deliberate 3/4 angle: deform (bend) is applied along Z, so the camera
  // must NOT look straight down -Z (a near-face-on view like
  // (0, y, largeZ) foreshortens Z-motion to nearly nothing on screen --
  // this was the Phase 1 bug caught by the screenshot check). A large X
  // offset keeps the bend axis clearly transverse to the view direction.
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  camera.position.set(spanMm * 1.5, spanMm * 1.1, spanMm * 1.6);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, spanMm * 0.4, 0);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(1, 1, 1);
  scene.add(dirLight);

  const bendScale = (TARGET_BEND_FRACTION_OF_SPAN * spanMm) / maxAbsDeform(payload);
  const strainBound = maxAbsStrain(payload);

  // P(fire) recomputation is cheap enough (~1300 sensors x ~40 conv taps x 2
  // conditions) to redo whenever the threshold changes, but NOT cheap enough
  // to redo every rendered frame (~60fps) -- so it's precomputed here (and
  // on every setThreshold call) into a plain [sensorIdx][frame] array per
  // condition, and the per-frame render loop below just indexes into it,
  // the same pattern already used for strain/deform.
  let colorMode = "strain"; // 'strain' | 'pfire'
  let pfireByCondition = {};
  function recomputePFire(nldGrad, nldShift) {
    pfireByCondition = {};
    for (const cond of ["flap", "rotate"]) {
      pfireByCondition[cond] = computePFireAll(
        payload.conditions[cond].strain,
        manifest.encoding,
        nldGrad,
        nldShift
      );
    }
  }
  recomputePFire(manifest.encoding.nldGrad, manifest.encoding.nldShift);

  const gap = chordMm * 1.8;
  const conditions = ["flap", "rotate"];
  const meshes = {};
  const labels = {};

  conditions.forEach((cond, i) => {
    const geometry = buildWingGeometry(chordElements, spanElements, chordMm, spanMm);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      metalness: 0.05,
      roughness: 0.8,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = (i - 0.5) * gap;
    scene.add(mesh);
    meshes[cond] = mesh;

    const label = document.createElement("div");
    label.textContent = CONDITION_LABELS[cond];
    label.style.cssText =
      "position:absolute;top:0;left:0;color:#c3c2b7;font:0.8rem system-ui,sans-serif;pointer-events:none;";
    container.appendChild(label);
    labels[cond] = label;
  });

  function applyFrame(cond, frameIdx) {
    const mesh = meshes[cond];
    const posAttr = mesh.geometry.getAttribute("position");
    const colorAttr = mesh.geometry.getAttribute("color");
    const deformFrame = payload.conditions[cond].deform[frameIdx];
    // strain/pfire share the same (post-convolution) index space -- both
    // are payload.strainFrames long -- so one index maps to both.
    const strainFrameIdx = Math.floor((frameIdx * payload.strainFrames) / payload.frames);
    const strain = payload.conditions[cond].strain;
    const pfire = pfireByCondition[cond];

    for (let ci = 0; ci < chordElements; ci++) {
      for (let si = 0; si < spanElements; si++) {
        const idx = ci * spanElements + si;
        posAttr.setZ(idx, deformFrame[ci][si] * bendScale);
        // MATLAB flattens strain via `strainy(:,:)` -- column-major over
        // (chordElements, spanElements), i.e. chordElements varies fastest.
        // Matches ind2sub([chordElements,spanElements],...) used elsewhere
        // in the codebase (plotSensorLocation.m, exportForViz.m). NOT the
        // same order as `idx` above, which is this file's own vertex-buffer
        // convention (span fastest) -- these two indices are independent.
        const sensorIdx = si * chordElements + ci;
        const [r, g, b] =
          colorMode === "pfire"
            ? sequentialColor(pfire[sensorIdx][strainFrameIdx])
            : divergingColor(strain[sensorIdx][strainFrameIdx], strainBound);
        colorAttr.setXYZ(idx, r, g, b);
      }
    }
    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  function updateLabelPositions() {
    conditions.forEach((cond) => {
      const mesh = meshes[cond];
      const worldPos = new THREE.Vector3(mesh.position.x, spanMm * 1.02, 0);
      worldPos.project(camera);
      const x = (worldPos.x * 0.5 + 0.5) * container.clientWidth;
      const y = (-worldPos.y * 0.5 + 0.5) * container.clientHeight;
      labels[cond].style.transform = `translate(${x - 60}px, ${y}px)`;
    });
  }

  // payload.period_ms is ONE REAL WINGBEAT (e.g. 40ms at flapFrequency=25Hz --
  // a real hawkmoth's actual flap rate). Playing that back at real speed is a
  // blur to human eyes and reads as a static shape, which is what was
  // reported. This slow-motion factor is a Phase 1 fixed default only --
  // Phase 4 (§7/§11) makes this an actual user-facing speed control; until
  // then, stretch one wingbeat to roughly 3 real seconds so the bending is
  // actually visible.
  const SLOW_MOTION_FACTOR = 75; // 40ms * 75 ≈ 3s per wingbeat

  let frameIdx = 0;
  let acc = 0;
  let lastT = performance.now();
  const msPerFrame = (payload.period_ms / payload.frames) * SLOW_MOTION_FACTOR;

  let running = true;
  function animate(t) {
    if (!running) return;
    const dt = t - lastT;
    lastT = t;
    acc += dt;
    while (acc >= msPerFrame) {
      acc -= msPerFrame;
      frameIdx = (frameIdx + 1) % payload.frames;
    }
    conditions.forEach((cond) => applyFrame(cond, frameIdx));
    controls.update();
    updateLabelPositions();
    renderer.render(scene, camera);
    if (opts.onFrame) {
      // Real (non-slow-motion) time within the wingbeat, matching
      // payload.period_ms / strain sample spacing -- so timelines.js's
      // playhead (drawn on a real-ms x-axis) stays in sync with what the
      // 3D scene is currently showing, independent of SLOW_MOTION_FACTOR.
      const realTimeMs = (frameIdx / payload.frames) * payload.period_ms;
      opts.onFrame(frameIdx, realTimeMs);
    }
    requestAnimationFrame(animate);
  }
  conditions.forEach((cond) => applyFrame(cond, 0));
  requestAnimationFrame(animate);

  return {
    dispose() {
      running = false;
      window.removeEventListener("resize", resize);
      renderer.dispose();
      Object.values(labels).forEach((l) => l.remove());
      renderer.domElement.remove();
    },
    setColorMode(mode) {
      colorMode = mode;
    },
    setThreshold(nldGrad, nldShift) {
      recomputePFire(nldGrad, nldShift);
    },
  };
}
