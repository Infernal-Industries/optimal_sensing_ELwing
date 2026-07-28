import * as THREE from "three";
import { divergingColor, sequentialColor, firingIndicatorColor } from "./colormap.js";
import { computePFireAll } from "./encoding.js";
import { sensorIndexToChordSpan } from "./data.js";

// Deform values are in the Euler-Lagrange model's native units (cm-scale
// displacements on a wing a few cm across) -- real bending amplitude is
// small relative to wing size, as is physically expected. This is a visual
// exaggeration factor (not a physical unit conversion) so bending is
// legible; auto-derived per dataset in buildWingMesh() from the actual
// max|deform| rather than hardcoded, since different stiffness/axis
// combinations will have very different real amplitudes (Phase 5+).
const TARGET_BEND_FRACTION_OF_SPAN = 0.22;

const CONDITION_LABELS = { flap: "flapping only", rotate: "flapping + rotation" };

// Per-wing rotation (dragging turns each wing about its own center, not an
// orbit around the shared scene). Radians per pixel of drag, and a pitch
// clamp so the wing can't flip past vertical (which would read as broken
// lighting/labels, not "rotated").
const ROTATE_SENSITIVITY = 0.008;
const PITCH_LIMIT = Math.PI / 6; // ±30°
const CLICK_MOVE_THRESHOLD = 5; // px -- below this, pointerup is a click, not the end of a drag
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.2;

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
 * @param {{onFrame?: (frameIdx:number, timeMs:number) => void,
 *   onSelectSensor?: (sensorIdx1:number) => void}} [opts] -
 *   onFrame is invoked once per rendered (or, while hidden, per advanced)
 *   frame with the current animation frame index and the elapsed time (ms)
 *   within the wingbeat, so callers (timelines.js's playhead, wing2d.js's
 *   setFrame) can stay in sync without polling, even while this view isn't
 *   the one currently shown (see setVisible).
 * @returns {{dispose: () => void, setColorMode: (mode:'strain'|'pfire') => void,
 *   setThreshold: (nldGrad:number, nldShift:number, staFreq:number) => void,
 *   setSpeed: (multiplier:number) => void, setSensorCount: (n:number) => void,
 *   setVisible: (v:boolean) => void, resize: () => void}}
 */
