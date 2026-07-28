// ASCII globe for the chat empty state.
//
// Derived from bluesky-social/atproto-website, src/components/home/
// GlobeAnimation.tsx, (c) 2022-2026 Bluesky Social PBC and Contributors,
// licensed CC-BY 4.0. Changes: React component converted to a plain-JS
// initializer; both WebGL passes share one animation frame; rendering pauses
// while the empty state is hidden or the tab is in the background; glyph color
// and scale come from CSS instead of Tailwind classes.

(function () {
  'use strict';

  var DEFAULT_LINES = 25;
  var TILE_SIZE = 2;            // 2x2 pixel tiles, each producing 2 characters
  var RENDER_SCALE = 4;         // supersampling factor for the box filter
  // Carry this script's own ?v= onto the textures. Without a fingerprint the
  // server can only offer them a 5-minute cache; with one they are immutable
  // for a year and still bust on redeploy.
  var VERSION_QUERY = (function () {
    var tag = document.querySelector('script[src*="static/globe.js"]');
    var src = tag && tag.getAttribute('src');
    var i = src ? src.indexOf('?') : -1;
    return i >= 0 ? src.slice(i) : '';
  })();
  var TEXTURE_PATH = 'static/globe/solidmap.webp' + VERSION_QUERY;
  var TEXTURE_COLOR_PATH = 'static/globe/globe-texture.png' + VERSION_QUERY;
  var ROTATION_SPEED = 0.001;
  var DRAG_SENSITIVITY = 0.01;
  var AXIAL_TILT_X = -8 * (Math.PI / 180);
  var AXIAL_TILT_Z = 0;
  var CAMERA_FOV = 0.1;
  var SPHERE_SCALE = 0.14;
  var OUTLINE_SCALE = 1.025;    // outline sphere, relative to SPHERE_SCALE
  var ASCII_VISIBLE_THRESHOLD = 64;

  // Index = bit pattern for a 1x2 vertical pair: top(2) + bottom(1)
  var ASCII_MAP = [' ', '.', "'", '#'];

  var VERTEX_SHADER = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 aPosition;',
    'in vec2 aTexCoord;',
    'uniform mat4 uModelViewMatrix;',
    'uniform mat4 uProjectionMatrix;',
    'out vec2 vTexCoord;',
    'void main() {',
    '  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);',
    '  vTexCoord = aTexCoord;',
    '}',
  ].join('\n');

  // Black in the land mask = land (opaque), white = water (transparent).
  var MASK_FRAGMENT_SHADER = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vTexCoord;',
    'uniform sampler2D uTexture;',
    'out vec4 fragColor;',
    'void main() {',
    '  float land = texture(uTexture, vTexCoord).r;',
    '  fragColor = vec4(1.0, 1.0, 1.0, 1.0 - land);',
    '}',
  ].join('\n');

  var COLOR_FRAGMENT_SHADER = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vTexCoord;',
    'uniform sampler2D uTexture;',
    'out vec4 fragColor;',
    'void main() {',
    '  fragColor = texture(uTexture, vTexCoord);',
    '}',
  ].join('\n');

  var SOLID_FRAGMENT_SHADER = [
    '#version 300 es',
    'precision highp float;',
    'out vec4 fragColor;',
    'void main() {',
    '  fragColor = vec4(1.0, 1.0, 1.0, 1.0);',
    '}',
  ].join('\n');

  // ---- math ----

  function multiplyMatrices(a, b) {
    var result = new Float32Array(16);
    for (var row = 0; row < 4; row++) {
      for (var col = 0; col < 4; col++) {
        result[col * 4 + row] =
          a[0 * 4 + row] * b[col * 4 + 0] +
          a[1 * 4 + row] * b[col * 4 + 1] +
          a[2 * 4 + row] * b[col * 4 + 2] +
          a[3 * 4 + row] * b[col * 4 + 3];
      }
    }
    return result;
  }

  function createRotationMatrix(axisX, axisY, axisZ, angle) {
    var c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    var len = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
    var x = axisX / len, y = axisY / len, z = axisZ / len;
    return new Float32Array([
      t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
      t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
      t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
      0, 0, 0, 1,
    ]);
  }

  function createPerspectiveMatrix(fov, aspect, near, far) {
    var f = 1.0 / Math.tan(fov / 2);
    var nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  }

  function createModelViewMatrix(rotationMatrix, scaleMultiplier) {
    var tiltX = createRotationMatrix(1, 0, 0, -AXIAL_TILT_X);
    var tiltZ = createRotationMatrix(0, 0, 1, AXIAL_TILT_Z);
    var combined = multiplyMatrices(multiplyMatrices(tiltZ, tiltX), rotationMatrix);
    var s = SPHERE_SCALE * (scaleMultiplier || 1);
    return new Float32Array([
      combined[0] * s, combined[1] * s, combined[2] * s, 0,
      combined[4] * s, combined[5] * s, combined[6] * s, 0,
      combined[8] * s, combined[9] * s, combined[10] * s, 0,
      0, 0, -3, 1,
    ]);
  }

  function createUVSphere(latSegments, lonSegments) {
    var vertices = [], texCoords = [], indices = [];
    for (var lat = 0; lat <= latSegments; lat++) {
      var theta = (lat * Math.PI) / latSegments;
      var sinTheta = Math.sin(theta), cosTheta = Math.cos(theta);
      for (var lon = 0; lon <= lonSegments; lon++) {
        var phi = (lon * 2 * Math.PI) / lonSegments;
        // x is negated to fix the winding order
        vertices.push(-Math.cos(phi) * sinTheta, cosTheta, Math.sin(phi) * sinTheta);
        texCoords.push(lon / lonSegments, lat / latSegments);
      }
    }
    for (var la = 0; la < latSegments; la++) {
      for (var lo = 0; lo < lonSegments; lo++) {
        var first = la * (lonSegments + 1) + lo;
        var second = first + lonSegments + 1;
        indices.push(first, second, first + 1);
        indices.push(second, second + 1, first + 1);
      }
    }
    return {
      vertices: new Float32Array(vertices),
      texCoords: new Float32Array(texCoords),
      indices: new Uint16Array(indices),
    };
  }

  // ---- webgl ----

  function compileShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var error = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile error: ' + error);
    }
    return shader;
  }

  function createProgram(gl, vertexShader, fragmentShader) {
    var program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      var error = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('Program link error: ' + error);
    }
    return program;
  }

  function loadTexture(gl, url) {
    return new Promise(function (resolve, reject) {
      var texture = gl.createTexture();
      var image = new Image();
      image.onload = function () {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        resolve(texture);
      };
      image.onerror = function () { reject(new Error('Failed to load texture: ' + url)); };
      image.src = url;
    });
  }

  // Binds the sphere for a program that may or may not take texture coords.
  function createSphereVao(gl, program, buffers, withTexCoord) {
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var aPosition = gl.getAttribLocation(program, 'aPosition');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
    if (withTexCoord) {
      var aTexCoord = gl.getAttribLocation(program, 'aTexCoord');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.texCoord);
      gl.enableVertexAttribArray(aTexCoord);
      gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
    return vao;
  }

  function createSphereBuffers(gl, sphere) {
    var position = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, position);
    gl.bufferData(gl.ARRAY_BUFFER, sphere.vertices, gl.STATIC_DRAW);
    var texCoord = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoord);
    gl.bufferData(gl.ARRAY_BUFFER, sphere.texCoords, gl.STATIC_DRAW);
    var index = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.indices, gl.STATIC_DRAW);
    return { position: position, texCoord: texCoord, index: index };
  }

  // ---- ascii ----

  // Each 2x2 pixel tile becomes 2 characters, one per column, keyed on that
  // column's top and bottom pixel. With RENDER_SCALE > 1 every pixel is the box
  // average of a RENDER_SCALE x RENDER_SCALE block.
  function convertToAscii(pixels, width, height, lines) {
    var tiles = lines;
    var out = [];

    function averagedAlpha(outX, outY) {
      var sum = 0;
      for (var sy = 0; sy < RENDER_SCALE; sy++) {
        for (var sx = 0; sx < RENDER_SCALE; sx++) {
          var srcX = outX * RENDER_SCALE + sx;
          var srcY = outY * RENDER_SCALE + sy;
          // +3 reads alpha; the row index is flipped because GL reads bottom-up
          sum += pixels[((height - 1 - srcY) * width + srcX) * 4 + 3];
        }
      }
      return sum / (RENDER_SCALE * RENDER_SCALE);
    }

    for (var ty = 0; ty < tiles; ty++) {
      var line = '';
      for (var tx = 0; tx < tiles; tx++) {
        var baseY = ty * TILE_SIZE, baseX = tx * TILE_SIZE;
        var tl = averagedAlpha(baseX, baseY) > ASCII_VISIBLE_THRESHOLD;
        var tr = averagedAlpha(baseX + 1, baseY) > ASCII_VISIBLE_THRESHOLD;
        var bl = averagedAlpha(baseX, baseY + 1) > ASCII_VISIBLE_THRESHOLD;
        var br = averagedAlpha(baseX + 1, baseY + 1) > ASCII_VISIBLE_THRESHOLD;
        line += ASCII_MAP[(tl ? 2 : 0) | (bl ? 1 : 0)];
        line += ASCII_MAP[(tr ? 2 : 0) | (br ? 1 : 0)];
      }
      out.push(line);
    }
    return out.join('\n');
  }

  // ---- component ----

  function initGlobe(host, options) {
    var opts = options || {};
    // style.css owns --globe-lines so the reserved box and the character grid
    // can never disagree; DEFAULT_LINES only covers an unstyled host.
    var declared = parseInt(getComputedStyle(host).getPropertyValue('--globe-lines'), 10);
    var lines = opts.lines || (declared > 0 ? declared : DEFAULT_LINES);
    var canvasSize = lines * TILE_SIZE * RENDER_SCALE;

    // The mask pass renders offscreen; only its readback reaches the DOM.
    var maskCanvas = document.createElement('canvas');
    maskCanvas.width = canvasSize;
    maskCanvas.height = canvasSize;
    maskCanvas.style.display = 'none';

    var colorCanvas = document.createElement('canvas');
    colorCanvas.className = 'empty-globe__color';

    var pre = document.createElement('pre');
    pre.className = 'empty-globe__ascii';

    host.appendChild(maskCanvas);
    host.appendChild(colorCanvas);
    host.appendChild(pre);

    var maskGl = maskCanvas.getContext('webgl2', { alpha: true, preserveDrawingBuffer: true });
    var colorGl = colorCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
    if (!maskGl) {
      host.hidden = true;
      return null;
    }

    var rotationMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    var isDragging = false;
    var lastX = 0, lastY = 0;
    var frameId = 0;
    var running = false;
    // Assumed on-screen until the observer says otherwise: a missed first
    // callback should cost a few frames of work, not the whole animation.
    var onScreen = true;
    var ready = false;
    var colorSide = 0;

    function spin(axisX, axisY, delta) {
      if (!delta) return;
      rotationMatrix = multiplyMatrices(
        createRotationMatrix(axisX, axisY, 0, delta * DRAG_SENSITIVITY),
        rotationMatrix
      );
    }

    function onPointerDown(e) {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      spin(0, 1, e.clientX - lastX);
      spin(1, 0, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    }

    function onPointerUp() { isDragging = false; }

    function onTouchStart(e) {
      if (e.touches.length !== 1) return;
      isDragging = true;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
    }

    function onTouchMove(e) {
      if (!isDragging || e.touches.length !== 1) return;
      e.preventDefault();
      spin(0, 1, e.touches[0].clientX - lastX);
      spin(1, 0, e.touches[0].clientY - lastY);
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
    }

    host.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    host.addEventListener('mouseleave', onPointerUp);
    host.addEventListener('touchstart', onTouchStart);
    host.addEventListener('touchmove', onTouchMove, { passive: false });
    host.addEventListener('touchend', onPointerUp);

    // The color overlay is square and matched to the rendered height of the
    // ascii block, which only settles once the monospace face has loaded.
    function measure() {
      var side = Math.round(pre.getBoundingClientRect().height);
      if (!side || side === colorSide) return;
      colorSide = side;
      colorCanvas.width = side;
      colorCanvas.height = side;
    }

    var resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(pre);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    measure();

    function start() {
      if (running || !ready || !onScreen || document.hidden) return;
      running = true;
      frameId = requestAnimationFrame(render);
    }

    function stop() {
      running = false;
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
    }

    var visibility = new IntersectionObserver(function (entries) {
      onScreen = entries.some(function (entry) { return entry.isIntersecting; });
      if (onScreen) start(); else stop();
    });
    visibility.observe(host);

    function onVisibilityChange() {
      if (document.hidden) stop(); else start();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    var mask = null, color = null, pixels = null, oldPixels = null, projection = null;

    function render() {
      if (!isDragging) {
        rotationMatrix = multiplyMatrices(
          createRotationMatrix(0, 1, 0, ROTATION_SPEED),
          rotationMatrix
        );
      }

      var gl = maskGl;
      gl.viewport(0, 0, canvasSize, canvasSize);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // Pass 1: a slightly larger solid sphere, which reads as an outline once
      // the textured sphere is drawn over it.
      gl.useProgram(mask.outlineProgram);
      gl.uniformMatrix4fv(mask.outlineModelView, false, createModelViewMatrix(rotationMatrix, OUTLINE_SCALE));
      gl.uniformMatrix4fv(mask.outlineProjection, false, projection);
      gl.bindVertexArray(mask.outlineVao);
      gl.drawElements(gl.TRIANGLES, mask.indexCount, gl.UNSIGNED_SHORT, 0);

      gl.clear(gl.DEPTH_BUFFER_BIT);

      // Pass 2: the land mask itself.
      gl.useProgram(mask.program);
      gl.uniformMatrix4fv(mask.modelView, false, createModelViewMatrix(rotationMatrix, 1));
      gl.uniformMatrix4fv(mask.projection, false, projection);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, mask.texture);
      gl.uniform1i(mask.sampler, 0);
      gl.bindVertexArray(mask.vao);
      gl.drawElements(gl.TRIANGLES, mask.indexCount, gl.UNSIGNED_SHORT, 0);

      gl.readPixels(0, 0, canvasSize, canvasSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      // Heavy temporal smoothing: coastlines melt into place instead of
      // popping between character cells frame to frame.
      for (var i = 0; i < pixels.length; i++) {
        pixels[i] = oldPixels[i] * 0.99 + pixels[i] * 0.01;
      }
      oldPixels.set(pixels);

      pre.textContent = convertToAscii(pixels, canvasSize, canvasSize, lines);

      if (color && colorSide) {
        var cgl = colorGl;
        cgl.viewport(0, 0, colorSide, colorSide);
        cgl.clear(cgl.COLOR_BUFFER_BIT | cgl.DEPTH_BUFFER_BIT);
        cgl.useProgram(color.program);
        cgl.uniformMatrix4fv(color.modelView, false, createModelViewMatrix(rotationMatrix, 1));
        cgl.uniformMatrix4fv(color.projection, false, projection);
        cgl.activeTexture(cgl.TEXTURE0);
        cgl.bindTexture(cgl.TEXTURE_2D, color.texture);
        cgl.uniform1i(color.sampler, 0);
        cgl.bindVertexArray(color.vao);
        cgl.drawElements(cgl.TRIANGLES, color.indexCount, cgl.UNSIGNED_SHORT, 0);
      }

      frameId = requestAnimationFrame(render);
    }

    function initMask() {
      var gl = maskGl;
      var vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      var program = createProgram(gl, vertexShader, compileShader(gl, gl.FRAGMENT_SHADER, MASK_FRAGMENT_SHADER));
      var outlineProgram = createProgram(gl, vertexShader, compileShader(gl, gl.FRAGMENT_SHADER, SOLID_FRAGMENT_SHADER));
      var sphere = createUVSphere(32, 64);
      var buffers = createSphereBuffers(gl, sphere);

      gl.enable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);

      return loadTexture(gl, TEXTURE_PATH).then(function (texture) {
        mask = {
          program: program,
          outlineProgram: outlineProgram,
          vao: createSphereVao(gl, program, buffers, true),
          outlineVao: createSphereVao(gl, outlineProgram, buffers, false),
          modelView: gl.getUniformLocation(program, 'uModelViewMatrix'),
          projection: gl.getUniformLocation(program, 'uProjectionMatrix'),
          sampler: gl.getUniformLocation(program, 'uTexture'),
          outlineModelView: gl.getUniformLocation(outlineProgram, 'uModelViewMatrix'),
          outlineProjection: gl.getUniformLocation(outlineProgram, 'uProjectionMatrix'),
          indexCount: sphere.indices.length,
          texture: texture,
        };
        pixels = new Uint8Array(canvasSize * canvasSize * 4);
        oldPixels = new Uint8Array(canvasSize * canvasSize * 4);
        projection = createPerspectiveMatrix(CAMERA_FOV, 1, 0.1, 100);
      });
    }

    // The color wash is decorative; if it fails the ascii globe still runs.
    function initColor() {
      if (!colorGl) return Promise.resolve();
      var gl = colorGl;
      var vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      var program = createProgram(gl, vertexShader, compileShader(gl, gl.FRAGMENT_SHADER, COLOR_FRAGMENT_SHADER));
      var sphere = createUVSphere(32, 64);
      var buffers = createSphereBuffers(gl, sphere);

      gl.enable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);

      return loadTexture(gl, TEXTURE_COLOR_PATH).then(function (texture) {
        color = {
          program: program,
          vao: createSphereVao(gl, program, buffers, true),
          modelView: gl.getUniformLocation(program, 'uModelViewMatrix'),
          projection: gl.getUniformLocation(program, 'uProjectionMatrix'),
          sampler: gl.getUniformLocation(program, 'uTexture'),
          indexCount: sphere.indices.length,
          texture: texture,
        };
      }).catch(function () {});
    }

    initMask().then(initColor).then(function () {
      ready = true;
      measure();
      start();
    }).catch(function (err) {
      console.error('globe: init failed', err);
      host.hidden = true;
    });

    return {
      destroy: function () {
        stop();
        resizeObserver.disconnect();
        visibility.disconnect();
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('mousemove', onPointerMove);
        window.removeEventListener('mouseup', onPointerUp);
      },
    };
  }

  window.initGlobe = initGlobe;

  function boot() {
    var host = document.getElementById('emptyGlobe');
    if (host && !host.dataset.globeReady) {
      host.dataset.globeReady = '1';
      initGlobe(host);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
