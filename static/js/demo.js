/* Interactive deocclusion + recomposition demo
 * Fully static: results are precomputed and listed in static/examples/examples.json.
 * Every object layer is a full-frame RGBA image aligned to the input, so recomposition is
 * alpha-compositing back-to-front with a per-object transform (offset, scale, flip).
 */
(() => {
  const EXAMPLES_URL = "static/examples/examples.json";
  const STEP_MS = 450;          // pacing of the pipeline animation
  const ALL = "All";
  // Paper's taxonomy (Fig. 1) first; any other category in examples.json follows.
  const CATEGORY_ORDER = ["Hidden by object", "Interlocked", "Cut by frame"];
  const SCALE_STEP = 1.1;
  const MIN_SCALE = 0.3, MAX_SCALE = 3;

  const $ = (id) => document.getElementById(id);
  const els = {
    gallery: $("gallery"), panel: $("demo-panel"), canvas: $("viewer-canvas"),
    filters: $("scene-filters"), prev: $("scene-prev"), next: $("scene-next"), count: $("scene-count"),
    wrap: document.querySelector(".canvas-wrap"),
    overlay: $("overlay"), pipeline: $("pipeline"),
    deocclude: $("btn-deocclude"),
    layers: $("layers"), layerList: $("layer-list"),
    all: $("btn-all"), none: $("btn-none"),
    objectsBlock: $("objects-block"), objects: $("objects"),
    editBar: $("edit-bar"), hint: $("edit-hint"),
    tools: {
      forward: $("tool-forward"), backward: $("tool-backward"),
      smaller: $("tool-smaller"), bigger: $("tool-bigger"),
      flip: $("tool-flip"), hide: $("tool-hide"), layout: $("tool-layout"),
    },
    tabs: document.querySelectorAll(".tab"),
  };
  const ctx = els.canvas.getContext("2d");

  const state = {
    scenes: [], scene: null, images: null, view: "input", deoccluded: false, token: 0,
    filter: ALL, list: [],   // list = indices of scenes in the current filter
    objs: [],        // per object: {img, alpha, W, H, cx, cy, bbox, dx, dy, s, flip, visible}
    z: [],           // object indices, front -> back
    selected: -1,
    drag: null,      // {k, startX, startY, dx0, dy0, moved}
  };

  const url = (scene, rel) => `${scene.dir}/${rel}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const loadImg = (src) => new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`Failed to load ${src}`));
    im.src = src;
  });

  // ---------------------------------------------------------------- init
  async function init() {
    try {
      const res = await fetch(EXAMPLES_URL);
      if (!res.ok) throw new Error(res.statusText);
      state.scenes = (await res.json()).scenes;
    } catch (e) {
      els.gallery.innerHTML = `<p class="muted">Could not load examples (${e.message}).
        If you opened index.html directly from disk, serve it instead: <code>python -m http.server</code></p>`;
      return;
    }
    bindUI();
    setFilter(ALL);
  }

  // ---------------------------------------------------------------- scene browser
  const categoryOf = (s) => s.category || "Other";

  function renderFilters() {
    const present = [...new Set(state.scenes.map(categoryOf))];
    const cats = [...CATEGORY_ORDER.filter((c) => present.includes(c)),
                  ...present.filter((c) => !CATEGORY_ORDER.includes(c))];
    els.filters.innerHTML = "";
    if (cats.length < 2) return;            // no filters needed for a single category
    [ALL, ...cats].forEach((c) => {
      const n = c === ALL ? state.scenes.length : state.scenes.filter((s) => categoryOf(s) === c).length;
      const b = document.createElement("button");
      b.className = "chip";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(c === state.filter));
      b.innerHTML = `${c}<span class="n">${n}</span>`;
      b.onclick = () => setFilter(c);
      els.filters.appendChild(b);
    });
  }

  function setFilter(c) {
    state.filter = c;
    state.list = state.scenes.map((_, i) => i)
      .filter((i) => c === ALL || categoryOf(state.scenes[i]) === c);
    renderFilters();
    renderGallery();
    const cur = state.scenes.indexOf(state.scene);
    if (state.list.length && !state.list.includes(cur)) selectScene(state.list[0]);
    else updateBrowser();
  }

  function renderGallery() {
    els.gallery.innerHTML = "";
    state.list.forEach((i) => {
      const s = state.scenes[i];
      const b = document.createElement("button");
      b.className = "thumb";
      b.dataset.i = i;
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", "false");
      b.title = s.title;
      b.innerHTML = `<img loading="lazy" src="${url(s, s.thumb || s.input)}" alt=""><span>${s.title}</span>`;
      b.onclick = () => selectScene(i);
      els.gallery.appendChild(b);
    });
  }

  function step(dir) {
    const pos = state.list.indexOf(state.scenes.indexOf(state.scene));
    const next = state.list[pos + dir];
    if (next !== undefined) selectScene(next);
  }

  function updateBrowser() {
    const cur = state.scenes.indexOf(state.scene);
    const pos = state.list.indexOf(cur);
    els.count.textContent = state.list.length ? `${pos + 1} of ${state.list.length}` : "";
    els.prev.disabled = pos <= 0;
    els.next.disabled = pos < 0 || pos >= state.list.length - 1;
    els.gallery.querySelectorAll(".thumb").forEach((t) => {
      const on = +t.dataset.i === cur;
      t.setAttribute("aria-selected", String(on));
      if (on) {
        const g = els.gallery, l = t.offsetLeft - g.offsetLeft, r = l + t.offsetWidth;
        if (l < g.scrollLeft) g.scrollLeft = l - 8;
        else if (r > g.scrollLeft + g.clientWidth) g.scrollLeft = r - g.clientWidth + 8;
      }
    });
  }

  function bindUI() {
    els.deocclude.onclick = deocclude;
    els.prev.onclick = () => step(-1);
    els.next.onclick = () => step(+1);
    els.gallery.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault(); e.stopPropagation();
        step(e.key === "ArrowLeft" ? -1 : 1);
        els.gallery.querySelector('[aria-selected="true"]')?.focus();
      }
    });
    els.tabs.forEach((t) => (t.onclick = () => setView(t.dataset.view)));
    els.all.onclick = () => setAll(true);
    els.none.onclick = () => setAll(false);

    const T = els.tools;
    T.forward.onclick = () => moveZ(state.selected, -1);
    T.backward.onclick = () => moveZ(state.selected, +1);
    T.bigger.onclick = () => rescale(state.selected, SCALE_STEP);
    T.smaller.onclick = () => rescale(state.selected, 1 / SCALE_STEP);
    T.flip.onclick = () => { const o = state.objs[state.selected]; if (o) { o.flip = !o.flip; draw(); } };
    T.hide.onclick = () => setVisible(state.selected, false);
    T.layout.onclick = resetLayout;

    els.canvas.addEventListener("pointerdown", onPointerDown);
    els.canvas.addEventListener("pointermove", onPointerMove);
    els.canvas.addEventListener("pointerup", onPointerUp);
    els.canvas.addEventListener("pointercancel", onPointerUp);
    els.canvas.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("keydown", onKey);
  }

  // ---------------------------------------------------------------- scene selection
  async function selectScene(i) {
    const token = ++state.token;               // cancels any in-flight deocclusion
    state.scene = state.scenes[i];
    state.images = null;
    state.objs = []; state.z = []; state.selected = -1;
    state.deoccluded = false;
    updateBrowser();

    els.overlay.hidden = true;
    els.layers.hidden = true;
    els.editBar.hidden = true;
    els.panel.classList.remove("has-layers");
    els.objectsBlock.hidden = true;
    els.deocclude.hidden = false;
    els.deocclude.disabled = false;
    setTabsEnabled(false);

    const input = await loadImg(url(state.scene, state.scene.input));
    if (token !== state.token) return;
    state.images = { input };
    setView("input");
  }

  // ---------------------------------------------------------------- deocclusion
  async function deocclude() {
    const token = state.token;
    const s = state.scene;
    els.deocclude.disabled = true;
    els.overlay.hidden = false;
    const steps = [...els.pipeline.children];
    steps.forEach((li) => (li.className = ""));

    const loading = Promise.all([
      loadImg(url(s, s.background)),
      ...s.objects.map((o) => loadImg(url(s, o.amodal))),
    ]);

    for (const li of steps) {
      li.className = "running";
      await sleep(STEP_MS);
      if (token !== state.token) return;
      if (li === steps[steps.length - 1]) await loading.catch(() => {});
      li.className = "done";
    }

    let loaded;
    try { loaded = await loading; }
    catch (e) {
      els.overlay.hidden = true;
      els.deocclude.disabled = false;
      alert(e.message);
      return;
    }
    if (token !== state.token) return;

    const [background, ...objImgs] = loaded;
    state.images.background = background;
    state.objs = objImgs.map((img, k) => prepareObject(img, s.objects[k].origin));
    resetLayout(false);
    state.deoccluded = true;

    await sleep(250);
    els.overlay.hidden = true;
    els.deocclude.hidden = true;
    els.editBar.hidden = false;
    setTabsEnabled(true);
    renderObjects();
    setView("composite");
  }

  // Read the alpha channel once so clicks hit only the object's real pixels.
  // origin: top-left of the layer in input pixels (outpainted layers can be larger than the input).
  function prepareObject(img, origin = [0, 0]) {
    const W = img.naturalWidth, H = img.naturalHeight;
    const off = document.createElement("canvas");
    off.width = W; off.height = H;
    const octx = off.getContext("2d", { willReadFrequently: true });
    octx.drawImage(img, 0, 0);
    const data = octx.getImageData(0, 0, W, H).data;
    const alpha = new Uint8Array(W * H);
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0, p = 3; y < H; y++) {
      for (let x = 0; x < W; x++, p += 4) {
        const a = data[p];
        alpha[y * W + x] = a;
        if (a > 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
    const [ox, oy] = origin;
    return {
      img, alpha, W, H, ox, oy,
      bbox: { x0: x0 + ox, y0: y0 + oy, x1: x1 + ox, y1: y1 + oy },   // input coordinates
      cx: (x0 + x1) / 2 + ox, cy: (y0 + y1) / 2 + oy,
      dx: 0, dy: 0, s: 1, flip: false, visible: true,
    };
  }

  function resetLayout(redraw = true) {
    state.objs.forEach((o) => { o.dx = 0; o.dy = 0; o.s = 1; o.flip = false; o.visible = true; });
    // original order: highest layer (closest to camera) first
    state.z = state.scene.objects.map((_, k) => k)
      .sort((a, b) => state.scene.objects[b].layer - state.scene.objects[a].layer);
    state.selected = -1;
    if (redraw) { renderLayers(); updateTools(); setView("composite"); }
    else renderLayers();
  }

  // ---------------------------------------------------------------- views + drawing
  function setTabsEnabled(on) {
    els.tabs.forEach((t) => { if (t.dataset.view !== "input") t.disabled = !on; });
  }

  function setView(view) {
    state.view = view;
    els.tabs.forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    els.wrap.classList.toggle("editable", view === "composite" && state.deoccluded);
    updateTools();
    draw();
  }

  function applyTransform(o) {
    ctx.translate(o.cx + o.dx, o.cy + o.dy);
    ctx.scale(o.s * (o.flip ? -1 : 1), o.s);
    ctx.translate(-o.cx, -o.cy);
  }

  function draw() {
    const im = state.images;
    if (!im || !im.input) return;
    const W = im.input.naturalWidth, H = im.input.naturalHeight;
    if (els.canvas.width !== W || els.canvas.height !== H) { els.canvas.width = W; els.canvas.height = H; }
    ctx.clearRect(0, 0, W, H);

    if (state.view === "input" || !state.deoccluded) { ctx.drawImage(im.input, 0, 0, W, H); return; }
    ctx.drawImage(im.background, 0, 0, W, H);
    if (state.view === "background") return;

    // back -> front
    for (let i = state.z.length - 1; i >= 0; i--) {
      const o = state.objs[state.z[i]];
      if (!o.visible) continue;
      ctx.save(); applyTransform(o); ctx.drawImage(o.img, o.ox, o.oy); ctx.restore();
    }

    // selection outline
    const o = state.objs[state.selected];
    if (o && o.visible) {
      const { x0, y0, x1, y1 } = o.bbox;
      const lw = Math.max(2, W / 400);
      ctx.save(); applyTransform(o);
      ctx.lineWidth = lw / o.s;
      ctx.setLineDash([lw * 4 / o.s, lw * 3 / o.s]);
      ctx.strokeStyle = "#3d5a80";
      ctx.strokeRect(x0 - lw, y0 - lw, x1 - x0 + 2 * lw, y1 - y0 + 2 * lw);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- hit testing + pointer
  function canvasPoint(e) {
    const r = els.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (els.canvas.width / r.width),
      y: (e.clientY - r.top) * (els.canvas.height / r.height),
    };
  }

  // Topmost visible object whose (transformed) alpha covers point p, else -1.
  function hitTest(p) {
    for (const k of state.z) {
      const o = state.objs[k];
      if (!o.visible) continue;
      const f = o.flip ? -1 : 1;
      const x = Math.round((p.x - o.cx - o.dx) / (o.s * f) + o.cx - o.ox);
      const y = Math.round((p.y - o.cy - o.dy) / o.s + o.cy - o.oy);
      if (x >= 0 && y >= 0 && x < o.W && y < o.H && o.alpha[y * o.W + x] > 127) return k;
    }
    return -1;
  }

  function onPointerDown(e) {
    if (state.view !== "composite" || !state.deoccluded) return;
    const p = canvasPoint(e);
    const k = hitTest(p);
    select(k);
    if (k < 0) return;
    const o = state.objs[k];
    state.drag = { k, startX: p.x, startY: p.y, dx0: o.dx, dy0: o.dy };
    els.canvas.setPointerCapture(e.pointerId);
    els.wrap.classList.add("dragging");
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!state.drag) return;
    const p = canvasPoint(e);
    const o = state.objs[state.drag.k];
    o.dx = state.drag.dx0 + (p.x - state.drag.startX);
    o.dy = state.drag.dy0 + (p.y - state.drag.startY);
    draw();
  }

  function onPointerUp(e) {
    if (!state.drag) return;
    state.drag = null;
    els.wrap.classList.remove("dragging");
    try { els.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }

  // Ctrl/⌘ + wheel resizes the selected object (plain wheel still scrolls the page).
  function onWheel(e) {
    if (state.selected < 0 || state.view !== "composite" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    rescale(state.selected, e.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP);
  }

  function onKey(e) {
    if (state.selected < 0 || state.view !== "composite") return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    const o = state.objs[state.selected];
    const step = (e.shiftKey ? 20 : 4) * (els.canvas.width / 800);
    const keys = {
      ArrowLeft: () => (o.dx -= step), ArrowRight: () => (o.dx += step),
      ArrowUp: () => (o.dy -= step), ArrowDown: () => (o.dy += step),
      PageUp: () => moveZ(state.selected, -1), PageDown: () => moveZ(state.selected, +1),
      Escape: () => select(-1),
    };
    if (!keys[e.key]) return;
    e.preventDefault();
    keys[e.key]();
    draw();
  }

  // ---------------------------------------------------------------- edit operations
  function select(k) {
    state.selected = k;
    els.layerList.querySelectorAll(".layer-item").forEach((li) =>
      li.classList.toggle("selected", +li.dataset.k === k));
    updateTools();
    draw();
  }

  function moveZ(k, dir) {          // dir -1 = toward the front, +1 = toward the back
    const i = state.z.indexOf(k), j = i + dir;
    if (i < 0 || j < 0 || j >= state.z.length) return;
    [state.z[i], state.z[j]] = [state.z[j], state.z[i]];
    renderLayers();
    updateTools();
    if (state.view !== "composite") setView("composite"); else draw();
  }

  function rescale(k, factor) {
    const o = state.objs[k];
    if (!o) return;
    o.s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, o.s * factor));
    draw();
  }

  function setVisible(k, on) {
    const o = state.objs[k];
    if (!o) return;
    o.visible = on;
    const cb = els.layerList.querySelector(`input[data-k="${k}"]`);
    if (cb) cb.checked = on;
    if (!on && state.selected === k) select(-1);
    if (state.view !== "composite") setView("composite"); else draw();
  }

  function setAll(on) {
    state.objs.forEach((_, k) => setVisible(k, on));
  }

  function updateTools() {
    const k = state.selected, T = els.tools;
    const editable = state.view === "composite" && state.deoccluded;
    const has = editable && k >= 0;
    const i = state.z.indexOf(k);
    T.forward.disabled = !has || i <= 0;
    T.backward.disabled = !has || i >= state.z.length - 1;
    [T.smaller, T.bigger, T.flip, T.hide].forEach((b) => (b.disabled = !has));
    T.layout.disabled = !state.deoccluded;
    els.hint.innerHTML = !editable
      ? "Switch to <strong>Recomposed</strong> to edit the scene."
      : has
        ? `<strong>${state.scene.objects[k].name}</strong> selected. Drag to move, arrow keys to nudge, Ctrl + scroll to resize.`
        : "Drag an object to move it, or click it to select.";
  }

  // ---------------------------------------------------------------- panels
  function renderLayers() {
    const s = state.scene;
    els.layerList.innerHTML = "";
    state.z.forEach((k, i) => {
      const o = s.objects[k];
      const li = document.createElement("li");
      li.innerHTML = `<div class="layer-item${k === state.selected ? " selected" : ""}" data-k="${k}">
          <input type="checkbox" ${state.objs[k]?.visible !== false ? "checked" : ""} data-k="${k}" aria-label="Show ${o.name}">
          <img class="checker" src="${url(s, o.amodal)}" alt="">
          <span class="name">${o.name}</span>
          <span class="z">
            <button aria-label="Bring ${o.name} forward" ${i === 0 ? "disabled" : ""}><svg viewBox="0 0 12 12"><path d="M2 8l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <button aria-label="Send ${o.name} backward" ${i === state.z.length - 1 ? "disabled" : ""}><svg viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          </span>
        </div>`;
      const item = li.firstElementChild;
      const [up, down] = item.querySelectorAll(".z button");
      item.querySelector("input").onchange = (e) => setVisible(k, e.target.checked);
      item.querySelector("input").onclick = (e) => e.stopPropagation();
      up.onclick = (e) => { e.stopPropagation(); moveZ(k, -1); };
      down.onclick = (e) => { e.stopPropagation(); moveZ(k, +1); };
      item.onclick = () => {
        if (state.view !== "composite") setView("composite");
        if (state.objs[k].visible) select(k);
      };
      els.layerList.appendChild(li);
    });
    els.layers.hidden = false;
    els.panel.classList.add("has-layers");
  }

  function renderObjects() {
    const s = state.scene;
    els.objects.innerHTML = "";
    state.z.forEach((k) => {
      const o = s.objects[k];
      const card = document.createElement("div");
      card.className = "obj-card";
      card.innerHTML = `<div class="imgs checker">
          <img class="amodal" src="${url(s, o.crop_amodal || o.amodal)}" alt="${o.name} (completed)">
          <img class="modal"  src="${url(s, o.crop_modal  || o.modal)}"  alt="${o.name} (visible part)">
        </div>
        <div class="meta"><span>${o.name}</span><span class="state"></span></div>`;
      card.onclick = () => card.classList.toggle("show-modal");   // tap support on mobile
      els.objects.appendChild(card);
    });
    els.objectsBlock.hidden = false;
  }

  // ---------------------------------------------------------------- BibTeX copy
  const copyBtn = $("btn-copy");
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText($("bibtex").innerText);
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy BibTeX"), 1500);
    } catch { /* clipboard unavailable */ }
  };

  // ---------------------------------------------------------------- top bar
  const topbar = $("topbar");
  const hero = document.querySelector(".hero");
  const navLinks = [...document.querySelectorAll(".nav-links a")];
  const onScroll = () => {
    topbar.classList.toggle("scrolled", window.scrollY > hero.offsetTop + hero.offsetHeight - 80);
    let current = null;
    for (const a of navLinks) {
      const sec = document.querySelector(a.getAttribute("href"));
      if (sec && sec.getBoundingClientRect().top < window.innerHeight * 0.35) current = a;
    }
    navLinks.forEach((a) => a.classList.toggle("active", a === current));
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  init();
})();
