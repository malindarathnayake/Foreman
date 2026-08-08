/* Foreman live diagram preview — client-side.
 * Renders the .mmd source with the vendored mermaid (window.mermaid), then
 * re-renders on every SSE "reload" event. Keeps the last good render on parse error.
 * Adds zoom (wheel / buttons / keys), pan (drag), and client-side export
 * (PNG via canvas, SVG, raw .mmd). Runs under CSP: default-src 'none';
 * script-src 'self'; img-src 'self' data:; no eval — PNG export therefore
 * rasterizes through a data: URL image, never a remote fetch. */
(function () {
  "use strict";
  var body = document.body;
  var id = body.getAttribute("data-id");
  var token = body.getAttribute("data-token");
  var theme = body.getAttribute("data-theme") || "default";
  var base = "/t/" + token;

  var viewportEl = document.getElementById("diagram");
  var canvasEl = document.getElementById("canvas");
  var errorEl = document.getElementById("error");
  var metaEl = document.getElementById("meta");
  var counter = 0;
  var rendering = false;
  var pending = false;

  // ── zoom/pan state ──────────────────────────────────────────────────────────
  var MIN_SCALE = 0.05;
  var MAX_SCALE = 12;
  var scale = 1;
  var tx = 0;
  var ty = 0;
  var natW = 0; // natural (unscaled) diagram size from the svg viewBox
  var natH = 0;
  var hasRendered = false;

  function setMeta(text) {
    metaEl.textContent = text;
  }

  if (!window.mermaid) {
    errorEl.hidden = false;
    errorEl.textContent = "mermaid failed to load";
    setMeta("error");
    return;
  }

  window.mermaid.initialize({
    startOnLoad: false,
    theme: theme,
    securityLevel: "strict",
  });

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function applyTransform() {
    canvasEl.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
    var pct = document.getElementById("zoom-reset");
    if (pct) pct.textContent = Math.round(scale * 100) + "%";
  }

  /* Zoom keeping the viewport point (cx, cy) stationary. */
  function zoomAt(cx, cy, factor) {
    var next = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
    factor = next / scale;
    if (factor === 1) return;
    tx = cx - (cx - tx) * factor;
    ty = cy - (cy - ty) * factor;
    scale = next;
    applyTransform();
  }

  function zoomCentered(factor) {
    zoomAt(viewportEl.clientWidth / 2, viewportEl.clientHeight / 2, factor);
  }

  function centerAt(targetScale) {
    scale = clamp(targetScale, MIN_SCALE, MAX_SCALE);
    tx = (viewportEl.clientWidth - natW * scale) / 2;
    ty = (viewportEl.clientHeight - natH * scale) / 2;
    applyTransform();
  }

  /* Fit the diagram in the viewport. maxScale caps upscaling (initial view
   * never blows a small diagram past 100%); the Fit button passes none. */
  function fitView(maxScale) {
    if (!natW || !natH) return;
    var pad = 40;
    var s = Math.min(
      (viewportEl.clientWidth - pad) / natW,
      (viewportEl.clientHeight - pad) / natH
    );
    if (maxScale) s = Math.min(s, maxScale);
    centerAt(s);
  }

  /* Give the mermaid svg its natural pixel size so the wrapper transform is
   * the single source of scale (mermaid emits width:100% + max-width inline). */
  function normalizeSvg() {
    var svg = canvasEl.querySelector("svg");
    if (!svg) return;
    var vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width && vb.height) {
      natW = vb.width;
      natH = vb.height;
    } else {
      var r = svg.getBoundingClientRect();
      natW = r.width / scale;
      natH = r.height / scale;
    }
    svg.setAttribute("width", String(natW));
    svg.setAttribute("height", String(natH));
    svg.style.maxWidth = "none";
  }

  function render() {
    if (rendering) {
      pending = true;
      return;
    }
    rendering = true;
    fetch(base + "/api/source/" + id, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("source HTTP " + r.status);
        return r.text();
      })
      .then(function (src) {
        var gid = "mmd-" + ++counter;
        return window.mermaid.render(gid, src).then(function (out) {
          canvasEl.innerHTML = out.svg;
          if (typeof out.bindFunctions === "function") out.bindFunctions(canvasEl);
          normalizeSvg();
          if (!hasRendered) {
            hasRendered = true;
            fitView(1); // first paint: fit if oversized, else 100%, centered
          }
          errorEl.hidden = true;
          setMeta("updated " + new Date().toLocaleTimeString());
        });
      })
      .catch(function (e) {
        // Keep the last good render; surface the error non-destructively.
        errorEl.hidden = false;
        errorEl.textContent = e && e.message ? e.message : String(e);
        setMeta("error " + new Date().toLocaleTimeString());
      })
      .then(function () {
        rendering = false;
        if (pending) {
          pending = false;
          render();
        }
      });
  }

  function connect() {
    var es = new EventSource(base + "/events/" + id);
    es.onmessage = function (ev) {
      if (ev.data === "reload") render();
    };
    es.onopen = function () {
      setMeta("live");
    };
    es.onerror = function () {
      setMeta("reconnecting…"); // EventSource auto-reconnects
    };
  }

  // ── pan (pointer drag) ──────────────────────────────────────────────────────
  var panPointer = -1;
  var panStartX = 0;
  var panStartY = 0;
  var panStartTx = 0;
  var panStartTy = 0;

  viewportEl.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    panPointer = e.pointerId;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartTx = tx;
    panStartTy = ty;
    viewportEl.classList.add("panning");
    viewportEl.setPointerCapture(e.pointerId);
  });
  viewportEl.addEventListener("pointermove", function (e) {
    if (e.pointerId !== panPointer) return;
    tx = panStartTx + (e.clientX - panStartX);
    ty = panStartTy + (e.clientY - panStartY);
    applyTransform();
  });
  function endPan(e) {
    if (e.pointerId !== panPointer) return;
    panPointer = -1;
    viewportEl.classList.remove("panning");
  }
  viewportEl.addEventListener("pointerup", endPan);
  viewportEl.addEventListener("pointercancel", endPan);

  // ── wheel zoom (cursor-centered; also catches trackpad pinch as ctrl+wheel) ─
  viewportEl.addEventListener(
    "wheel",
    function (e) {
      e.preventDefault();
      var rect = viewportEl.getBoundingClientRect();
      var factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    },
    { passive: false }
  );

  // ── toolbar ─────────────────────────────────────────────────────────────────
  function on(idName, fn) {
    var el = document.getElementById(idName);
    if (el) el.addEventListener("click", fn);
  }
  on("zoom-in", function () { zoomCentered(1.25); });
  on("zoom-out", function () { zoomCentered(0.8); });
  on("zoom-reset", function () { centerAt(1); });
  on("zoom-fit", function () { fitView(); });
  on("export-png", exportPng);
  on("export-svg", exportSvg);
  on("export-mmd", exportMmd);

  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomCentered(1.25);
    else if (e.key === "-") zoomCentered(0.8);
    else if (e.key === "0") centerAt(1);
    else if (e.key === "f") fitView();
    else return;
    e.preventDefault();
  });

  // ── export ──────────────────────────────────────────────────────────────────
  function downloadBlob(blob, name) {
    var a = document.createElement("a");
    var u = URL.createObjectURL(blob);
    a.href = u;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(u);
    }, 2000);
  }

  function serializeSvg() {
    var svg = canvasEl.querySelector("svg");
    if (!svg) return null;
    var clone = svg.cloneNode(true);
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
  }

  function exportSvg() {
    var xml = serializeSvg();
    if (!xml) return;
    downloadBlob(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }), id + ".svg");
  }

  function exportPng() {
    var xml = serializeSvg();
    if (!xml || !natW || !natH) return;
    // 2x for crispness, capped so neither edge exceeds the safe canvas limit.
    var exportScale = Math.min(2, 8192 / Math.max(natW, natH));
    var img = new Image();
    img.onload = function () {
      try {
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(natW * exportScale));
        c.height = Math.max(1, Math.round(natH * exportScale));
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff"; // page background — avoids transparent PNGs with unreadable text
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(function (blob) {
          if (blob) downloadBlob(blob, id + ".png");
          else pngFallback();
        }, "image/png");
      } catch (e) {
        pngFallback(); // tainted canvas (foreignObject edge cases) → ship the SVG
      }
    };
    img.onerror = pngFallback;
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  }

  function pngFallback() {
    setMeta("PNG export unavailable in this browser — exported SVG instead");
    exportSvg();
  }

  function exportMmd() {
    fetch(base + "/api/source/" + id, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("source HTTP " + r.status);
        return r.text();
      })
      .then(function (src) {
        downloadBlob(new Blob([src], { type: "text/plain;charset=utf-8" }), id + ".mmd");
      })
      .catch(function (e) {
        errorEl.hidden = false;
        errorEl.textContent = e && e.message ? e.message : String(e);
      });
  }

  render();
  connect();
})();
