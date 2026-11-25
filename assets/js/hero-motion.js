(() => {
  const hero = document.querySelector('.hero');
  const canvas = hero?.querySelector('.hero-photo-motion');
  const toggle = hero?.querySelector('[data-hero-motion]');
  if (!canvas || !toggle) return;

  const root = new URL('..', document.currentScript.src);
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const label = toggle.querySelector('[data-hero-motion-label]');
  let userPaused = false, inView = false, loading = false;
  let paint = null, request = 0, lastFrame = null, time = 0;

  function moving() {
    return paint && !preference.matches && !userPaused && inView && !document.hidden;
  }

  function tick(now) {
    request = 0;
    if (!moving()) return;
    if (lastFrame === null) lastFrame = now;
    const elapsed = now - lastFrame;
    if (elapsed >= 32) {
      time += Math.min(elapsed / 1000, .10);
      paint(time);
      lastFrame = now;
    }
    request = requestAnimationFrame(tick);
  }

  function update() {
    const available = Boolean(paint) && !preference.matches;
    canvas.hidden = !available;
    toggle.hidden = !available;
    label.textContent = userPaused ? 'Продолжить анимацию' : 'Пауза анимации';
    const playing = Boolean(moving());
    hero.classList.toggle('hero-is-moving', playing);
    if (playing && !request) request = requestAnimationFrame(tick);
    if (!playing) {
      cancelAnimationFrame(request);
      request = 0;
      lastFrame = null;
    }
    if (!preference.matches && inView && !loading && !paint && !document.hidden) {
      loading = true;
      prepare();
    }
  }

  async function prepare() {
    try {
      const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
      if (!gl) return;
      const photo = new Image();
      photo.src = location.protocol === 'file:' ? await filePhotoSource() : new URL('img/hero.webp', root).href;
      await photo.decode();
      canvas.width = Math.min(photo.naturalWidth, matchMedia('(max-width: 47.99rem)').matches ? 1200 : 1800);
      canvas.height = Math.round(photo.naturalHeight / photo.naturalWidth * canvas.width);
      paint = makeRenderer(gl, photo);
      paint(0);
      update();
    } catch {
      // The CSS photograph remains visible when WebGL or local asset loading is unavailable.
      paint = null;
      update();
    }
  }

  function filePhotoSource() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('js/hero-photo-data.js', root).href;
      script.onload = () => {
        const source = script.heroPhotoSource;
        script.remove();
        if (source) resolve(source);
        else reject(new Error('Missing panorama data'));
      };
      script.onerror = () => {
        script.remove();
        reject(new Error('Panorama data could not be loaded'));
      };
      document.head.append(script);
    });
  }

  function makeRenderer(gl, photo) {
    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    }

    const vertex = compile(gl.VERTEX_SHADER, `
      attribute vec2 point;
      varying mediump vec2 uv;
      void main() {
        gl_Position=vec4(point,0.,1.);
        uv=vec2(point.x*.5+.5,.5-point.y*.5);
      }
    `);
    const fragment = compile(gl.FRAGMENT_SHADER, `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
      varying mediump vec2 uv;
      uniform sampler2D panorama;
      uniform vec2 size;
      uniform float phase, strength;

      // Landmarks use coordinates in the original 2400 × 1602 photograph.
      vec2 finCoordinates(vec2 p, vec2 root, vec2 tip) {
        vec2 axis=(tip-root)*.01, local=(p-root)*.01;
        float axisLength=length(axis);
        vec2 along=axis/axisLength;
        return vec2(dot(local,along)/axisLength,100.*dot(local,vec2(-along.y,along.x)));
      }

      float finBand(vec2 local, float width) {
        vec2 q=vec2((local.x-.5)/.71,local.y/width);
        return 1.-smoothstep(.63,1.,length(q));
      }

      // The stroke grows away from the joint and reaches the flexible tip last.
      vec2 finStroke(vec2 p, vec2 root, vec2 tip, float width, float beat, float angle) {
        vec2 local=finCoordinates(p,root,tip);
        float span=clamp(local.x,0.,1.05);
        float flex=beat-.88*span;
        float bend=angle*span*span*(sin(flex)+.12*sin(2.*flex+.35));
        vec2 arm=p-root;
        return finBand(local,width)*bend*vec2(-arm.y,arm.x);
      }

      // Both lobes share the same traveling wave through the rear of the body.
      vec2 sharkStroke(vec2 p, vec2 body, vec2 joint, vec2 upper, vec2 lower,
                       float width, float beat) {
        float stalk=finBand(finCoordinates(p,body,joint),.73*width);
        float lobes=max(finBand(finCoordinates(p,joint,upper),width),
                        finBand(finCoordinates(p,joint,lower),.63*width));
        float reach=clamp((body.x-p.x)/(body.x-upper.x),0.,1.06);
        float wave=beat-1.55*reach;
        vec2 sweep=vec2(19.*sin(wave),6.*sin(wave+.64));
        return max(stalk,lobes)*pow(reach,1.65)*sweep;
      }

      void main() {
        vec2 p=uv*size, shift=vec2(0.);

        if(p.x>620. && p.x<1210. && p.y>518. && p.y<779.) {
          shift+=sharkStroke(p,vec2(1130.,668.),vec2(851.,684.),
                             vec2(702.,577.),vec2(810.,731.),45.,18.*phase+.42);
        }
        if(p.x>475. && p.x<1040. && p.y>330. && p.y<555.) {
          shift+=sharkStroke(p,vec2(955.,411.),vec2(639.,447.),
                             vec2(537.,385.),vec2(596.,516.),35.,20.*phase+2.3);
        }

        if(p.x>1600. && p.x<2065. && p.y>420. && p.y<622.) {
          float beat=25.*phase+.7;
          float effort=.82+.18*cos(4.*phase+.4);
          shift+=finStroke(p,vec2(1743.,488.),vec2(1692.,533.),43.,beat,.24*effort);
          shift+=finStroke(p,vec2(1819.,489.),vec2(1880.,551.),38.,beat+.19,-.19*effort);
          shift+=finStroke(p,vec2(1865.,521.),vec2(1991.,545.),18.,beat-.42,.033);
        }
        if(p.x>1710. && p.x<2070. && p.y>706. && p.y<925.) {
          float beat=27.*phase+2.6;
          float effort=.83+.17*cos(5.*phase+1.1);
          shift+=finStroke(p,vec2(1878.,829.),vec2(1979.,742.),46.,beat,-.21*effort);
          shift+=finStroke(p,vec2(1845.,840.),vec2(1796.,868.),28.,beat+.16,.17*effort);
        }

        if(p.x>1250. && p.x<1795. && p.y>595. && p.y<815.) {
          vec2 shoal=finCoordinates(p,vec2(1333.,744.),vec2(1685.,657.));
          float drift=10.*phase-1.2*shoal.x;
          shift+=finBand(shoal,47.)*vec2(4.5*sin(drift),2.1*sin(drift+.48));
        }
        if(p.x>1270. && p.x<2130. && p.y>423. && p.y<696.) {
          shift+=finStroke(p,vec2(1466.,456.),vec2(1432.,470.),14.,53.*phase+.45,.18);
          shift+=finStroke(p,vec2(1373.,573.),vec2(1411.,561.),15.,56.*phase+2.5,.14);
          shift+=finStroke(p,vec2(1490.,588.),vec2(1457.,592.),13.,59.*phase+1.2,.15);
          shift+=finStroke(p,vec2(2053.,639.),vec2(1998.,650.),19.,47.*phase+4.,.13);
        }

        gl_FragColor=texture2D(panorama,(p-strength*shift)/size);
      }
    `);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const point = gl.getAttribLocation(program, 'point');
    gl.enableVertexAttribArray(point);
    gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, photo);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Panorama texture is unavailable');
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(gl.getUniformLocation(program, 'size'), photo.naturalWidth, photo.naturalHeight);
    const phase = gl.getUniformLocation(program, 'phase');
    const strength = gl.getUniformLocation(program, 'strength');
    const cycle = 72;
    return seconds => {
      gl.uniform1f(phase, (seconds % cycle) * (2 * Math.PI / cycle));
      const ramp = Math.min(1, seconds / 1.4);
      gl.uniform1f(strength, ramp * ramp * (3 - 2 * ramp));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
  }

  toggle.addEventListener('click', () => {
    userPaused = !userPaused;
    update();
  });
  preference.addEventListener('change', update);
  document.addEventListener('visibilitychange', update);
  canvas.addEventListener('webglcontextlost', () => {
    paint = null;
    update();
  });
  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    update();
  }).observe(hero);
  update();
})();
