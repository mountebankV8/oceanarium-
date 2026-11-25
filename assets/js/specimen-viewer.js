(() => {
  const viewer = document.querySelector('[data-specimen-viewer]');
  if (!viewer) return;

  const modes = viewer.querySelector('.specimen-modes');
  const photoButton = viewer.querySelector('[data-show-illustration]');
  const modelButton = viewer.querySelector('[data-show-model]');
  const photo = viewer.querySelector('[data-specimen-image]');
  const scene = viewer.querySelector('[data-specimen-scene]');
  const photoCaption = viewer.querySelector('[data-image-caption]');
  const sceneCaption = viewer.querySelector('[data-habitat-caption]');
  const status = viewer.querySelector('[role="status"]');
  const canvas = scene.querySelector('canvas');
  const assetUrl = new URL('../models/' + viewer.dataset.model, document.currentScript.src);
  let setRunning = null;
  let busy = false;
  let wantsModel = false;

  modes.hidden = false;

  function showMode(showModel) {
    const changed = scene.hidden !== !showModel;
    photo.hidden = showModel;
    scene.hidden = !showModel;
    photoCaption.hidden = showModel;
    sceneCaption.hidden = !showModel;
    photoButton.setAttribute('aria-pressed', String(!showModel));
    modelButton.setAttribute('aria-pressed', String(showModel));
    status.textContent = '';
    if (changed) setRunning?.(showModel);
  }

  function showUnavailable(message) {
    wantsModel = false;
    showMode(false);
    if (viewer.contains(document.activeElement) && document.activeElement !== photoButton) photoButton.focus();
    modelButton.disabled = true;
    status.textContent = message;
  }

  photoButton.addEventListener('click', () => {
    wantsModel = false;
    showMode(false);
  });

  modelButton.addEventListener('click', async () => {
    wantsModel = true;
    if (setRunning) {
      showMode(true);
      return;
    }
    status.textContent = 'Загружаем 3D-модель…';
    if (busy) return;
    busy = true;

    try {
      const gl = canvas.getContext('webgl', { alpha: true, antialias: true });
      if (!gl) {
        showUnavailable('3D недоступно в этом браузере. В окне доступно изображение экспоната.');
        return;
      }
      const data = await loadAsset(assetUrl);
      const model = unpackModel(data);
      setRunning = await createScene(gl, canvas, model, () => {
        showUnavailable('3D-просмотр прервался. Чтобы открыть его снова, обнови страницу.');
      });
      if (wantsModel) showMode(true);
    } catch {
      if (wantsModel) status.textContent = '3D-модель не загрузилась. Нажми «3D», чтобы попробовать ещё раз.';
    } finally {
      busy = false;
    }
  });

  function loadAsset(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.addEventListener('load', () => {
        const data = script.specimenModelData ?? script.rayModelData;
        script.remove();
        if (typeof data === 'string') resolve(data);
        else reject(new Error('Missing model asset'));
      }, { once: true });
      script.addEventListener('error', () => {
        script.remove();
        reject(new Error('Model load failed'));
      }, { once: true });
      document.head.append(script);
    });
  }

  function unpackModel(encoded) {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const header = new DataView(bytes.buffer);
    const jsonSize = header.getUint32(12, true);
    const model = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonSize)));
    const start = 28 + jsonSize;
    const primitive = model.meshes[0].primitives[0];
    const access = id => {
      const accessor = model.accessors[id];
      const view = model.bufferViews[accessor.bufferView];
      const Type = accessor.componentType === 5126 ? Float32Array : Uint16Array;
      return new Type(bytes.buffer, start + view.byteOffset, view.byteLength / Type.BYTES_PER_ELEMENT);
    };
    const image = model.images?.[0];
    const view = image ? model.bufferViews[image.bufferView] : null;
    const texture = view ? bytes.subarray(start + view.byteOffset, start + view.byteOffset + view.byteLength) : null;
    const clip = model.animations[0].samplers[0];
    return {
      view: model.extras?.view ?? {},
      positions: access(primitive.attributes.POSITION),
      normals: access(primitive.attributes.NORMAL),
      tint: access(primitive.attributes.COLOR_0),
      uv: access(primitive.attributes.TEXCOORD_0),
      indices: access(primitive.indices),
      morphs: primitive.targets.map(target => ({
        positions: access(target.POSITION),
        normals: access(target.NORMAL),
      })),
      time: access(clip.input),
      weights: access(clip.output),
      map: texture ? new Blob([texture], { type: image.mimeType }) : null,
    };
  }

  async function createScene(gl, canvas, model, onLost) {
    let picture = null;
    if (model.map) {
      picture = new Image();
      const objectUrl = URL.createObjectURL(model.map);
      try {
        picture.src = objectUrl;
        await picture.decode();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }
    if (gl.isContextLost()) throw new Error('WebGL context lost');

    const program = makeProgram(gl);
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    const lighting = model.view.lighting ?? {};
    gl.uniform3fv(gl.getUniformLocation(program, 'keyLight'), lighting.direction ?? [-.27, .91, .32]);
    gl.uniform3fv(gl.getUniformLocation(program, 'ambientLight'), lighting.ambient ?? [.28, .45, .52]);
    gl.uniform3fv(gl.getUniformLocation(program, 'directLight'), lighting.direct ?? [.79, 1.01, 1.16]);
    gl.uniform3fv(gl.getUniformLocation(program, 'waterTint'), lighting.fogColor ?? [.025, .098, .138]);
    gl.uniform2fv(gl.getUniformLocation(program, 'fogLevels'), lighting.fogLevels ?? [.035, .18]);
    gl.uniform4f(gl.getUniformLocation(program, 'waterResponse'),
      lighting.caustics ?? 1, lighting.sheen ?? 1, lighting.transmission ?? 0, lighting.lowerLight ?? .72);

    const floor = model.view.floor ?? {};
    gl.uniform3fv(gl.getUniformLocation(program, 'floorProjection'), floor.projection ?? [-.59, .25, .065]);
    gl.uniform1f(gl.getUniformLocation(program, 'floorOpacity'), floor.opacity ?? .48);
    const shadowSoftness = floor.softness ?? 1;

    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const skin = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, skin);
    if (picture) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    }
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Keep the shadow mask small so its blur is inexpensive, including on phones.
    const maskSize = [192, 96];
    gl.activeTexture(gl.TEXTURE1);
    function makeMask() {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ...maskSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('Shadow framebuffer unavailable');
      }
      return { texture, framebuffer };
    }
    const floorShadow = model.view.floorShadow ?? true;
    const shadow = floorShadow ? makeMask() : null;
    const blur = floorShadow ? makeMask() : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.uniform1i(gl.getUniformLocation(program, 'shadowMap'), 1);

    const screenQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, screenQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    function attribute(name, data, itemSize, dynamic = false) {
      const buffer = gl.createBuffer();
      const location = gl.getAttribLocation(program, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, itemSize, gl.FLOAT, false, 0, 0);
      return buffer;
    }

    const positions = model.positions.slice();
    const normals = model.normals.slice();
    const positionBuffer = attribute('point', positions, 3, true);
    const normalBuffer = attribute('normal', normals, 3, true);
    attribute('tint', model.tint, 3);
    attribute('uv', model.uv, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, model.indices, gl.STATIC_DRAW);

    const point = gl.getAttribLocation(program, 'point');
    const renderPass = gl.getUniformLocation(program, 'renderPass');
    const blurAxis = gl.getUniformLocation(program, 'blurAxis');
    const turn = gl.getUniformLocation(program, 'turn');
    const projection = gl.getUniformLocation(program, 'projection');
    const center = gl.getUniformLocation(program, 'center');
    const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
    const fitMargin = .86;
    const period = model.time.at(-1);
    const weightCount = model.morphs.length;
    const frameCount = model.time.length - 1;

    let yaw = model.view.yaw ?? 2.15;
    let pitch = model.view.pitch ?? .71;
    let bounds = null;
    let playhead = 0;
    let request = 0;
    let previous = null;
    let visible = true;
    let opened = false;
    let playing = !motionPreference.matches;
    let contextLost = false;
    let drag = null;

    function pose(seconds) {
      const cursor = seconds / period * frameCount;
      const key = Math.min(frameCount - 1, Math.floor(cursor));
      const mix = cursor - key;
      positions.set(model.positions);
      normals.set(model.normals);
      model.morphs.forEach((morph, index) => {
        const left = model.weights[key * weightCount + index];
        const right = model.weights[(key + 1) * weightCount + index];
        const weight = left + (right - left) * mix;
        if (!weight) return;
        for (let i = 0; i < positions.length; i++) {
          positions[i] += weight * morph.positions[i];
          normals[i] += weight * morph.normals[i];
        }
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, normals);
    }

    function cameraBounds() {
      const a = Math.cos(yaw), b = Math.sin(yaw);
      const c = Math.cos(pitch), d = Math.sin(pitch);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < model.positions.length; i += 3) {
        const [x, y, z] = [model.positions[i], model.positions[i + 1], model.positions[i + 2]];
        const u = a * x + b * z, v = c * y - d * (a * z - b * x);
        minX = Math.min(minX, u);
        maxX = Math.max(maxX, u);
        minY = Math.min(minY, v);
        maxY = Math.max(maxY, v);
      }
      return {
        x: (minX + maxX) / 2, y: (minY + maxY) / 2,
        width: maxX - minX + .10, height: maxY - minY + (model.view.margin ?? .55),
      };
    }

    function draw(now) {
      request = 0;
      if (!opened || !visible || document.hidden || contextLost) {
        previous = null;
        return;
      }
      if (playing) {
        playhead = (playhead + (previous === null ? 0 : Math.min(.05, (now - previous) / 1000))) % period;
        pose(playhead);
      }
      previous = playing ? now : null;
      const ratio = Math.min(2, devicePixelRatio || 1);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      if (!bounds) bounds = cameraBounds();
      const aspect = width / height;
      const scale = 2 * fitMargin / Math.max(bounds.width / aspect, bounds.height);
      gl.uniform2f(turn, yaw, pitch);
      gl.uniform2f(projection, scale / aspect, scale);
      gl.uniform2f(center, bounds.x, bounds.y);

      if (floorShadow) {
        // Project the moving silhouette into the grass plane; then soften it before drawing the body.
        gl.disable(gl.DEPTH_TEST);
        gl.bindTexture(gl.TEXTURE_2D, skin);
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.framebuffer);
        gl.viewport(0, 0, ...maskSize);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1i(renderPass, 1);
        gl.drawElements(gl.TRIANGLES, model.indices.length, gl.UNSIGNED_SHORT, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, screenQuad);
        gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0);

        // Blur in two low-resolution passes to avoid visible bands in the penumbra.
        gl.uniform1i(renderPass, 2);
        gl.bindFramebuffer(gl.FRAMEBUFFER, blur.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, shadow.texture);
        gl.uniform2f(blurAxis, 1.65 * shadowSoftness / maskSize[0], 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, blur.texture);
        gl.uniform2f(blurAxis, 0, 1.48 * shadowSoftness / maskSize[1]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, shadow.texture);
        gl.viewport(0, 0, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniform1i(renderPass, 3);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } else {
        gl.viewport(0, 0, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(point, 3, gl.FLOAT, false, 0, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.uniform1i(renderPass, 0);
      gl.drawElements(gl.TRIANGLES, model.indices.length, gl.UNSIGNED_SHORT, 0);
      if (playing) queueDraw();
    }

    function queueDraw() {
      if (!request && opened && visible && !document.hidden && !contextLost) request = requestAnimationFrame(draw);
    }

    function changeView(dx, dy) {
      yaw += dx;
      pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch + dy));
      bounds = null;
      queueDraw();
    }

    function setPlaying(next) {
      playing = next;
      previous = null;
      queueDraw();
    }

    function respectMotionPreference(event) {
      if (event.matches) setPlaying(false);
    }
    motionPreference.addEventListener('change', respectMotionPreference);
    canvas.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, moved: false };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (!drag || !event.isPrimary) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag = { x: event.clientX, y: event.clientY, moved: true };
      changeView(dx * .009, -dy * .009);
    });
    canvas.addEventListener('pointerup', event => {
      if (!drag || !event.isPrimary) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) {
        setPlaying(!playing);
      }
      drag = null;
    });
    canvas.addEventListener('lostpointercapture', () => { drag = null; });
    canvas.addEventListener('keydown', event => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        if (!event.repeat) setPlaying(!playing);
        return;
      }
      const keys = { ArrowLeft: [-.12, 0], ArrowRight: [.12, 0], ArrowUp: [0, .12], ArrowDown: [0, -.12] };
      const offset = keys[event.key];
      if (!offset) return;
      event.preventDefault();
      changeView(...offset);
    });
    const resize = new ResizeObserver(queueDraw);
    resize.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      previous = null;
      queueDraw();
    });
    intersection.observe(canvas);
    const visibility = () => { previous = null; queueDraw(); };
    document.addEventListener('visibilitychange', visibility);
    canvas.addEventListener('webglcontextlost', () => {
      contextLost = true;
      cancelAnimationFrame(request);
      resize.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      motionPreference.removeEventListener('change', respectMotionPreference);
      onLost();
    }, { once: true });

    pose(0);
    return active => {
      opened = active;
      previous = null;
      if (!active) return;
      visible = true;
      if (motionPreference.matches) setPlaying(false);
      else queueDraw();
    };
  }

  function makeProgram(gl) {
    function shader(type, source) {
      const result = gl.createShader(type);
      gl.shaderSource(result, source);
      gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
      return result;
    }

    const vertex = shader(gl.VERTEX_SHADER, `
      attribute vec3 point, normal, tint;
      attribute vec2 uv;
      uniform vec2 turn, projection, center;
      uniform vec3 floorProjection;
      uniform mediump int renderPass;
      varying vec3 viewNormal, bodyTint, viewPosition;
      varying vec2 textureCoord, sceneUV;

      vec3 rotate(vec3 p) {
        float c=cos(turn.x), s=sin(turn.x), u=cos(turn.y), v=sin(turn.y);
        vec3 q=vec3(c*p.x+s*p.z,p.y,c*p.z-s*p.x);
        return vec3(q.x,u*q.y-v*q.z,v*q.y+u*q.z);
      }

      void main() {
        if (renderPass >= 2) {
          gl_Position=vec4(point.xy,0.,1.);
          sceneUV=point.xy*.5+.5;
          return;
        }
        vec3 p=rotate(point);
        vec2 screen=(p.xy-center)*projection;
        if (renderPass == 1) {
          vec2 floorPoint=vec2(screen.x+floorProjection.z+p.z*.032,floorProjection.x+screen.y*floorProjection.y-p.z*.042);
          gl_Position=vec4(floorPoint,0.,1.);
          return;
        }
        gl_Position=vec4(screen,-p.z*.16,1.);
        sceneUV=screen*.5+.5;
        viewNormal=rotate(normal);
        viewPosition=p;
        bodyTint=tint;
        textureCoord=uv;
      }
    `);
    const fragment = shader(gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform sampler2D sampler, shadowMap;
      uniform vec2 blurAxis, fogLevels;
      uniform vec3 keyLight, ambientLight, directLight, waterTint;
      uniform vec4 waterResponse; // Caustics, sheen, transmission, light at the bottom of the frame.
      uniform float floorOpacity;
      uniform mediump int renderPass;
      varying vec3 viewNormal, bodyTint, viewPosition;
      varying vec2 textureCoord, sceneUV;

      float waterLight(vec3 p) {
        vec2 q=p.xz*8.0+vec2(.7,1.5)*p.y;
        float a=sin(q.x+.82*sin(q.y*.71));
        float b=sin(q.y*.92+.70*sin(q.x*.66));
        return 1.-smoothstep(.04,.30,abs(a*b));
      }

      float blurMask(vec2 uv) {
        float sum=texture2D(shadowMap,uv).r*.227027;
        sum+=(texture2D(shadowMap,uv+blurAxis*1.384615).r+
              texture2D(shadowMap,uv-blurAxis*1.384615).r)*.316216;
        sum+=(texture2D(shadowMap,uv+blurAxis*3.230769).r+
              texture2D(shadowMap,uv-blurAxis*3.230769).r)*.070270;
        return sum;
      }

      void main() {
        if (renderPass == 1) {
          gl_FragColor=vec4(1.);
          return;
        }
        if (renderPass == 2) {
          gl_FragColor=vec4(vec3(blurMask(sceneUV)),1.);
          return;
        }
        if (renderPass == 3) {
          float opacity=texture2D(shadowMap,sceneUV).r*smoothstep(.005,.09,sceneUV.y)*floorOpacity;
          gl_FragColor=vec4(vec3(.015,.053,.074)*opacity,opacity);
          return;
        }
        vec3 n=normalize(viewNormal);
        // The photo's light enters from the same upper-left opening.
        vec3 keyDir=normalize(keyLight);
        float key=max(0.,dot(n,keyDir));
        float shaft=1.-smoothstep(.09,.48,abs(sceneUV.x-(.46+.13*(1.-sceneUV.y))));
        float overhead=key*(.73+shaft*.64)*mix(waterResponse.w,1.18,clamp(sceneUV.y,0.,1.));
        float fill=max(0.,dot(n,normalize(vec3(.56,-.56,.54))));
        float rim=pow(1.-abs(n.z),2.4);
        float sheen=pow(max(0.,dot(n,normalize(keyDir+vec3(0.,0.,1.)))),30.);
        vec3 base=pow(texture2D(sampler,textureCoord).rgb,vec3(2.2))*bodyTint;
        vec3 light=ambientLight+overhead*directLight+fill*vec3(.13,.24,.28);
        float caustic=waterLight(viewPosition)*overhead*waterResponse.x;
        vec3 shaded=base*(light+caustic*vec3(.26,.42,.46));
        shaded+=caustic*vec3(.012,.028,.034)+rim*vec3(.006,.020,.028);
        shaded+=sheen*overhead*waterResponse.y*vec3(.035,.058,.067);
        shaded+=rim*waterResponse.z*vec3(.14,.20,.27)*(.45+.55*key);
        float haze=mix(fogLevels.x,fogLevels.y,1.-smoothstep(-2.1,1.1,viewPosition.z));
        shaded=mix(shaded,waterTint,haze);
        float opacity=1.-waterResponse.z*(1.-.64*rim);
        vec3 displayColor=pow(clamp(shaded,0.,1.),vec3(.4545));
        gl_FragColor=vec4(displayColor*opacity,opacity);
      }
    `);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
  }
})();
