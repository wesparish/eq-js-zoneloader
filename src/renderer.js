// Minimal WebGL2 renderer: one shader, one draw call per material batch.

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec3 aNormal;
layout(location=3) in vec4 aColor;
uniform mat4 uViewProj;
out vec2 vUV;
out vec4 vColor;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vUV = aUV;
  vColor = aColor;
  vNormal = aNormal;
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
in vec3 vNormal;
in vec3 vWorld;
uniform sampler2D uTex;
uniform float uAlpha;        // material-wide opacity
uniform float uAlphaCutoff;  // >0 enables alpha testing
uniform float uBrightness;
uniform float uUseVertexColor;
uniform float uAmbient;
uniform vec3 uEye;
uniform float uHeadlamp;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
out vec4 outColor;
void main() {
  vec4 tex = texture(uTex, vUV);
  if (uAlphaCutoff > 0.0 && tex.a < uAlphaCutoff) discard;

  // WLD vertex colours are the *contribution of placed lights only* — they average
  // ~0.12 across a zone and go to zero away from torches. The original client added
  // them to a zone-wide ambient level rather than using them as a plain multiplier,
  // so doing the same is what keeps open terrain from rendering pitch black.
  vec3 light = mix(vec3(1.0), clamp(vec3(uAmbient) + vColor.rgb, 0.0, 1.0), uUseVertexColor);
  vec3 rgb = tex.rgb * light * uBrightness;

  // A small eye-space lamp so the deeper tunnels stay readable.
  float dist = length(vWorld - uEye);
  rgb += tex.rgb * uHeadlamp * clamp(1.0 - dist / 220.0, 0.0, 1.0);

  float fog = clamp((dist - uFogStart) / max(uFogEnd - uFogStart, 1.0), 0.0, 1.0);
  rgb = mix(rgb, uFogColor, fog);
  outColor = vec4(rgb, tex.a * uAlpha);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.canvas = canvas;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.u = {};
    for (const n of ['uViewProj', 'uTex', 'uAlpha', 'uAlphaCutoff', 'uBrightness',
      'uUseVertexColor', 'uAmbient', 'uEye', 'uHeadlamp', 'uFogColor', 'uFogStart', 'uFogEnd']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
    this.textures = new Map();
    this.drawables = [];
    gl.enable(gl.DEPTH_TEST);
  }

  uploadTexture(name, img) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) {
      gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    }
    let hasAlpha = false;
    for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] < 250) { hasAlpha = true; break; }
    this.textures.set(name, { tex, hasAlpha });
    return this.textures.get(name);
  }

  /** Releases every GPU object from a previous load, so zones can be swapped. */
  dispose() {
    const gl = this.gl;
    for (const { tex } of this.textures.values()) gl.deleteTexture(tex);
    this.textures.clear();
    for (const d of this.drawables) {
      gl.deleteVertexArray(d.vao);
      for (const buf of d.buffers) gl.deleteBuffer(buf);
    }
    this.drawables = [];
  }

  load(zone) {
    const gl = this.gl;
    this.dispose();
    for (const [name, img] of zone.textures) if (img) this.uploadTexture(name, img);

    this.drawables = zone.batches.map((b) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buffers = [];
      const bind = (loc, data, size) => {
        const buf = gl.createBuffer();
        buffers.push(buf);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      };
      bind(0, b.positions, 3);
      bind(1, b.uvs, 2);
      bind(2, b.normals, 3);
      bind(3, b.colors, 4);
      const ibo = gl.createBuffer();
      buffers.push(ibo);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, b.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);

      const mat = b.material;
      const frames = mat.frames.map((f) => this.textures.get(f)).filter(Boolean);
      const first = frames[0];
      // Blend factors for the transparent render modes; everything else is opaque
      // and relies on alpha testing when its texture actually has holes in it.
      const OPACITY = { 0x05: 0.5, 0x09: 0.75, 0x0a: 0.35, 0x0b: 0.75 };
      const alpha = OPACITY[mat.mode] ?? 1.0;
      const masked = mat.mode === 0x13 || (alpha === 1.0 && first && first.hasAlpha);
      return {
        vao, buffers, count: b.indices.length, frames,
        alpha, cutoff: masked ? 0.5 : 0.0,
        blended: alpha < 1.0,
        isObject: b.isObject,
        isNpc: !!b.isNpc,
        name: mat.name,
        delayMs: mat.delayMs,
      };
    });
    return this.drawables.length;
  }

  render(viewProj, eye, opts) {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.clearColor(opts.fogColor[0], opts.fogColor[1], opts.fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uViewProj, false, viewProj);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1f(this.u.uBrightness, opts.brightness);
    gl.uniform1f(this.u.uUseVertexColor, opts.vertexColor ? 1 : 0);
    gl.uniform1f(this.u.uAmbient, opts.ambient);
    gl.uniform3fv(this.u.uEye, eye);
    gl.uniform1f(this.u.uHeadlamp, opts.headlamp);
    gl.uniform3fv(this.u.uFogColor, opts.fogColor);
    gl.uniform1f(this.u.uFogStart, opts.fogStart);
    gl.uniform1f(this.u.uFogEnd, opts.fogEnd);

    if (opts.cull) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
    else gl.disable(gl.CULL_FACE);

    gl.activeTexture(gl.TEXTURE0);
    let calls = 0, tris = 0;
    const frame = opts.timeMs;

    for (const pass of [0, 1]) {
      for (const d of this.drawables) {
        if ((pass === 1) !== d.blended) continue;
        if (d.isObject && !opts.showObjects) continue;
        if (d.isNpc && !opts.showNpcs) continue;
        if (pass === 1) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
        } else {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
        }
        const f = d.frames.length > 1
          ? d.frames[Math.floor(frame / Math.max(d.delayMs, 50)) % d.frames.length]
          : d.frames[0];
        if (!f) continue;
        gl.bindTexture(gl.TEXTURE_2D, f.tex);
        gl.uniform1f(this.u.uAlpha, d.alpha);
        gl.uniform1f(this.u.uAlphaCutoff, d.cutoff);
        gl.bindVertexArray(d.vao);
        gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, 0);
        calls++; tris += d.count / 3;
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    return { calls, tris };
  }
}