export function createWingScene(container, manifest, payload, opts = {}) {
  const { chordElements, spanElements, chord_mm: chordMm, span_mm: spanMm } = manifest.grid;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);

  // Deliberate 3/4 angle: deform (bend) is applied along Z, so the camera
  // must NOT look straight down -Z (a near-face-on view like (0, y, largeZ)
  // foreshortens Z-motion to nearly nothing on screen -- this was the Phase 1
  // bug caught by the screenshot check). A large X offset keeps the bend axis
  // clearly transverse to the view direction. The camera is now fixed in
  // world space (rotation is per-wing, not an orbit) -- only its DISTANCE
  // along this same direction changes, in resize()/wheel-zoom, to keep both
  // wings framed at any panel aspect ratio.
  const camDir = new THREE.Vector3(1.5, 1.1, 1.6).normalize();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  const target = new THREE.Vector3(0, spanMm * 0.5, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  container.appendChild(renderer.domElement);

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
  function recomputePFire(nldGrad, nldShift, staFreq) {
    pfireByCondition = {};
    for (const cond of ["flap", "rotate"]) {
      pfireByCondition[cond] = computePFireAll(
        payload.conditions[cond].strain,
        manifest.encoding,
        nldGrad,
        nldShift,
        staFreq
      );
    }
  }
  recomputePFire(manifest.encoding.nldGrad, manifest.encoding.nldShift, manifest.encoding.staFreq);

  // gap widened vs the old orbit-camera layout (was chordMm*1.8): pivoting
  // each wing about its own mid-span means it sweeps a radius of
  // sqrt((chordMm/2)^2 + (spanMm/2)^2) as it turns, which at the old gap
  // would make the two wings interpenetrate at combined yaw+pitch.
  const gap = spanMm * 1.1;
  const conditions = ["flap", "rotate"];
  const pivots = {};
  const meshes = {};
  const labels = {};
  const sensorMarkers = {}; // cond -> array of {mesh, chordIdx, spanIdx, sensorIdx1, rank}
  const pickables = []; // every mesh (wing + marker) raycast checks against

  // Shared geometry/material template for optimal-sensor markers. Per
  // Requirements.pdf Req #1, these ALWAYS show live P(fire) (bright =
  // firing) regardless of the wing mesh's own strain/P(fire) color-mode
  // toggle -- that toggle only affects the full-mesh heatmap.
  const markerGeometry = new THREE.SphereGeometry(chordMm * 0.06, 12, 12);

  conditions.forEach((cond, i) => {
    // Pivot at mid-span, mesh offset -spanMm/2 inside it -- world-space
    // vertex/marker positions are IDENTICAL to before (the offsets cancel),
    // so applyFrame()'s geometry/marker math below needs no changes at all.
    // Rotating the pivot turns the wing about its own center; the pivot's
    // own X offset (not the mesh's) now carries the side-by-side placement.
    const pivot = new THREE.Group();
    pivot.position.set((i - 0.5) * gap, spanMm * 0.5, 0);
    pivot.rotation.order = "YXZ"; // yaw applied before pitch -- avoids a tumbling/trackball feel
    scene.add(pivot);
    pivots[cond] = pivot;

    const geometry = buildWingGeometry(chordElements, spanElements, chordMm, spanMm);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      metalness: 0.05,
      roughness: 0.8,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = -spanMm * 0.5;
    pivot.add(mesh);
    meshes[cond] = mesh;
    pickables.push(mesh);

    const label = document.createElement("div");
    label.textContent = CONDITION_LABELS[cond];
    label.style.cssText =
      "position:absolute;top:0;left:0;color:#c3c2b7;font:0.8rem system-ui,sans-serif;pointer-events:none;";
    container.appendChild(label);
    labels[cond] = label;

    sensorMarkers[cond] = payload.optimalSensors.top10.map((sensorIdx1, rank) => {
      const { chordIdx, spanIdx } = sensorIndexToChordSpan(sensorIdx1, chordElements);
      const markerMesh = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      markerMesh.userData.sensorIdx1 = sensorIdx1;
      mesh.add(markerMesh); // child of the wing mesh -> inherits its rotation/position automatically
      pickables.push(markerMesh);
      return { mesh: markerMesh, chordIdx, spanIdx, sensorIdx1, rank };
    });
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
    // Bending changes posAttr every frame, but Mesh.raycast only computes
    // boundingSphere once (lazily, if null) and never invalidates it --
    // without this, wingtip picks silently miss once bend pushes tip
    // vertices outside the frame-0 sphere.
    mesh.geometry.computeBoundingSphere();

    const MARKER_SURFACE_OFFSET = chordMm * 0.03; // lift slightly off the surface to avoid z-fighting
    for (const marker of sensorMarkers[cond]) {
      if (!marker.mesh.visible) continue;
      const x = (marker.chordIdx / (chordElements - 1) - 0.5) * chordMm;
      const y = (marker.spanIdx / (spanElements - 1)) * spanMm;
      const z = deformFrame[marker.chordIdx][marker.spanIdx] * bendScale + MARKER_SURFACE_OFFSET;
      marker.mesh.position.set(x, y, z);
      // Always P(fire)-colored (Requirements.pdf Req #1), independent of
      // the wing mesh's own strain/P(fire) colorMode toggle.
      const [r, g, b] = firingIndicatorColor(pfire[marker.sensorIdx1 - 1][strainFrameIdx]);
      marker.mesh.material.color.setRGB(r, g, b);
    }
  }

  // --- Camera framing: fixed direction, distance re-derived on resize/zoom
  // so both wings stay in frame at any panel aspect ratio (a fixed camera
  // position, as this scene used to have when it always filled the full
  // viewport width, crops the wings once the panel narrows to half-width).
  let zoom = 1;
  const sceneRadius = Math.sqrt((gap * 0.5 + chordMm * 0.5) ** 2 + (spanMm * 0.5) ** 2) * 1.15;
  function placeCamera() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    const vFov = (camera.fov * Math.PI) / 180;
    const aspect = w / h;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const limitingFov = Math.min(vFov, hFov);
    const fitDist = sceneRadius / Math.sin(limitingFov / 2);
    camera.position.copy(target).addScaledVector(camDir, fitDist / zoom);
    camera.lookAt(target);
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return; // container hidden (display:none) or not yet laid out -- avoid aspect=Infinity/NaN
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    placeCamera();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  function updateLabelPositions() {
    if (!container.clientWidth || !container.clientHeight) return;
    conditions.forEach((cond) => {
      const worldPos = new THREE.Vector3(pivots[cond].position.x, spanMm * 1.02, 0);
      worldPos.project(camera);
      const x = (worldPos.x * 0.5 + 0.5) * container.clientWidth;
      const y = (-worldPos.y * 0.5 + 0.5) * container.clientHeight;
      labels[cond].style.transform = `translate(${x - 60}px, ${y}px)`;
    });
  }

  // --- Per-wing rotation (drag) + click-to-pick + wheel-zoom, replacing
  // OrbitControls (which orbited the camera around the whole scene).
  let yaw = 0;
  let pitch = 0;
  let dragging = false;
  let downX = 0;
  let downY = 0;

  function applyRotation() {
    for (const cond of conditions) {
      pivots[cond].rotation.y = yaw;
      pivots[cond].rotation.x = pitch;
    }
    if (opts.onRotate) opts.onRotate(yaw, pitch);
  }

  const raycaster = new THREE.Raycaster();
  function pickAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    // recursive:false -- markers are mesh children, and a recursive
    // intersectObjects would otherwise return the MARKER's own face indices
    // (a small sphere geometry) as if they were wing-surface hits. Both wing
    // meshes and marker meshes are listed explicitly in `pickables` instead,
    // so a direct marker hit is detected and handled as an exact pick.
    const hits = raycaster.intersectObjects(pickables, false);
    if (!hits.length) return;
    const hit = hits[0];
    if (hit.object.userData.sensorIdx1 !== undefined) {
      if (opts.onSelectSensor) opts.onSelectSensor(hit.object.userData.sensorIdx1);
      return;
    }
    // Wing-surface hit: snap to the nearest of the hit triangle's 3 vertices,
    // then convert vertex index -> grid index -> data/MATLAB sensor index.
    // These are two genuinely different flattening conventions (see the
    // comment in applyFrame above): the vertex buffer is span-fastest
    // (idx = ci*spanElements + si), the data/MATLAB one is chord-fastest
    // (sensorIdx0 = si*chordElements + ci).
    const mesh = hit.object;
    const posAttr = mesh.geometry.getAttribute("position");
    const local = mesh.worldToLocal(hit.point.clone());
    let bestIdx = hit.face.a;
    let bestDist = Infinity;
    for (const vIdx of [hit.face.a, hit.face.b, hit.face.c]) {
      const dx = posAttr.getX(vIdx) - local.x;
      const dy = posAttr.getY(vIdx) - local.y;
      const dz = posAttr.getZ(vIdx) - local.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = vIdx;
      }
    }
    const ci = Math.floor(bestIdx / spanElements);
    const si = bestIdx % spanElements;
    const sensorIdx1 = si * chordElements + ci + 1;
    if (opts.onSelectSensor) opts.onSelectSensor(sensorIdx1);
  }

  function onPointerDown(ev) {
    dragging = true;
    downX = ev.clientX;
    downY = ev.clientY;
    renderer.domElement.setPointerCapture(ev.pointerId);
  }
  function onPointerMove(ev) {
    if (!dragging) return;
    yaw += (ev.movementX || 0) * ROTATE_SENSITIVITY;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch + (ev.movementY || 0) * ROTATE_SENSITIVITY));
    applyRotation();
  }
  function onPointerUp(ev) {
    if (!dragging) return;
    dragging = false;
    const totalMove = Math.hypot(ev.clientX - downX, ev.clientY - downY);
    if (totalMove < CLICK_MOVE_THRESHOLD) pickAt(ev.clientX, ev.clientY);
  }
  function onWheel(ev) {
    ev.preventDefault();
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * (1 - ev.deltaY * 0.001)));
    placeCamera();
  }

  renderer.domElement.style.cursor = "grab";
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

  // payload.period_ms is ONE REAL WINGBEAT (e.g. 40ms at flapFrequency=25Hz --
  // a real hawkmoth's actual flap rate). Playing that back at real speed is a
  // blur to human eyes and reads as a static shape, which is what was
  // reported when this was still fixed. BASE_SLOW_MOTION_FACTOR is the 1x
  // baseline (one wingbeat ~3s); speedMultiplier is the live Phase 4 control
  // (Plan §7: continuous x0.1-x5), applied as a divisor so higher = faster.
  const BASE_SLOW_MOTION_FACTOR = 75; // 40ms * 75 ≈ 3s per wingbeat at 1x
  let speedMultiplier = 1;

  let frameIdx = 0;
  let acc = 0;
  let lastT = performance.now();
  let visible = true;

  let running = true;
  function animate(t) {
    if (!running) return;
    const dt = t - lastT;
    lastT = t;
    acc += dt;
    const msPerFrame = (payload.period_ms / payload.frames) * (BASE_SLOW_MOTION_FACTOR / speedMultiplier);
    while (acc >= msPerFrame) {
      acc -= msPerFrame;
      frameIdx = (frameIdx + 1) % payload.frames;
    }
    // The rAF loop is the app's shared animation clock (drives wing2d.js's
    // setFrame + timelines.js's playhead via opts.onFrame) even while this
    // view isn't the one currently shown -- so frameIdx/onFrame keep
    // advancing regardless of `visible`, only the expensive per-vertex
    // geometry update + WebGL render are skipped.
    if (visible) {
      conditions.forEach((cond) => applyFrame(cond, frameIdx));
      updateLabelPositions();
      renderer.render(scene, camera);
    }
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
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.dispose();
      Object.values(labels).forEach((l) => l.remove());
      renderer.domElement.remove();
    },
    setColorMode(mode) {
      colorMode = mode;
    },
    setThreshold(nldGrad, nldShift, staFreq) {
      recomputePFire(nldGrad, nldShift, staFreq);
    },
    setSpeed(multiplier) {
      speedMultiplier = multiplier;
    },
    setSensorCount(n) {
      for (const cond of conditions) {
        for (const marker of sensorMarkers[cond]) {
          marker.mesh.visible = marker.rank < n;
        }
      }
    },
    setRotation(newYaw, newPitch) {
      yaw = newYaw;
      pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, newPitch));
      applyRotation();
    },
    setVisible(v) {
      visible = v;
      if (v) {
        resize();
        conditions.forEach((cond) => applyFrame(cond, frameIdx));
        updateLabelPositions();
      }
    },
    resize,
  };
}
