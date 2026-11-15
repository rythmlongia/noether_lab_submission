/*
 * viewer.js - WebGL2 mesh viewer with orbit / pan / zoom and CPU picking.
 *
 * Why raw WebGL2 and not three.js: the whole renderer is one shader pair and four
 * vertex attributes, and it keeps the app dependency-free apart from Electron.
 *
 * Per-frame cost is constant: changing the time slider only changes one uniform
 * (uT), so dragging it never touches the 100k-vertex buffers. Changing snapshot
 * uploads one attribute of (value, valid) float pairs (bufferSubData, 2 x 4 B x 104,778 = ~0.84 MB).
 */
/* global AYRColor */
(function () {
  'use strict';

  const VS = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aNormal;
  layout(location=2) in vec2 aSolid;   // (value, valid)
  layout(location=3) in vec2 aTemp;    // (value, valid)
  uniform mat4 uMVP;
  uniform mat4 uView;
  out vec3 vNormalV;
  out vec2 vSolid;
  out vec2 vTemp;
  void main() {
    vNormalV = mat3(uView) * aNormal;
    vSolid = aSolid;
    vTemp = aTemp;
    gl_Position = uMVP * vec4(aPos, 1.0);
  }`;

  const FS = `#version 300 es
  precision highp float;
  in vec3 vNormalV;
  in vec2 vSolid;
  in vec2 vTemp;
  uniform int uMode;          // 0 = solidification time, 1 = temperature
  uniform bool uSliderOn;     // show "not yet solid at t"
  uniform float uT;
  uniform vec2 uSolidRange;
  uniform vec2 uTempRange;
  uniform sampler2D uLut;
  out vec4 outColor;
  const vec3 GREY = vec3(0.5);
  const vec3 LIQUID = vec3(1.0, 0.27, 0.16);
  vec3 cmap(float v, vec2 r) {
    float u = r.y > r.x ? clamp((v - r.x) / (r.y - r.x), 0.0, 1.0) : 0.5;
    return texture(uLut, vec2((u * 255.0 + 0.5) / 256.0, 0.5)).rgb;
  }
  void main() {
    vec3 c;
    if (uMode == 0) {
      // valid is 1 at computed vertices and 0 at "not computed" ones; any fragment that
      // is not fully inside computed vertices' influence is grey.
      if (vSolid.y < 0.999) c = GREY;
      else {
        c = cmap(vSolid.x, uSolidRange);
        if (uSliderOn) {
          if (vSolid.x > uT) c = LIQUID;                       // not yet fully solid at t
          else c = mix(vec3(0.82), c, 0.35);                   // already solid: faded
        }
      }
    } else {
      c = vTemp.y < 0.999 ? GREY : cmap(vTemp.x, uTempRange);
    }
    float shade = 0.40 + 0.60 * abs(normalize(vNormalV).z);   // head light, two-sided
    outColor = vec4(c * shade, 1.0);
  }`;

  // ---------------------------------------------------------------- tiny mat4 (column-major)
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function lookAt(eye, target, up) {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1]);
  }
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }

  class Viewer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: false });
      if (!gl) throw new Error('WebGL2 is not available on this machine.');
      this.gl = gl;
      this.prog = this._program(VS, FS);
      this.u = {};
      for (const n of ['uMVP', 'uView', 'uMode', 'uSliderOn', 'uT', 'uSolidRange', 'uTempRange', 'uLut']) this.u[n] = gl.getUniformLocation(this.prog, n);
      this.vao = gl.createVertexArray();
      this.buf = {};
      // colour lookup texture (256 x 1 RGBA)
      this.lut = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.lut);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, AYRColor.viridisRGBA());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.enable(gl.DEPTH_TEST);

      this.mesh = null;
      this.mode = 0; this.sliderOn = false; this.t = 0;
      this.solidRange = [0, 1]; this.tempRange = [0, 1];
      this.cam = { yaw: -0.9, pitch: 0.55, dist: 100, target: [0, 0, 0], radius: 50, fov: 35 * Math.PI / 180 };
      this.dirty = true;
      this.onFrame = null;      // callback(frameCpuMs) for the frame-time meter
      this.onPick = null;       // callback(vertexIndex | -1, hitPoint)
      this._installControls();
      new ResizeObserver(() => { this.dirty = true; }).observe(canvas);
      const loop = () => { if (this.dirty || this.continuous) this.draw(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }

    _program(vs, fs) {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    }

    _attr(name, loc, data, size, usage) {
      const gl = this.gl;
      if (!this.buf[name]) this.buf[name] = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf[name]);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }

    /** m: { gpuPos, normals, triangles, solidPairs (value,valid interleaved), radius } */
    setMesh(m) {
      const gl = this.gl;
      gl.bindVertexArray(this.vao);
      this._attr('pos', 0, m.gpuPos, 3);
      this._attr('nrm', 1, m.normals, 3);
      this._attr('solid', 2, m.solidPairs, 2);
      this._attr('temp', 3, new Float32Array(2 * m.nVert), 2, gl.DYNAMIC_DRAW);
      if (!this.buf.idx) this.buf.idx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.triangles, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.mesh = m;
      this.frame();
      this.dirty = true;
    }

    clear() { this.mesh = null; this.dirty = true; }

    setTemperaturePairs(pairs) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.temp);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pairs);
      this.dirty = true;
    }

    set(opts) { Object.assign(this, opts); this.dirty = true; }

    /** Put the whole part in view: distance so the bounding sphere fits the smaller field of view. */
    frame() {
      if (!this.mesh) return;
      const c = this.cam;
      c.target = [0, 0, 0];
      c.radius = this.mesh.radius;
      const aspect = Math.max(this.canvas.clientWidth, 1) / Math.max(this.canvas.clientHeight, 1);
      const fovMin = aspect >= 1 ? c.fov : 2 * Math.atan(Math.tan(c.fov / 2) * aspect);
      c.dist = (c.radius / Math.sin(fovMin / 2)) * 1.05;
      c.yaw = -0.9; c.pitch = 0.55;
      this.dirty = true;
    }

    _eye() {
      const c = this.cam;
      const cp = Math.cos(c.pitch);
      return [c.target[0] + c.dist * cp * Math.cos(c.yaw), c.target[1] + c.dist * cp * Math.sin(c.yaw), c.target[2] + c.dist * Math.sin(c.pitch)];
    }

    _matrices() {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      const c = this.cam;
      const near = Math.max(c.dist - 2 * c.radius, c.radius * 0.01), far = c.dist + 2 * c.radius;
      const proj = perspective(c.fov, w / Math.max(h, 1), near, far);
      const view = lookAt(this._eye(), c.target, [0, 0, 1]);
      return { proj, view, mvp: mul(proj, view) };
    }

    draw() {
      const t0 = performance.now();
      this.dirty = false;
      const gl = this.gl, cv = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      gl.viewport(0, 0, W, H);
      gl.clearColor(0.085, 0.09, 0.11, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (this.mesh) {
        const { view, mvp } = this._matrices();
        gl.useProgram(this.prog);
        gl.uniformMatrix4fv(this.u.uMVP, false, mvp);
        gl.uniformMatrix4fv(this.u.uView, false, view);
        gl.uniform1i(this.u.uMode, this.mode);
        gl.uniform1i(this.u.uSliderOn, this.sliderOn ? 1 : 0);
        gl.uniform1f(this.u.uT, this.t);
        gl.uniform2f(this.u.uSolidRange, this.solidRange[0], this.solidRange[1]);
        gl.uniform2f(this.u.uTempRange, this.tempRange[0], this.tempRange[1]);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.lut); gl.uniform1i(this.u.uLut, 0);
        gl.bindVertexArray(this.vao);
        gl.drawElements(gl.TRIANGLES, this.mesh.triangles.length, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
      }
      if (this.onFrame) this.onFrame(performance.now() - t0);
    }

    // ---------------------------------------------------------------- controls
    _installControls() {
      const cv = this.canvas;
      let drag = null;
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button === 2 || e.button === 1 || e.shiftKey };
      });
      cv.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        const c = this.cam;
        if (drag.pan) {
          // move target in the camera's screen plane, scaled so the part follows the cursor
          const { view } = this._matrices();
          const k = (2 * c.dist * Math.tan(c.fov / 2)) / cv.clientHeight;
          const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]];
          for (let a = 0; a < 3; a++) c.target[a] += (-dx * right[a] + dy * up[a]) * k;
        } else {
          c.yaw -= dx * 0.008;
          c.pitch = Math.max(-1.55, Math.min(1.55, c.pitch + dy * 0.008));
        }
        this.dirty = true;
      });
      cv.addEventListener('pointerup', e => {
        if (drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4 && e.button === 0 && !e.shiftKey) this._pick(e);
        drag = null;
      });
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const c = this.cam;
        c.dist = Math.max(c.radius * 0.05, Math.min(c.radius * 50, c.dist * Math.exp(e.deltaY * 0.0015)));
        this.dirty = true;
      }, { passive: false });
    }

    /** Ray through the pixel, nearest triangle hit (Möller–Trumbore), then nearest vertex to the hit point. */
    _pick(e) {
      if (!this.mesh || !this.onPick) return;
      const cv = this.canvas, rect = cv.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1, ny = 1 - ((e.clientY - rect.top) / rect.height) * 2;
      const c = this.cam, eye = this._eye();
      const { view } = this._matrices();
      const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]], back = [view[2], view[6], view[10]];
      const th = Math.tan(c.fov / 2), aspect = rect.width / rect.height;
      const d = [0, 1, 2].map(a => nx * th * aspect * right[a] + ny * th * up[a] - back[a]);
      const dl = Math.hypot(d[0], d[1], d[2]); d[0] /= dl; d[1] /= dl; d[2] /= dl;
      const hit = pickRay(this.mesh.gpuPos, this.mesh.triangles, eye, d);
      if (!hit) { this.onPick(-1, null); return; }
      const p = [eye[0] + d[0] * hit.t, eye[1] + d[1] * hit.t, eye[2] + d[2] * hit.t];
      this.onPick(nearestVertex(this.mesh.gpuPos, p), p);
    }
  }

  function pickRay(P, T, o, d) {
    let best = Infinity, bestTri = -1;
    const EPS = 1e-12;
    for (let t = 0, n = T.length / 3; t < n; t++) {
      const a = 3 * T[3 * t], b = 3 * T[3 * t + 1], cc = 3 * T[3 * t + 2];
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[cc] - P[a], e2y = P[cc + 1] - P[a + 1], e2z = P[cc + 2] - P[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -EPS && det < EPS) continue;
      const inv = 1 / det;
      const sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (dist > 0 && dist < best) { best = dist; bestTri = t; }
    }
    return bestTri < 0 ? null : { t: best, tri: bestTri };
  }

  function nearestVertex(P, p) {
    let best = -1, bd = Infinity;
    for (let i = 0, n = P.length / 3; i < n; i++) {
      const dx = P[3 * i] - p[0], dy = P[3 * i + 1] - p[1], dz = P[3 * i + 2] - p[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) { bd = d2; best = i; }
    }
    return best;
  }

  window.AYRViewer = { Viewer, pickRay, nearestVertex };
})();
