// Hover tilt for the header token with lighting that follows the angle.
// Each frame: face normal N from the current rotation; Lambert diffuse sets the face
// brightness, Blinn–Phong sets the specular spot (which slides opposite the tilt),
// and the exposed edge is lit on the side that faces the light. A damped spring
// drives the angle; the loop stops as soon as it settles.

const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Screen space: x right, y down, z toward the viewer. Light from the top left, in front.
const L = norm([-0.55, -0.65, 0.75]);
const V = [0, 0, 1];
const Hv = norm([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
const SHININESS = 18; // broad, bright highlight like polished copper
const REST = { ry: 0, rx: 0 };
const HOVER = { ry: -6, rx: 18 }; // flips up a little, toward the top-left light

function normalFor(ryDeg, rxDeg) {
  // CSS rotateY(a) rotateX(b) applied to (0, 0, 1)
  const a = (ryDeg * Math.PI) / 180, b = (rxDeg * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(b), -Math.sin(b), Math.cos(a) * Math.cos(b)];
}

function lighting(ry, rx) {
  const N = normalFor(ry, rx);
  const diffuse = Math.max(0, dot(N, L)) / L[2]; // 1 at rest
  const spec = Math.pow(Math.max(0, dot(N, Hv)), SHININESS);
  const spec0 = Math.pow(Hv[2], SHININESS);
  // Exposed edge faces away from the tilt; it is lit when that side faces the light.
  const t = Math.hypot(N[0], N[1]);
  const edgeLit = t > 1e-3 ? Math.max(0, dot([-N[0] / t, -N[1] / t, 0], L)) : 0;
  return {
    face: Math.min(1.3, 0.6 + 0.4 * diffuse + 0.12 * Math.max(0, spec / spec0 - 1) / 5),
    specA: Math.min(1, 0.22 * (spec / spec0)),
    specX: 30 - N[0] * 120, // % across the coin; the spot slides opposite the tilt
    specY: 26 - N[1] * 120,
    edge: 0.4 + 0.75 * edgeLit,
  };
}

const SLICES = 10;
const THICKNESS = 0.09; // of the coin diameter, like a real token
const CAMERA = 6; // perspective distance in coin diameters (a normal lens, no fish-eye)

export function initLogoFx(brand) {
  const token = brand?.querySelector('.logo-token');
  if (!token) return;
  // The edge: discs stacked along Z behind the face form a true cylinder.
  const edge = token.querySelector('.coin-edge');
  edge.innerHTML = Array.from({ length: SLICES }, () => '<i></i>').join('');
  const size = () => {
    const d = edge.firstElementChild.offsetWidth || 18; // layout size, unaffected by the tilt
    token.style.setProperty('--persp', `${(d * CAMERA).toFixed(1)}px`);
    [...edge.children].forEach((el, i) => el.style.setProperty('--z', `${(-(i + 1) / SLICES * d * THICKNESS).toFixed(2)}px`));
  };
  size();
  new ResizeObserver(size).observe(brand);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const state = { ry: 0, rx: 0, vy: 0, vx: 0, target: REST, raf: 0, last: 0 };

  const apply = () => {
    const l = lighting(state.ry, state.rx);
    const st = token.style;
    st.setProperty('--ry', `${state.ry.toFixed(2)}deg`);
    st.setProperty('--rx', `${state.rx.toFixed(2)}deg`);
    st.setProperty('--face', l.face.toFixed(3));
    st.setProperty('--edge', l.edge.toFixed(3));
    st.setProperty('--spec-a', l.specA.toFixed(3));
    st.setProperty('--spec-x', `${l.specX.toFixed(1)}%`);
    st.setProperty('--spec-y', `${l.specY.toFixed(1)}%`);
  };

  const step = (now) => {
    const dt = Math.min(0.05, (now - (state.last || now)) / 1000) || 1 / 60;
    state.last = now;
    // Slightly under-damped spring: a small, natural settle.
    const k = 120, c = 17;
    state.vy += (k * (state.target.ry - state.ry) - c * state.vy) * dt;
    state.vx += (k * (state.target.rx - state.rx) - c * state.vx) * dt;
    state.ry += state.vy * dt;
    state.rx += state.vx * dt;
    apply();
    const settled =
      Math.abs(state.target.ry - state.ry) < 0.02 && Math.abs(state.target.rx - state.rx) < 0.02 &&
      Math.abs(state.vy) < 0.05 && Math.abs(state.vx) < 0.05;
    if (settled) {
      state.ry = state.target.ry;
      state.rx = state.target.rx;
      state.vy = state.vx = 0;
      apply();
      state.raf = 0;
      state.last = 0;
      return; // stop: no frame loop while idle
    }
    state.raf = requestAnimationFrame(step);
  };

  const go = (target) => {
    state.target = reduce.matches ? REST : target;
    if (!state.raf) state.raf = requestAnimationFrame(step);
  };

  brand.addEventListener('pointerenter', () => go(HOVER));
  brand.addEventListener('pointerleave', () => go(REST));
  brand.addEventListener('focus', () => go(HOVER));
  brand.addEventListener('blur', () => go(REST));
  apply();
}
