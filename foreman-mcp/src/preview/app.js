/* Foreman live diagram preview — client-side.
 * Renders the .mmd source with the vendored mermaid (window.mermaid), then
 * re-renders on every SSE "reload" event. Keeps the last good render on parse error.
 * Runs under CSP: default-src 'none'; script-src 'self'; no eval. */
(function () {
  "use strict";
  var body = document.body;
  var id = body.getAttribute("data-id");
  var token = body.getAttribute("data-token");
  var theme = body.getAttribute("data-theme") || "default";
  var base = "/t/" + token;

  var diagramEl = document.getElementById("diagram");
  var errorEl = document.getElementById("error");
  var metaEl = document.getElementById("meta");
  var counter = 0;
  var rendering = false;
  var pending = false;

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
          diagramEl.innerHTML = out.svg;
          if (typeof out.bindFunctions === "function") out.bindFunctions(diagramEl);
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

  render();
  connect();
})();
