// A "living scene": fog and water drawn on the GPU over a still picture. Every motion goes round whole circles once per loop,
// so t = 0 and t = 1 are the same picture and the loop repeats with no seam.

export const SCENE_DEFAULTS = { dens: 0.45, hgt: 0.4, scl: 0.38, harm: 1, wave: 0.5, glint: 0.45, gstyle: 0.3, wspd: 1 };

const VS = 'attribute vec2 p; varying vec2 uv; void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }';

const FS = `precision highp float; varying vec2 uv;
uniform sampler2D bg; uniform sampler2D maskTex;
uniform float t, dens, hgt, scl, harm, aspect, wave, glint, wspd, gstyle, horizon;
const float TAU = 6.2831853;
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*f*(f*(f*6.-15.)+10.);
  float a=h21(i), b=h21(i+vec2(1,0)), c=h21(i+vec2(0,1)), d=h21(i+vec2(1,1)); return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
vec2 circ(float h, float ph){ float a = TAU*(h*t) + ph; return vec2(cos(a), sin(a)); }
float fbm(vec2 p, float seed){
  float s = 0., a = .5, f = 1.;
  for(int i=0;i<6;i++){
    float fi = float(i);
    float hh = harm * (1. + mod(fi, 3.));
    vec2 q = p*f + (0.55 + 0.12*fi) * circ(hh * (mod(fi,2.)<.5 ? 1. : -1.), seed + fi*1.7) + vec2(fi*17.3, fi*9.1+seed);
    s += a * vnoise(q); f *= 2.03; a *= .5; }
  return s / .96875;
}
float ripples(vec2 uv, float z){
  float s = 1./(.10+z);
  vec2 q = vec2(uv.x*aspect*s*2.6, log(.10+z)*10.);
  float r = 0.;
  r += .50*sin(q.x*1.00 + q.y*2.3 + TAU*1.*wspd*t + .3);
  r += .38*sin(q.x*-1.7 + q.y*1.4 - TAU*2.*wspd*t + 1.7);
  r += .30*sin(q.x*2.9  + q.y*3.7 + TAU*3.*wspd*t + 4.1);
  r += .22*sin(q.x*-4.3 + q.y*2.2 + TAU*2.*wspd*t + 2.2);
  r += .16*sin(q.x*6.1  + q.y*5.5 - TAU*3.*wspd*t + 5.3);
  float patch = vnoise(q*.22 + 3.) * .6 + vnoise(q*.11 + circ(1.,0.)*.9 + 9.) * .6;
  return r * smoothstep(.15, .85, patch + .15);
}
void main(){
  vec2 p = vec2(uv.x*aspect, uv.y) * scl * vec2(1.0, 1.7);
  vec2 w = vec2(fbm(p*.7 + 3.1, 1.3), fbm(p*.7 + 7.7, 4.2)) - .5;
  vec2 w2 = vec2(fbm(p*1.3 + w*2.2 + 11., 2.9), fbm(p*1.3 + w*2.2 + 5., 6.1)) - .5;
  vec2 q = p + 2.3*w + 0.9*w2;
  float d = fbm(q*1.1, 0.5);
  float wisps = fbm(vec2(q.x*0.45, q.y*2.1) + 20., 3.3);
  d = d*.7 + wisps*.45;
  float edge = (fbm(vec2(uv.x*aspect*1.2, 0.) + 40., 2.2) - .5) * .20;
  float band = 1. - smoothstep(hgt*.25, hgt, uv.y + edge);
  band *= smoothstep(0., .08, uv.y);
  float m = smoothstep(.34, .86, d) * band;
  m = pow(m, 1.15) * dens;

  float wm = texture2D(maskTex, uv).r;
  float z = clamp(((1.-uv.y) - horizon)/max(1.-horizon, .05), 0., 1.);
  float rp = ripples(uv, z);
  float rp2 = ripples(uv + vec2(.013,.007), z);
  float amp = mix(.0007, .0048, z*z*.6 + z*.4) * wave * wm;
  vec3 col = texture2D(bg, uv + vec2(rp*amp, rp2*amp*.35)).rgb;
  float lum = dot(col, vec3(.3,.55,.15));
  float sp = vnoise(vec2(uv.x*aspect*(40.+60.*z), (1.-uv.y)*(70.+160.*z)) + circ(2., 0.)*3.0 + 50.);
  float g0 = max(rp - .35, 0.)/.65;
  float g1 = max(rp - .30, 0.)/.70 * smoothstep(.50, .82, sp);
  float soft = pow(g0, 2.2) * .9;
  float spark = pow(g1, 1.3) * 2.2;
  col += vec3(1.,.94,.82) * mix(soft, spark, gstyle) * pow(lum, 1.6) * (.25 + .75*z) * glint * wm;
  col *= 1. + rp * .035 * wm * wave;

  vec3 haze = mix(vec3(.80,.86,.94), vec3(1.,.93,.82), smoothstep(.2,.7, uv.y));
  vec3 outc = mix(col, haze, clamp(m*.78, 0., .92));
  outc += haze * m * .10;
  gl_FragColor = vec4(outc, 1.);
}`;

function shader(gl, type, src) {
  const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
  if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o) || 'shader error');
  return o;
}

export function createScene(canvas) {
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error('This browser has no WebGL, so the living scene cannot be drawn.');
  const pr = gl.createProgram();
  gl.attachShader(pr, shader(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(pr, shader(gl, gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr) || 'link error');
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(pr, n);
  const mkTex = (unit) => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const texBg = mkTex(0), texMask = mkTex(1);
  let params = { ...SCENE_DEFAULTS }, horizon = 0.6, hasImage = false;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const upload = (unit, tex, src) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); };

  return {
    gl,
    setImage(img) { upload(0, texBg, img); hasImage = true; },
    setMask(maskCanvas, horizonTop) { upload(1, texMask, maskCanvas); horizon = horizonTop; },
    set(p) { params = { ...params, ...p }; },
    resize(w, h) { canvas.width = w; canvas.height = h; },
    draw(t) {
      if (!hasImage) return false;
      gl.viewport(0, 0, canvas.width, canvas.height);
      const P = params;
      gl.uniform1f(U('t'), t); gl.uniform1f(U('dens'), P.dens); gl.uniform1f(U('hgt'), P.hgt); gl.uniform1f(U('scl'), P.scl); gl.uniform1f(U('harm'), P.harm);
      gl.uniform1f(U('aspect'), canvas.width / canvas.height); gl.uniform1f(U('wave'), P.wave); gl.uniform1f(U('glint'), P.glint);
      gl.uniform1f(U('wspd'), P.wspd); gl.uniform1f(U('gstyle'), P.gstyle); gl.uniform1f(U('horizon'), horizon);
      gl.uniform1i(U('bg'), 0); gl.uniform1i(U('maskTex'), 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    },
  };
}

/** Paint the water mask: white = water moves, black = stays still. Shapes are lists of [x, y] points in 0..1 (top-left origin). */
export function paintMask(waterShapes, stillShapes, w = 640, h = 360) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  const poly = (pts, fill) => { if (pts.length < 3) return; ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h))); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
  ctx.filter = 'blur(3px)';
  waterShapes.forEach((s) => poly(s, '#fff'));
  stillShapes.forEach((s) => poly(s, '#000'));
  ctx.filter = 'none';
  let top = 1;
  waterShapes.forEach((s) => s.forEach(([, y]) => { top = Math.min(top, y); }));
  return { canvas: c, horizon: waterShapes.length ? top : 0.6 };
}
