/* lawnotes / sidenotes.js
 *
 * Progressive-enhancement footnote display for Janeway's stock JATS markup.
 *
 * Layer 1 (always on, narrow viewports): the canonical numbered endnote list
 *     at the bottom of the article -- whatever the XSLT emits, untouched.
 *
 * Layer 2 (any viewport, on demand): hover/tap/focus a marker → tooltip
 *     showing the note, anchored to the marker, dismissable with × / Esc /
 *     outside-click. Suppressed automatically when Layer 3 is active so they
 *     don't compete.
 *
 * Layer 3 (≥1280px): an overlay layer holds an <aside> per footnote,
 *     absolute-positioned in the page margin and alternated odd→right /
 *     even→left.  Stacks vertically when multiple notes land near the same
 *     Y; long notes collapse to a "more" toggle.  Built/torn-down on
 *     viwport changes via matchMedia.
 *
 * Plus, regardless of breakpoint:
 *
 *   - The galley file links (View PDF / XML / Download) are cloned into a
 *     fresh block right under the abstract.
 *   - A discreet "Article details ›" toggle re-extends the right sidebar.
 */
(function () {
  "use strict";

  /* ============================================================
     Config
     ============================================================
     Runtime values come from window.lawsnotesSettings, populated by the
     plugin's head_css hook from per-journal Setting rows. Editors
     can change these from the manage page without code edits;
     fallbacks here keep the script working if the hook didn't run
     (e.g. local debugging in isolation). */

  var SETTINGS = (window.lawsnotesSettings && typeof window.lawsnotesSettings === "object")
    ? window.lawsnotesSettings : {};
  var BREAKPOINT = "(min-width: " + (SETTINGS.sidenoteBreakpoint || 1280) + "px)";
  var SIDENOTE_WIDTH = SETTINGS.sidenoteWidth || 220;
  var MIN_TEXT_GAP = 24;
  var STACK_GAP = 14;
  var FOLD_HEIGHT = 240;

  /* Public ready-hook: editor-supplied custom JS (via the manage
     page's Custom JavaScript field, or the URL field) runs after
     lawsnotes.js's start(). Anything attaching during start() can call
     window.lawsnotesOnReady(fn) to register additional behaviour, and
     fn(api) is invoked once start() has finished -- with a small
     stable API surface so post-deployment patches don't have to
     reach into private state.

     If the editor's snippet runs BEFORE start() finishes (rare,
     given DOMContentLoaded ordering with deferred scripts), the
     function is queued; if AFTER, it's invoked synchronously. */
  var _readyApi = null;
  var _readyQueue = [];
  window.lawsnotesOnReady = function (fn) {
    if (typeof fn !== "function") return;
    if (_readyApi) {
      try { fn(_readyApi); } catch (e) { console.error("[lawsnotes onReady]", e); }
    } else {
      _readyQueue.push(fn);
    }
  };
  function _flushReadyQueue(api) {
    _readyApi = api;
    var fns = _readyQueue;
    _readyQueue = [];
    fns.forEach(function (fn) {
      try { fn(api); } catch (e) { console.error("[lawsnotes onReady]", e); }
    });
  }

  var ARTICLE_SELECTOR = "#main_article";
  var BODY_SELECTOR = "#main_article > div[itemprop=\"articleBody\"]";
  // Match both the original anchored markers and our neutralised ones
  // (which no longer have href). neutraliseFootnoteHrefs runs before
  // anything else uses this selector.
  var MARKER_SELECTOR = "a.xref-fn";
  var BACKLINK_SELECTOR = "a.footnotemarker";

  /* ============================================================
     Helpers
     ============================================================ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function noteContent(target) {
    var clone = target.cloneNode(true);
    $$(BACKLINK_SELECTOR, clone).forEach(function (a) { a.remove(); });
    return clone;
  }

  /* ============================================================
     Layer 3: alternating sidenote overlay
     ============================================================ */

  var mq = window.matchMedia(BREAKPOINT);
  var sidenotesActive = false;
  var notes = [];
  var layer = null;
  var resizeTimer = null;

  function buildSidenotes() {
    if (sidenotesActive) return;
    var article = $(ARTICLE_SELECTOR);
    if (!article) return;
    var markers = $$(MARKER_SELECTOR, article);
    if (!markers.length) return;

    layer = document.createElement("div");
    layer.className = "lawsnotes-sidenote-layer";
    document.body.appendChild(layer);

    var idx = 0;
    markers.forEach(function (marker) {
      var href = marker.dataset.lawsnotesHref || marker.getAttribute("href") || "";
      if (href.charAt(0) !== "#") return;
      var target = document.getElementById(href.substring(1));
      if (!target) return;

      var side = idx % 2 === 0 ? "right" : "left";
      var aside = document.createElement("aside");
      aside.className = "lawsnotes-sidenote lawsnotes-sidenote--" + side;
      aside.setAttribute("role", "doc-footnote");
      aside.id = "lawsnotes-sn-" + idx;

      // Number lives INSIDE the body so the body can be display:block.
      // A block body inherits the aside's 220px width and gives the
      // inline note content (and any anchors inside) a constrained line
      // box -- which is what overflow-wrap: anywhere actually needs in
      // order to break long URLs.  When the number was a sibling and
      // .body was display:inline, the line box was unbounded and URLs
      // overflowed the aside.
      var body = document.createElement("div");
      body.className = "lawsnotes-sidenote-body";

      var num = document.createElement("span");
      num.className = "lawsnotes-sidenote-number";
      num.textContent = (marker.textContent || "").trim() || (idx + 1);
      body.appendChild(num);

      var content = noteContent(target);
      while (content.firstChild) body.appendChild(content.firstChild);
      aside.appendChild(body);

      marker.dataset.lawnotesIdx = idx;
      aside.dataset.lawnotesIdx = idx;
      marker.classList.add("lawsnotes-has-sidenote");

      // Click handling is centralised in suppressFootnoteJump (capture
      // phase, document-level), which silences OLH's jQuery scroll
      // animation. Per-marker bindings here would be redundant -- and
      // attaching them in bubble phase doesn't help, since they fire
      // after OLH's animation.
      marker.addEventListener("mouseenter", highlightPair);
      marker.addEventListener("mouseleave", clearPair);

      // Click on the sidenote itself: jump back to its marker in the
      // body text, so the reader can find their place. Without this,
      // clicking the cloned `<a class="footnotemarker">` inside the
      // sidenote triggers the browser's default `#fnXXX-nm1` scroll,
      // which lands offscreen because the sidenote's own bounding box
      // is far from the marker's body position.
      aside.addEventListener("click", scrollToMarkerFromSidenote);
      aside.addEventListener("mouseenter", highlightPairFromAside);
      aside.addEventListener("mouseleave", clearPairFromAside);

      layer.appendChild(aside);
      notes.push({ marker: marker, aside: aside, side: side });
      idx++;
    });

    if (!notes.length) {
      layer.remove();
      layer = null;
      return;
    }

    document.body.classList.add("lawsnotes-sidenotes-active");
    addUrlBreakHints();      // hint on the freshly-cloned URLs
    foldLongNotes();
    layout();
    sidenotesActive = true;
    window.addEventListener("resize", onResize);
  }

  function teardownSidenotes() {
    if (!sidenotesActive) return;
    notes.forEach(function (n) {
      n.marker.removeEventListener("mouseenter", highlightPair);
      n.marker.removeEventListener("mouseleave", clearPair);
      n.marker.classList.remove("lawsnotes-has-sidenote");
      delete n.marker.dataset.lawnotesIdx;
    });
    if (layer) layer.remove();
    layer = null;
    notes = [];
    document.body.classList.remove("lawsnotes-sidenotes-active");
    sidenotesActive = false;
    window.removeEventListener("resize", onResize);
  }

  function foldLongNotes() {
    notes.forEach(function (n) {
      n.aside.style.maxHeight = "none";
      var h = n.aside.offsetHeight;
      if (h <= FOLD_HEIGHT) return;
      n.aside.classList.add("lawsnotes-sidenote--folded");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lawsnotes-sidenote-expand";
      btn.textContent = "more";
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-controls", n.aside.id);
      btn.addEventListener("click", function () {
        var expanded = n.aside.classList.toggle("lawsnotes-sidenote--expanded");
        btn.textContent = expanded ? "less" : "more";
        btn.setAttribute("aria-expanded", String(expanded));
        layout();
      });
      n.aside.appendChild(btn);
    });
  }

  function layout() {
    if (!notes.length) return;
    var bodyEl = $(BODY_SELECTOR);
    if (!bodyEl) return;

    var aRect = bodyEl.getBoundingClientRect();
    var scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    var scrollX = window.pageXOffset || document.documentElement.scrollLeft || 0;
    var vw = document.documentElement.clientWidth;
    // Paper edges = the centred white #content container, not the
    // viewport. Keeps sidenotes inside the paper rather than out on
    // the tinted page-margin gradient.
    var paperEl = document.querySelector("section#content");
    var pRect = paperEl ? paperEl.getBoundingClientRect() : null;
    var textLeft = aRect.left + scrollX;
    var textRight = aRect.right + scrollX;
    var paperLeft = pRect ? pRect.left + scrollX : scrollX;
    var paperRight = pRect ? pRect.right + scrollX : scrollX + vw;

    var rightSlack = paperRight - textRight;
    var leftSlack = textLeft - paperLeft;
    var rightX = textRight + Math.max(MIN_TEXT_GAP, (rightSlack - SIDENOTE_WIDTH) / 2);
    var leftX = paperLeft + Math.max(MIN_TEXT_GAP, (leftSlack - SIDENOTE_WIDTH) / 2);

    var lastBottom = { left: 0, right: 0 };
    notes.forEach(function (n) {
      var mRect = n.marker.getBoundingClientRect();
      var markerY = mRect.top + scrollY;
      var top = Math.max(markerY, lastBottom[n.side] + STACK_GAP);
      var left = n.side === "right" ? rightX : leftX;
      n.aside.style.top = top + "px";
      n.aside.style.left = left + "px";
      n.aside.style.width = SIDENOTE_WIDTH + "px";
      lastBottom[n.side] = top + n.aside.offsetHeight;
    });
  }

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!mq.matches) { teardownSidenotes(); return; }
      layout();
    }, 80);
  }

  function onBreakpoint() {
    if (mq.matches) buildSidenotes();
    else teardownSidenotes();
  }

  function preventJumpWhenActive(e) {
    if (!sidenotesActive) return;
    e.preventDefault();
    var idx = e.currentTarget.dataset.lawnotesIdx;
    if (idx == null) return;
    var aside = document.getElementById("lawsnotes-sn-" + idx);
    if (!aside) return;
    var rect = aside.getBoundingClientRect();
    var miniBar = document.querySelector(".mini-bar");
    var stickyTop = (miniBar ? miniBar.offsetHeight : 0);
    var vh = window.innerHeight;
    // Visible region (excluding the sticky bar) is from stickyTop to vh.
    // Only scroll if the aside is meaningfully outside that region.
    // `aside.scrollIntoView({block:"center"})` would re-trigger the
    // browser's smooth scroll on every click even when the aside is
    // already visible (the browser doesn't compare current vs target
    // and short-circuits a no-op), which is why repeated clicks were
    // shifting the page upward each time.
    var fullyVisible = rect.top >= stickyTop + 8 && rect.bottom <= vh - 8;
    if (!fullyVisible) {
      var target = window.pageYOffset + rect.top - stickyTop - 64;
      window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
    aside.classList.add("lawsnotes-sidenote--flash");
    setTimeout(function () { aside.classList.remove("lawsnotes-sidenote--flash"); }, 900);
  }

  function scrollToMarkerFromSidenote(e) {
    if (!sidenotesActive) return;
    // Don't hijack clicks on real outbound links inside the sidenote.
    var anchor = e.target.closest && e.target.closest("a[href]");
    if (anchor) {
      var href = anchor.getAttribute("href") || "";
      if (href && href.charAt(0) !== "#") return;
      // Inner anchor is a backlink (e.g. footnotemarker) -- intercept
      // and scroll using the marker's actual on-page position rather
      // than the browser's default jump (which gets confused by
      // sticky headers and the cloned aside layer).
      e.preventDefault();
    }
    var idx = e.currentTarget.dataset.lawnotesIdx;
    if (idx == null) return;
    var pair = notes[parseInt(idx, 10)];
    if (!pair || !pair.marker) return;
    // Use absolute coords so we land on the marker regardless of any
    // transforms / sticky offsets in between.
    var rect = pair.marker.getBoundingClientRect();
    var miniBar = document.querySelector(".mini-bar");
    var topOffset = (miniBar ? miniBar.offsetHeight : 0) + 24;
    var target = window.pageYOffset + rect.top - topOffset;
    window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    pair.marker.classList.add("lawsnotes-hover");
    setTimeout(function () { pair.marker.classList.remove("lawsnotes-hover"); }, 900);
  }

  function highlightPairFromAside(e) {
    var idx = e.currentTarget.dataset.lawnotesIdx;
    if (idx == null) return;
    var pair = notes[parseInt(idx, 10)];
    if (!pair) return;
    e.currentTarget.classList.add("lawsnotes-hover");
    if (pair.marker) pair.marker.classList.add("lawsnotes-hover");
  }
  function clearPairFromAside(e) {
    var idx = e.currentTarget.dataset.lawnotesIdx;
    if (idx == null) return;
    var pair = notes[parseInt(idx, 10)];
    if (!pair) return;
    e.currentTarget.classList.remove("lawsnotes-hover");
    if (pair.marker) pair.marker.classList.remove("lawsnotes-hover");
  }

  function highlightPair(e) {
    var idx = e.currentTarget.dataset.lawnotesIdx;
    if (idx == null) return;
    var aside = document.getElementById("lawsnotes-sn-" + idx);
    e.currentTarget.classList.add("lawsnotes-hover");
    if (aside) aside.classList.add("lawsnotes-hover");
  }

  function clearPair(e) {
    var idx = e.currentTarget.dataset.lawnotesIdx;
    if (idx == null) return;
    var aside = document.getElementById("lawsnotes-sn-" + idx);
    e.currentTarget.classList.remove("lawsnotes-hover");
    if (aside) aside.classList.remove("lawsnotes-hover");
  }

  /* ============================================================
     Layer 2: tooltip (hover / focus / click)
     ============================================================ */

  function initTooltips() {
    var article = $(ARTICLE_SELECTOR);
    if (!article) return;
    var markers = $$(MARKER_SELECTOR, article);
    if (!markers.length) return;

    var tooltip = document.createElement("div");
    tooltip.id = "lawsnotes-tooltip";
    tooltip.className = "lawsnotes-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.setAttribute("aria-hidden", "true");
    document.body.appendChild(tooltip);

    var hideTimer = null;
    var currentMarker = null;
    var pinned = false;
    var suppressFocusShow = false;

    function show(marker, opts) {
      // When sidenotes are active they replace the tooltip entirely.
      if (document.body.classList.contains("lawsnotes-sidenotes-active")) return;
      opts = opts || {};
      var href = marker.dataset.lawsnotesHref || marker.getAttribute("href") || "";
      if (!href || href.charAt(0) !== "#") return;
      var target = document.getElementById(href.substring(1));
      if (!target) return;

      pinned = !!opts.pinned;

      tooltip.innerHTML = "";
      var num = document.createElement("span");
      num.className = "lawsnotes-tooltip-num";
      num.textContent = (marker.textContent || "").trim();
      tooltip.appendChild(num);
      var content = noteContent(target);
      while (content.firstChild) tooltip.appendChild(content.firstChild);

      tooltip.classList.add("lawsnotes-tooltip--visible");
      tooltip.setAttribute("aria-hidden", "false");
      if (currentMarker && currentMarker !== marker) {
        currentMarker.removeAttribute("aria-describedby");
      }
      currentMarker = marker;
      marker.setAttribute("aria-describedby", tooltip.id);
      position(marker);
    }

    function position(marker) {
      tooltip.style.left = "0px";
      tooltip.style.top = "0px";
      var rect = marker.getBoundingClientRect();
      var ttRect = tooltip.getBoundingClientRect();
      var vw = document.documentElement.clientWidth;
      var vh = window.innerHeight;
      var margin = 8;
      var gap = 10;
      var scrollX = window.pageXOffset || document.documentElement.scrollLeft;
      var scrollY = window.pageYOffset || document.documentElement.scrollTop;
      var left = rect.left;
      var top = rect.bottom + gap;
      if (left + ttRect.width + margin > vw) left = Math.max(margin, vw - ttRect.width - margin);
      if (left < margin) left = margin;
      if (top + ttRect.height + margin > vh && rect.top - ttRect.height - gap > margin) {
        top = rect.top - ttRect.height - gap;
      }
      tooltip.style.left = (left + scrollX) + "px";
      tooltip.style.top = (top + scrollY) + "px";
    }

    function hide() {
      tooltip.classList.remove("lawsnotes-tooltip--visible");
      tooltip.setAttribute("aria-hidden", "true");
      if (currentMarker) {
        currentMarker.removeAttribute("aria-describedby");
        currentMarker = null;
      }
      pinned = false;
    }

    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { if (!pinned) hide(); }, 200);
    }
    function cancelHide() { clearTimeout(hideTimer); }

    markers.forEach(function (marker) {
      marker.addEventListener("mouseenter", function () {
        cancelHide();
        if (!pinned) show(marker);
      });
      marker.addEventListener("mouseleave", function () {
        if (!pinned) scheduleHide();
      });
      marker.addEventListener("focus", function () {
        if (suppressFocusShow) return;
        cancelHide();
        show(marker, { pinned: true });
      });
      marker.addEventListener("blur", function () {
        setTimeout(function () {
          if (!tooltip.contains(document.activeElement)) hide();
        }, 0);
      });
      // Click handling is centralised in suppressFootnoteJump (capture
      // phase) which calls window.lawsnotesShowTooltipForMarker -- below.
    });

    // Expose for the capture-phase click handler.
    window.lawsnotesShowTooltipForMarker = function (marker) {
      if (document.body.classList.contains("lawsnotes-sidenotes-active")) return;
      if (currentMarker === marker && pinned) { hide(); return; }
      cancelHide();
      show(marker, { pinned: true });
    };

    tooltip.addEventListener("mouseenter", cancelHide);
    tooltip.addEventListener("mouseleave", function () {
      if (!pinned) scheduleHide();
    });

    document.addEventListener("click", function (e) {
      if (!pinned) return;
      if (tooltip.contains(e.target)) return;
      if (currentMarker && currentMarker.contains(e.target)) return;
      hide();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && currentMarker) {
        var marker = currentMarker;
        hide();
        suppressFocusShow = true;
        marker.focus();
        setTimeout(function () { suppressFocusShow = false; }, 100);
      }
    });

    var reposition = function () {
      if (currentMarker && tooltip.classList.contains("lawsnotes-tooltip--visible")) {
        position(currentMarker);
      }
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, { passive: true });
  }

  /* ============================================================
     Chrome reshuffle: file links, article-details collapsible,
     DOI in how-to-cite, reflow observer
     ============================================================ */

  // Sidebar sections we already surface elsewhere or don't want in the
  // collapsible. Match against the section heading text.
  var SKIP_SECTION_RE = /^(Files|Authors?|Share|Identifiers|Table of Contents|Peer Review|File Checksums)/i;

  function relocateFileLinks() {
    var articleEl = document.getElementById("article");
    if (!articleEl) return;
    if ($(".lawsnotes-files", articleEl)) return;

    var listSource = null;
    var sidebarHeadings = $$("section.side-info .section h2");
    sidebarHeadings.forEach(function (h) {
      if (listSource) return;
      if (!/Files/i.test(h.textContent)) return;
      var ul = h.parentNode.querySelector("ul");
      if (ul) listSource = ul;
    });
    if (!listSource) {
      var smallUl = $("#article .show-for-small-only ul");
      if (smallUl) listSource = smallUl;
    }
    if (!listSource) return;

    var wrap = document.createElement("div");
    wrap.className = "lawsnotes-files";
    var clone = listSource.cloneNode(true);
    // Rewrite link text: drop icons + screen-reader spans (which throw
    // off the underline baseline because they're inline boxes inside
    // the <a>) and use clean labels: "View PDF", "Download PDF",
    // "Download XML". target=_blank → "View ...". Otherwise → "Download …".
    $$("a", clone).forEach(function (a) {
      var raw = (a.textContent || "").replace(/\s+/g, " ").trim();
      var ext = raw;
      // Best-effort: extract "PDF" / "XML" / "EPUB" from existing label.
      var m = raw.match(/\b(PDF|XML|EPUB|HTML)\b/i);
      if (m) ext = m[0].toUpperCase();
      // Drop XML entries entirely (View XML / Download XML).
      if (ext === "XML") {
        var li = a.closest("li");
        if (li && li.parentNode) li.parentNode.removeChild(li);
        return;
      }
      var prefix = a.target === "_blank" ? "View " : "Download ";
      // Wipe inner content (icons, SR spans, nbsp) and write plain text.
      while (a.firstChild) a.removeChild(a.firstChild);
      a.appendChild(document.createTextNode(prefix + ext));
    });
    wrap.appendChild(clone);

    var abstractHeading = null;
    $$("#article h3").forEach(function (h) {
      if (!abstractHeading && /abstract/i.test(h.textContent)) abstractHeading = h;
    });

    if (abstractHeading) {
      var node = abstractHeading.nextElementSibling;
      var lastAbstractNode = abstractHeading;
      while (node && (node.tagName === "P" || node.tagName === "DIV") &&
             !node.classList.contains("summary") &&
             !node.classList.contains("callout") &&
             node.id !== "main_article") {
        lastAbstractNode = node;
        node = node.nextElementSibling;
      }
      lastAbstractNode.parentNode.insertBefore(wrap, lastAbstractNode.nextSibling);
    } else {
      var mainArticle = document.getElementById("main_article");
      if (mainArticle && mainArticle.parentNode) {
        mainArticle.parentNode.insertBefore(wrap, mainArticle);
      } else {
        articleEl.appendChild(wrap);
      }
    }
  }

  function harvestSummary() {
    // Pull views/downloads/citations + published date + peer-review +
    // license out of OLH's .summary callout so we can render them inside
    // the "More article details" collapsible. The original .summary div
    // is hidden by CSS.
    var pairs = [];
    var summary = $(".summary");
    if (!summary) return pairs;

    $$(".top p.number", summary).forEach(function (p) {
      var num = "";
      for (var i = 0; i < p.childNodes.length; i++) {
        var n = p.childNodes[i];
        if (n.nodeType === 3) num += n.textContent;
      }
      num = num.trim();
      var lbl = p.querySelector("span");
      var label = lbl ? lbl.textContent.trim() : null;
      if (num) pairs.push({ label: label, html: num });
    });

    var pub = summary.querySelector("#article_date_published");
    if (pub) {
      var date = pub.textContent.replace(/Published on/i, "").trim();
      if (date) pairs.push({ label: "Published", html: date });
    }

    $$(".bottom p", summary).forEach(function (p) {
      if (/peer reviewed/i.test(p.textContent)) {
        pairs.push({ label: null, html: "Peer reviewed" });
      }
    });

    var licA = summary.querySelector(".bottom a");
    if (licA) {
      var licInner = licA.querySelector("p");
      var licText = (licInner ? licInner.textContent : licA.textContent).trim();
      if (licText) {
        pairs.push({
          label: "License",
          html: '<a href="' + licA.getAttribute("href") + '" target="_blank" rel="noopener">' +
                licText + "</a>",
        });
      }
    }
    return pairs;
  }

  function buildArticleDetails() {
    var articleEl = document.getElementById("article");
    if (!articleEl) return;
    if ($(".lawsnotes-details", articleEl)) return;

    // Lead with summary metrics + dates + license.
    var pairs = harvestSummary();

    var sidebar = $("section.side-info");
    if (!sidebar) {
      if (!pairs.length) return;
    } else {

    // For each .section in the sidebar, capture (label, valueHtml) pairs.
    // A "section" can be one heading + one list, or a heading + ul of items.
    // We flatten so each <li>/text becomes its own pair when reasonable.
    $$(".section", sidebar).forEach(function (sec) {
      var h = sec.querySelector("h2, h3");
      if (!h) return;
      var label = h.textContent.replace(/[:\s]+$/, "").trim();
      if (!label || SKIP_SECTION_RE.test(label)) return;

      // Issue section: rewrite the verbose
      // "Volume 3 • Issue 3 • 2026 • Volume 3 (2026)" string into
      // a clean "Volume: N Issue: M" (issue number omitted when none).
      if (/^Issues?$/i.test(label)) {
        $$("li", sec).forEach(function (li) {
          var raw = (li.textContent || "").replace(/\s+/g, " ").trim();
          var v = raw.match(/Volume\s+(\d+)/i);
          var iss = raw.match(/Issue\s+(\d+)/i);
          if (!v && !iss) return;
          var bits = [];
          if (v) bits.push("Volume: " + v[1]);
          if (iss) bits.push("Issue: " + iss[1]);
          pairs.push({ label: null, html: bits.join(" &nbsp; ") });
        });
        return;
      }

      // Collect content nodes: ul li, or paragraphs.
      var items = $$("li", sec);
      if (items.length) {
        items.forEach(function (li) {
          var html = li.innerHTML.trim();
          if (!html) return;
          // If the li already has a "Label:" prefix (publication details
          // block emits these), prefer that and skip our outer label.
          if (/^[A-Za-z][A-Za-z\s]*:\s/.test(li.textContent.trim())) {
            pairs.push({ label: null, html: html });
          } else {
            pairs.push({ label: label, html: html });
          }
        });
      } else {
        var contentEls = $$("p", sec).concat($$("a", sec));
        var html = sec.innerHTML
          .replace(/<h[23][^>]*>[\s\S]*?<\/h[23]>/i, "")
          .trim();
        if (html) pairs.push({ label: label, html: html });
      }
    });

    // Download XML link, harvested from the original (CSS-hidden) Files
    // section in the sidebar. The XML download was suppressed from the
    // top files row at the user's request; the article-details body is
    // where it now lives, styled as a plain link.
    var xmlHref = "";
    $$("a", sidebar).forEach(function (a) {
      if (xmlHref) return;
      var t = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (/\bXML\b/i.test(t)) xmlHref = a.getAttribute("href") || "";
    });
    if (xmlHref) {
      pairs.push({
        label: null,
        html: '<a href="' + xmlHref.replace(/"/g, "&quot;") +
              '">Download XML</a>',
      });
    }

    } // end of: if (!sidebar) { ... } else { ...sidebar walk... }

    if (!pairs.length) return;

    var details = document.createElement("details");
    details.className = "lawsnotes-details";
    var summary = document.createElement("summary");
    var labelSpan = document.createElement("span");
    labelSpan.className = "lawsnotes-summary-label";
    labelSpan.textContent = "Article details";
    summary.appendChild(labelSpan);
    details.appendChild(summary);

    var inner = document.createElement("div");
    inner.className = "lawsnotes-details-body";
    pairs.forEach(function (p, i) {
      if (i > 0) {
        var sep = document.createElement("span");
        sep.className = "lawsnotes-details-sep";
        sep.textContent = "·";
        inner.appendChild(sep);
      }
      var span = document.createElement("span");
      span.className = "lawsnotes-details-item";
      if (p.label) {
        var lab = document.createElement("strong");
        lab.textContent = p.label + ": ";
        span.appendChild(lab);
      }
      var val = document.createElement("span");
      val.innerHTML = p.html;
      span.appendChild(val);
      inner.appendChild(span);
    });
    details.appendChild(inner);

    // Place after the files block, or under the abstract.
    var anchor = $(".lawsnotes-files", articleEl);
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(details, anchor.nextSibling);
    } else {
      articleEl.appendChild(details);
    }
  }

  // pinDoiIntoCite was removed: Janeway's default how_to_cite template
  // already includes the DOI via doi_display.html, and our OSCOLA
  // custom_how_to_cite includes it explicitly in OSCOLA's <angle-bracket>
  // form -- so any client-side append produced a duplicate.

  function observeReflows() {
    if (typeof ResizeObserver === "undefined") return;
    var bodyEl = $(BODY_SELECTOR);
    if (!bodyEl) return;
    var t = null;
    var ro = new ResizeObserver(function () {
      if (!sidenotesActive) return;
      clearTimeout(t);
      t = setTimeout(layout, 60);
    });
    ro.observe(bodyEl);
  }

  /* ============================================================
     Init
     ============================================================ */

  function renameCiteHeading() {
    var h = document.querySelector("#article_how_to_cite > h2");
    if (h) h.textContent = "Citation:";
  }

  /* Rewrite OLH's verbose issue title strings:
     "Volume 3 • Issue 3 • 2026 • Volume 3 (2026)"
     to a tight "Volume 3 (2026)". Same parsing logic in two places:
     (a) the cards on the issues list page, (b) the H1 banner on each
     individual issue page. The aria-label preserves the four-part
     shape so we can parse Volume + 4-digit year out of it. */
  function _parseVolYear(label) {
    var vol = label.match(/Volume\s+\d+/i);
    var year = label.match(/\b(?:19|20)\d{2}\b/);
    return (vol && year) ? { vol: vol[0], year: year[0] } : null;
  }
  /* Strip the volume/issue/section noise that OLH appends to each
     article card's date line. The markup is roughly:
       <p>
         <span class="date">…date…</span>
         <i class="fa-book"></i>
         <span aria-label="…">Volume X • Issue Y • YYYY • …</span>
         <i class="fa-tag"></i>
         Articles                ← bare text node, not a span
       </p>
     We keep .date and remove everything after it (including text
     nodes, which CSS can't reach). */
  function cleanCardMetaLine() {
    $$(".box.article .date").forEach(function (dateEl) {
      var p = dateEl.parentNode;
      if (!p) return;
      var n = dateEl.nextSibling;
      while (n) {
        var next = n.nextSibling;
        p.removeChild(n);
        n = next;
      }
    });
  }

  /* On the issues list page, replace each issue's "N items" line with
     a "(feat. articles by Surname1, Surname2 & SurnameN)" credit row.
     We fetch each issue's detail page, parse the .box.article cards
     out of it, pull author names from the first <p> of each card,
     reduce to unique surnames, and rewrite the info-bar text. Cached
     in sessionStorage so repeat visits are instant. */
  function _surnameOf(name) {
    var words = name.trim().split(/\s+/);
    var last = words[words.length - 1] || "";
    return last.replace(/[.,;:]+$/, "");
  }
  function _formatFeatList(surnames) {
    if (!surnames.length) return "";
    if (surnames.length === 1) return "feat. an article by " + surnames[0];
    var head = surnames.slice(0, -1).join(", ");
    var tail = surnames[surnames.length - 1];
    return "feat. articles by " + head + " &amp; " + tail;
  }
  function _applyIssueFeat(card, joined) {
    if (card.dataset.lawsnotesFeatSet) return;
    var p = card.querySelector(".info-bar p");
    if (!p) return;
    var surnames = (joined || "").split("|").filter(Boolean);
    if (!surnames.length) return;     // don't mark as set; allow retry
    var text = _formatFeatList(surnames);
    if (!text) return;
    p.innerHTML = text;
    card.dataset.lawsnotesFeatSet = "1";
  }
  function enrichIssueCardsWithAuthors() {
    if (!document.body.classList.contains("lawsnotes-page-issues")) return;
    var cards = $$(".box.issue");
    if (!cards.length) return;

    cards.forEach(function (card) {
      var link = card.querySelector("a.box-link");
      if (!link) return;
      var url = link.getAttribute("href");
      if (!url) return;

      // v2: cache key bumped to invalidate any earlier-iteration empties.
      var cacheKey = "lawsnotes:issue-authors:v2:" + url;
      var cached = null;
      try { cached = sessionStorage.getItem(cacheKey); } catch (e) {}
      if (cached) {                     // only honour a non-empty cache
        _applyIssueFeat(card, cached);
        return;
      }

      fetch(url, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
      })
        .then(function (r) { return r.ok ? r.text() : ""; })
        .then(function (html) {
          if (!html) return;
          var doc = new DOMParser().parseFromString(html, "text/html");
          var surnames = [];
          doc.querySelectorAll(".box.article").forEach(function (art) {
            var paras = art.querySelectorAll("p");
            if (!paras.length) return;
            var text = paras[0].textContent.replace(/\s+/g, " ").trim();
            // Split on commas, "and" (word boundary) and ampersands.
            var parts = text.split(/\s*(?:,|\s+and\s+|&)\s*/i);
            parts.forEach(function (n) {
              var s = _surnameOf(n);
              if (s && surnames.indexOf(s) === -1) surnames.push(s);
            });
          });
          var joined = surnames.join("|");
          try { sessionStorage.setItem(cacheKey, joined); } catch (e) {}
          _applyIssueFeat(card, joined);
        })
        .catch(function () { /* fail silently -- the original "N items" stays */ });
    });
  }

  function _journalName() {
    // The plugin's head_css hook stamps the journal name onto
    // window.lawsnotesJournalName (server-side, from request.journal.name).
    // Reliable across all pages -- avoids parsing <title>, which has
    // different formats per template (sometimes "<Journal> | …",
    // sometimes "<Article> | <Journal> …", sometimes just "Articles").
    if (typeof window.lawsnotesJournalName === "string" && window.lawsnotesJournalName) {
      return window.lawsnotesJournalName;
    }
    return "";
  }

  /* Articles-list page H1: replace "Articles" with
     "<em>Journal Name</em>, Latest Articles" -- matches the per-issue
     page banner shape ("<em>Journal</em>, Volume X (YYYY)") so the
     section headings across the site read as one family. */
  function relabelArticlesPageTitle() {
    if (!document.body.classList.contains("lawsnotes-page-articles")) return;
    var h1 = document.getElementById("articles-title")
      || document.querySelector("#main-content h1");
    if (!h1 || h1.dataset.lawsnotesRelabeled) return;
    h1.dataset.lawsnotesRelabeled = "1";

    var journal = _journalName();
    if (!journal) {
      h1.textContent = "Latest Articles";
      return;
    }
    h1.innerHTML = "";
    var em = document.createElement("em");
    em.textContent = journal;
    h1.appendChild(em);
    h1.appendChild(document.createTextNode(", Latest Articles"));
  }

  function relabelIssueTitles() {
    // List cards: "Volume X (YYYY)".  Per-issue page banner: prepend
    // the journal name in italics -> "<i>Journal</i>, Volume X (YYYY)".
    var fmt = function (p) { return p.vol + " (" + p.year + ")"; };
    $$(".box.issue h3 > span[aria-label]").forEach(function (sp) {
      var p = _parseVolYear(sp.getAttribute("aria-label") || "");
      if (p) sp.textContent = fmt(p);
    });
    var journal = _journalName();
    $$("#issue_top .olh-banner-heading h1[aria-label]").forEach(function (h) {
      var p = _parseVolYear(h.getAttribute("aria-label") || "");
      if (!p) return;
      h.innerHTML = "";
      if (journal) {
        var em = document.createElement("em");
        em.className = "lawsnotes-issue-journal";
        em.textContent = journal;
        h.appendChild(em);
        h.appendChild(document.createTextNode(", " + fmt(p)));
      } else {
        h.textContent = fmt(p);
      }
    });
  }

  /* ============================================================
     Per-page body classes + homepage population
     ============================================================
     The plugin's CSS loads on every journal page (via the
     base_head_css hook) but most rules are scoped to specific page
     types. We tag <body> with `lawsnotes-on` plus a `lawsnotes-page-<root>`
     hook so CSS can target each page reliably without theme forks. */
  function addPageBodyClasses() {
    document.body.classList.add("lawsnotes-on");
    var pageMap = {
      article: "article", articles: "articles",
      issues: "issues", issue: "issue",
      collections: "collections", collection: "collection",
      news: "news", search: "search", about: "about",
      editorialteam: "editorialteam", submissions: "submissions",
    };
    var parts = location.pathname.split("/").filter(Boolean);
    // Janeway runs in either path mode (/<journal>/article/...) or
    // domain mode (/article/...). Detect by checking whether the first
    // segment looks like a known page root; if not, assume it's the
    // journal code and shift it off.
    var rest = (parts.length && !pageMap[parts[0]]) ? parts.slice(1) : parts;
    if (rest.length === 0) {
      document.body.classList.add("lawsnotes-page-home");
      return;
    }
    if (pageMap[rest[0]]) {
      document.body.classList.add("lawsnotes-page-" + pageMap[rest[0]]);
    }
  }

  /* Batched metadata fetch: one request to /plugins/lawsnotes/api/cards/
     replaces what used to be N HTML fetches (one per card). Pulls
     abstracts for any .box.article cards and surnames for any .box.issue
     cards visible on the page. Falls back silently to per-card HTML
     scraping if the endpoint isn't available (e.g. older plugin
     install). */
  function _idFromBoxDetailsAttr(card, attr) {
    var v = card.getAttribute(attr) || "";
    var m = v.match(/^(\d+)-/);
    return m ? m[1] : null;
  }
  function _articleIdFromCard(card) {
    var details = card.querySelector("[id$='-box-details']");
    if (!details) return null;
    var m = (details.id || "").match(/^(\d+)-/);
    return m ? m[1] : null;
  }
  function _issueIdFromCard(card) {
    // .box.issue heading has id="<n>-box-title"; the box-link has
    // aria-labelledby pointing to it.
    var t = card.querySelector("[id$='-box-title']");
    if (!t) return null;
    var m = (t.id || "").match(/^(\d+)-/);
    return m ? m[1] : null;
  }

  function loadCardMetadata() {
    var articleCards = $$(".box.article");
    var issueCards = $$(".box.issue");

    var articleIds = articleCards
      .map(_articleIdFromCard)
      .filter(function (x) { return x; });
    var issueIds = issueCards
      .map(_issueIdFromCard)
      .filter(function (x) { return x; });

    if (!articleIds.length && !issueIds.length) return;

    // The hook injects `window.lawsnotesApiUrl` from Django's URL resolver,
    // so this works in both path-mode (/<journal>/plugins/lawsnotes/...) and
    // domain-mode (/plugins/lawsnotes/...) installs without guessing.
    var apiBase = window.lawsnotesApiUrl;
    if (!apiBase) return;
    var url = apiBase + "?";
    var params = [];
    if (articleIds.length) params.push("articles=" + articleIds.join(","));
    if (issueIds.length) params.push("issues=" + issueIds.join(","));
    url += params.join("&");

    fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) {
          // Endpoint missing/disabled: fall back to per-card scraping.
          enrichArticleCardsWithAbstracts();
          enrichIssueCardsWithAuthors();
          return;
        }
        // Apply abstracts.
        var arts = (data && data.articles) || {};
        articleCards.forEach(function (card) {
          var id = _articleIdFromCard(card);
          if (!id) return;
          var rec = arts[id];
          if (rec && rec.abstract) insertCardAbstract(card, rec.abstract);
        });
        // Apply issue surnames.
        var iss = (data && data.issues) || {};
        issueCards.forEach(function (card) {
          var id = _issueIdFromCard(card);
          if (!id) return;
          var rec = iss[id];
          if (rec && rec.surnames && rec.surnames.length) {
            _applyIssueFeat(card, rec.surnames.join("|"));
          }
        });
      })
      .catch(function () {
        // Network/parse error: fall back.
        enrichArticleCardsWithAbstracts();
        enrichIssueCardsWithAuthors();
      });
  }

  /* Per-card HTML fallback (used only if the JSON endpoint isn't
     reachable). Original implementation, kept as a safety net. */
  function enrichArticleCardsWithAbstracts() {
    // Run on any page that renders .box.article cards: the articles
    // list, individual issue pages (their TOC uses the same markup),
    // and any future page with the same component.
    var cards = document.querySelectorAll(".box.article");
    if (!cards.length) return;

    cards.forEach(function (card) {
      if (card.querySelector(".lawsnotes-card-abstract")) return;
      var link = card.querySelector("a.box-link");
      if (!link) return;
      var url = link.getAttribute("href");
      if (!url) return;

      var cacheKey = "lawsnotes:abstract:" + url;
      var cached = null;
      try { cached = sessionStorage.getItem(cacheKey); } catch (e) {}
      if (cached !== null) {
        insertCardAbstract(card, cached);
        return;
      }

      fetch(url, {
        credentials: "same-origin",
        headers: { Accept: "text/html" },
      })
        .then(function (r) { return r.ok ? r.text() : ""; })
        .then(function (html) {
          if (!html) return;
          var doc = new DOMParser().parseFromString(html, "text/html");
          var articleEl = doc.getElementById("article");
          if (!articleEl) return;
          var h3 = null;
          articleEl.querySelectorAll("h3").forEach(function (h) {
            if (!h3 && /abstract/i.test(h.textContent)) h3 = h;
          });
          if (!h3) return;
          var parts = [];
          var node = h3.nextElementSibling;
          while (node && node.tagName === "P") {
            var t = node.textContent.trim();
            if (t) parts.push(t);
            node = node.nextElementSibling;
          }
          if (!parts.length) return;
          var text = parts.join(" ");
          if (text.length > 340) {
            text = text.slice(0, 340).replace(/\s+\S*$/, "") + "…";
          }
          try { sessionStorage.setItem(cacheKey, text); } catch (e) {}
          insertCardAbstract(card, text);
        })
        .catch(function () { /* fail silently */ });
    });
  }

  function insertCardAbstract(card, text) {
    if (card.querySelector(".lawsnotes-card-abstract")) return;
    var p = document.createElement("p");
    p.className = "lawsnotes-card-abstract";
    p.textContent = text;
    var details = card.querySelector("[id$=\"-box-details\"]")
      || card.querySelector(".large-10.columns")
      || card.querySelector(".clearfix");
    if (details) details.appendChild(p);
  }

  /* Records-per-page select: the OLH markup has the inline handler
     `onchange="this.form.submit()"` plus `form="facet_form"`, but the
     actual filter forms on the page are `facet_form-desktop` and
     `facet_form-mobile` -- there's no element with id="facet_form",
     so `this.form` doesn't resolve and the submit is a no-op (made
     worse by our CSS hiding the filter sidebar entirely). Replace
     with a direct location change that updates ?paginate_by while
     preserving every other query parameter. */
  /* Stamp the first letter of the article title onto a data-attribute
     so a CSS ::before pseudo can paint it as a giant transparent
     backdrop. CSS can't read the title text dynamically; this is the
     two-line bridge it needs. */
  /* Tag the very first paragraph of the article body so CSS can hang
     a drop cap on exactly one element -- not on every "first p in
     every section/div", which is what `p:first-of-type` produces when
     the JATS body has nested <sec> wrappers. */
  /* Same big-transparent-letter backdrop as the article title, but
     applied to every `.box.article` card in a listing (articles list,
     issue ToC, etc.). Letter is whatever the card's title starts
     with; CSS positions it left-aligned and vertically centred. */
  function setCardDropLetters() {
    $$(".box.article").forEach(function (card) {
      if (card.dataset.lawsnotesCardDrop) return;
      var titleEl = card.querySelector("h2, h3");
      if (!titleEl) return;
      var t = (titleEl.textContent || "").trim();
      if (!t) return;
      card.dataset.lawsnotesCardDrop = "1";
      card.setAttribute("data-first-letter", t.charAt(0).toUpperCase());
    });
  }

  function tagDropCapParagraph() {
    if (!document.body.classList.contains("lawsnotes-page-article")) return;
    var body = document.querySelector(
      "#main_article > div[itemprop=\"articleBody\"]"
    );
    if (!body) return;
    if (body.querySelector(".lawsnotes-drop-cap")) return;
    var p = body.querySelector("p");      // first <p> in document order
    if (p) p.classList.add("lawsnotes-drop-cap");
  }

  function setTitleDropLetter() {
    if (!document.body.classList.contains("lawsnotes-page-article")) return;
    var h1 = document.querySelector(".olh-banner-heading h1");
    if (!h1 || h1.dataset.lawsnotesDrop) return;
    var t = (h1.textContent || "").trim();
    if (!t) return;
    h1.dataset.lawsnotesDrop = "1";
    h1.setAttribute("data-first-letter", t.charAt(0).toUpperCase());
  }

  /* Read volume/year/pages/issue-URL out of the (still-DOM-but-CSS-hidden)
     sidebar. Year comes from the same Volume X (YYYY) string that
     relabelIssueTitles() builds. Any field may be empty when the
     underlying data is missing. */
  function _extractArticleMeta() {
    var meta = { volume: "", year: "", firstPage: "", issueUrl: "" };
    var sidebar = document.querySelector("section.side-info");
    if (!sidebar) return meta;
    $$(".section", sidebar).forEach(function (sec) {
      var h = sec.querySelector("h2, h3");
      if (!h) return;
      var label = (h.textContent || "").trim();
      if (/^Issues?\b/i.test(label)) {
        var a = sec.querySelector("ul li a");
        if (a) {
          if (!meta.issueUrl) meta.issueUrl = a.getAttribute("href") || "";
          var aria = a.getAttribute("aria-label") || "";
          var text = (a.textContent || "").replace(/\s+/g, " ").trim();
          var src = aria || text;
          var v = src.match(/Volume\s+(\d+)/i);
          if (v && !meta.volume) meta.volume = v[1];
          var y = src.match(/\b(19|20)\d{2}\b/);
          if (y && !meta.year) meta.year = y[0];
        }
      } else if (/^Publication details/i.test(label)) {
        $$("li", sec).forEach(function (li) {
          var t = (li.textContent || "").trim();
          var pm = t.match(/^Pages?:\s*(.+)$/i);
          if (pm && !meta.firstPage) {
            var first = pm[1].split(/[–—\-−]/)[0];
            first = (first || "").replace(/[^\d]/g, "");
            if (first) meta.firstPage = first;
          }
        });
      }
    });
    return meta;
  }

  /* Format: "(YYYY) VOL JOURNAL PAGE" — bluebook-ish citation shape,
     all in caps. Each segment is dropped when its data isn't present
     (e.g. an article with no issue → no year and no volume). */
  function _buildArticleMetaText(meta) {
    var journal = _journalName();
    var bits = [];
    if (meta.year) bits.push("(" + meta.year + ")");
    if (meta.volume) bits.push(meta.volume);
    if (journal) {
      bits.push(journal.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
    }
    if (meta.firstPage) bits.push(meta.firstPage);
    return bits.join(" ");
  }

  /* Right-aligned volume/journal/page note on the same vertical line
     as the section-name label ("ARTICLE"). Wraps the existing
     <p class="uppercase"> in a flex row containing a span that holds
     the meta text. Idempotent. */
  function injectArticleHeaderMeta() {
    if (!document.body.classList.contains("lawsnotes-page-article")) return;
    var meta = _extractArticleMeta();
    var html = _buildArticleMetaText(meta);
    if (!html) return;

    function wrap(label) {
      if (!label || label.dataset.lawsnotesSectionRow) return;
      var parent = label.parentNode;
      if (!parent) return;
      label.dataset.lawsnotesSectionRow = "1";
      var row = document.createElement("div");
      row.className = "lawsnotes-section-row";
      parent.insertBefore(row, label);
      row.appendChild(label);
      var rhs = document.createElement("span");
      rhs.className = "lawsnotes-article-meta";
      rhs.innerHTML = html;
      row.appendChild(rhs);
    }
    wrap(document.querySelector(".olh-banner-heading p.uppercase"));
    wrap(document.querySelector(
      "section.no-padding.meta.show-for-small-only small.uppercase"
    ));
  }

  /* Append a "See Full Volume" link to the relocated download list,
     so it sits inline with "View PDF" / "Download XML". Reads the
     issue URL out of the sidebar so it works whether or not Janeway
     emits absolute or relative URLs. */
  function appendSeeFullVolume() {
    if (!document.body.classList.contains("lawsnotes-page-article")) return;
    var ul = document.querySelector(".lawsnotes-files ul");
    if (!ul) return;
    if (ul.querySelector(".lawsnotes-see-volume")) return;
    var meta = _extractArticleMeta();
    if (!meta.issueUrl) return;
    var li = document.createElement("li");
    li.className = "lawsnotes-see-volume";
    var a = document.createElement("a");
    a.href = meta.issueUrl;
    a.textContent = "See Full Volume";
    li.appendChild(a);
    ul.appendChild(li);
  }

  /* Replace each author's trailing affiliation block with a clean
     "<comma><orgs joined by ;>" span pair we control end-to-end.
     Janeway's affiliation_display.html emits a "None" text node when
     the organization has no location row, and the surrounding markup
     varies (worksFor + name + ROR + locations + dates), so rather
     than try to style it in place we rip the existing chunk out and
     rebuild from `[itemprop="worksFor"]` org names only. Multiple
     affiliations are joined with "; ". */
  function wrapAuthorAffiliations() {
    $$('[itemprop="author"]').forEach(function (a) {
      if (a.dataset.lawsnotesAffilDone) return;
      a.dataset.lawsnotesAffilDone = "1";

      // Collect organization names from worksFor descendants.
      var orgs = [];
      $$('[itemprop="worksFor"]', a).forEach(function (w) {
        var nm = w.querySelector('[itemprop="name"]');
        var t = ((nm ? nm.textContent : w.textContent) || "")
          .replace(/\s+/g, " ").trim();
        if (t && t.toLowerCase() !== "none" && orgs.indexOf(t) === -1) {
          orgs.push(t);
        }
      });

      // Remove every direct-child <span> that contains a worksFor
      // (and the preceding <span>, </span> separator). This wipes
      // the existing affiliation chunk -- including the trailing
      // ", None" -- without touching the name or email.
      Array.prototype.slice.call(a.children).forEach(function (c) {
        if (c.tagName !== "SPAN") return;
        if (c.getAttribute("itemprop") === "name") return;
        if (!c.querySelector('[itemprop="worksFor"]')) return;
        var prev = c.previousElementSibling;
        if (prev && prev.tagName === "SPAN" &&
            /^[\s,]+$/.test(prev.textContent || "")) {
          prev.remove();
        }
        c.remove();
      });

      if (!orgs.length) return;
      var sep = document.createElement("span");
      sep.className = "lawsnotes-author-affiliation";
      sep.textContent = ", ";
      var aff = document.createElement("span");
      aff.className = "lawsnotes-author-affiliation";
      aff.textContent = orgs.join("; ");
      a.appendChild(sep);
      a.appendChild(aff);
    });
  }



  /* Insert <wbr> after `/`, `?`, `&`, `=`, `.`, `-`, `_` inside any URL
     anchor in sidenote/tooltip/endnote bodies. Browsers default to
     moving an unbreakable token to the next line before splitting it,
     even with `overflow-wrap: anywhere`. <wbr> is an invisible
     soft-break opportunity that lets the URL break inline at natural
     URL separators -- so `…some text https://very/long/path` reads as
     "some text https://very/" continuing on the next line at "long/path"
     instead of "some text\nhttps://very/long/path". */
  function _addWbrToUrls(scope) {
    var sel = "a[href^='http']";
    var anchors = scope ? $$(sel, scope) : $$(sel);
    anchors.forEach(function (a) {
      if (a.dataset.lawsnotesWbr) return;
      var t = (a.textContent || "").trim();
      if (!/^https?:\/\//i.test(t)) return;
      a.dataset.lawsnotesWbr = "1";
      // Use HTML so <wbr> gets parsed as element nodes.
      var html = t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      html = html.replace(/([\/\?&=\.\-_])/g, "$1<wbr/>");
      a.innerHTML = html;
    });
  }
  function addUrlBreakHints() {
    _addWbrToUrls(document.getElementById("main_article"));
    $$(".lawsnotes-sidenote").forEach(_addWbrToUrls);
  }

  /* Bridge for the cite-style submenu (Harvard / Vancouver / APA)
     `<a href="#" data-open="HarvardModal">`. The OLH article template
     does NOT call `$(document).foundation()` (only the articles list
     does), so Foundation's reveal auto-binding never runs on the
     article page. We bypass Foundation entirely and show the modal
     ourselves, which works whether or not Foundation is initialised. */
  function bridgeRevealClicks() {
    function openModal(modal) {
      modal.style.display = "block";
      modal.style.position = "fixed";
      modal.style.top = "8%";
      modal.style.left = "50%";
      modal.style.transform = "translateX(-50%)";
      modal.style.zIndex = "10000";
      modal.style.maxWidth = "640px";
      modal.style.width = "90%";
      modal.style.maxHeight = "84vh";
      modal.style.overflow = "auto";
      modal.style.background = "#ffffff";
      modal.style.border = "1px solid #b9cdc4";
      modal.style.borderRadius = "3px";
      modal.style.padding = "1.5em 1.75em";
      modal.style.boxShadow = "0 8px 32px rgba(0,0,0,0.25)";
      modal.setAttribute("aria-hidden", "false");

      var bg = document.createElement("div");
      bg.className = "lawsnotes-modal-bg";
      bg.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999";

      function close() {
        modal.style.display = "none";
        modal.setAttribute("aria-hidden", "true");
        bg.remove();
        document.removeEventListener("keydown", onKey);
      }
      function onKey(e) { if (e.key === "Escape") close(); }
      bg.addEventListener("click", close);
      document.addEventListener("keydown", onKey);

      // Foundation modals usually have a close button (`button.close-button`);
      // wire it up if present.
      var btn = modal.querySelector(".close-button, [data-close]");
      if (btn) btn.addEventListener("click", function (e) {
        e.preventDefault();
        close();
      });
      document.body.appendChild(bg);
    }

    // Capture phase so we run BEFORE Foundation's own reveal handler
    // (which is bound when OLH calls $(document).foundation() inside
    // app.min.js -- the menu opens because of that, but under some press
    // override stylesheets the Foundation modal paints offscreen / under
    // a higher-z header). Doing the modal ourselves with explicit
    // styles is robust.
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("[data-open]");
      if (!a) return;
      var modalId = a.getAttribute("data-open");
      if (!modalId) return;
      var modal = document.getElementById(modalId);
      if (!modal) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      openModal(modal);
    }, true);
  }

  function bindPaginateBy() {
    var sel = document.querySelector('select[name="paginate_by"]');
    if (!sel || sel.dataset.lawsnotesBound) return;
    sel.dataset.lawsnotesBound = "1";

    // Reflect the URL's paginate_by into the select's displayed value
    // (or 25 if absent -- Janeway's articles view defaults to 25
    // server-side, but OLH's template doesn't add `selected="selected"`
    // to any option, so the browser shows the first option (10) by
    // default while the server actually returns 25 articles. We sync.
    var url = new URL(location.href);
    var desired = url.searchParams.get("paginate_by") || "25";
    var match = Array.prototype.some.call(sel.options, function (o) {
      return o.value === desired;
    });
    if (match) sel.value = desired;

    // Clear the broken inline handler (which references a non-existent
    // form ID) so it doesn't throw on change.
    sel.onchange = null;
    sel.addEventListener("change", function () {
      var u = new URL(location.href);
      u.searchParams.set("paginate_by", sel.value);
      // Reset to page 1: page-N of 10 may not exist at page-N of 50.
      u.searchParams.delete("page");
      location.href = u.toString();
    });
  }

  function bridgeDyslexiaToggle() {
    // OLH's toggleDyslexia() flips .dyslexia-friendly on every element
    // inside #article, not on <body>. Sidenotes and the tooltip live
    // outside #article, so they don't pick the class up. Mirror the
    // toggle to a body-level marker our CSS reads.
    //
    // The OLH template wires the button via an inline
    //   onclick="toggleDyslexia();"
    // attribute. Some privacy-focused browsers (notably DuckDuckGo
    // with site protections enabled) inject a strict CSP that blocks
    // inline event handlers, so the button does nothing until the user
    // disables protections. We replace the inline handler with an
    // addEventListener call to toggleDyslexia, which is allowed under
    // those CSPs and preserves identical behaviour everywhere else.
    var btn = document.getElementById("dyslexia-mode");
    if (!btn) return;
    btn.removeAttribute("onclick");
    btn.addEventListener("click", function () {
      if (typeof window.toggleDyslexia === "function") {
        window.toggleDyslexia();
      }
      // Defer until after toggleDyslexia has finished mutating the DOM.
      setTimeout(function () {
        var on = !!document.querySelector("#article .dyslexia-friendly");
        document.body.classList.toggle("lawsnotes-dyslexia", on);
      }, 0);
    });
  }

  /* OLH's resizeText() (static/common/js/text_readability.js) walks only
     descendants of #article. Sidenotes are cloned into a
     .lawsnotes-sidenote-layer appended to <body>, and the rollover tooltip
     into a .lawsnotes-tooltip likewise outside #article, so A+/A- never
     touch them. Wrap resizeText to apply the same multiplier to those
     overlays after the original call returns, then reflow sidenote
     positions (their heights changed). */
  /* Why a CSS variable instead of per-element px walking:
     OLH's algorithm scales by ±20% per click. Applied naively to every
     descendant of .lawsnotes-sidenote-layer it compounds badly, because
     sidenote children use em-based font-sizes -- setting the parent's
     font-size to 1.2x already grows the child via inheritance, and
     explicitly multiplying the child's getComputedStyle value by 1.2
     stacks a second factor on top. One click ended up making sidenotes
     larger than body text. Even fixed correctly, 20% per click is way
     too aggressive on already-small sidenotes (0.78em).
     Instead, track a fixed-step pt bump in a CSS custom property which
     the sidenote/tooltip font-size rules calc() in. Children inherit
     via em and scale proportionally with no compounding. */
  var SIDENOTE_STEP_PT = 1;
  function bridgeResizeText() {
    var orig = window.resizeText;
    if (typeof orig !== "function") return;
    var overlayBumpPt = 0;
    window.resizeText = function (multiplier) {
      var beforeCumulative = window.cumulativeResize;
      var ret = orig.apply(this, arguments);
      // If resizeText hit its bound, cumulativeResize won't have moved;
      // skip overlay scaling so sidenotes stay in lockstep with article.
      if (window.cumulativeResize === beforeCumulative) return ret;
      overlayBumpPt += multiplier * SIDENOTE_STEP_PT;
      document.documentElement.style.setProperty(
        "--lawsnotes-overlay-bump", overlayBumpPt + "pt"
      );
      // Sidenote heights have changed; re-run the absolute-position
      // layout pass so they stack without overlapping.
      if (sidenotesActive) {
        setTimeout(function () { layout(); }, 0);
      }
      return ret;
    };
  }

  function tagAbstract() {
    // Find the Abstract h3 inside #article and tag every following <p>
    // until the next sectioning element. The template doesn't class the
    // abstract paragraphs, so this is the only way to italicise them
    // without forking the theme.
    var articleEl = document.getElementById("article");
    if (!articleEl) return;
    var h3 = null;
    $$("#article > h3").forEach(function (h) {
      if (!h3 && /abstract/i.test(h.textContent)) h3 = h;
    });
    if (!h3) return;
    var node = h3.nextElementSibling;
    while (node) {
      var stop = (
        node.tagName === "H2" ||
        node.tagName === "H3" ||
        node.id === "main_article" ||
        node.id === "article_how_to_cite" ||
        node.classList.contains("summary") ||
        node.classList.contains("callout") ||
        node.classList.contains("lawsnotes-files") ||
        node.classList.contains("lawsnotes-details")
      );
      if (stop) break;
      if (node.tagName === "P") node.classList.add("lawsnotes-abstract");
      node = node.nextElementSibling;
    }
  }

  /* Capture-phase guard for footnote-marker clicks. Has to do ALL
     the work itself (preventDefault + scroll + flash) because
     stopImmediatePropagation prevents the marker's own bubble-phase
     handlers from running -- and we need that stop to silence OLH's
     `$('a[href*="#"]').click(...)` handler in app.js, which
     animates `$('html,body').scrollTop` toward the (now display:none)
     <li id="fnX"> at the foot of the article on every click. That
     jQuery animation is what scrolled the page on every repeat
     click: with the endnote list collapsed, target.offset().top
     resolves to a value that drifts the page slightly upward each
     time the user re-clicks the same marker. */
  /* iOS Firefox/Safari treat `<a href="#fnX">` as a navigable link
     and queue a scroll-to-anchor action at touchstart that runs
     IN PARALLEL with the JS event sequence -- preventDefault on
     touchstart/touchend/click can't reliably cancel it. The bullet-
     proof fix is to make the marker not a link at all: stash the
     real `#fnX` reference on data-href, and replace the href so
     there's nothing for the browser to navigate to. */
  function neutraliseFootnoteHrefs() {
    var article = $(ARTICLE_SELECTOR);
    if (!article) return;
    $$(MARKER_SELECTOR, article).forEach(function (a) {
      var href = a.getAttribute("href") || "";
      if (!href || href.charAt(0) !== "#") return;
      a.dataset.lawsnotesHref = href;
      a.removeAttribute("href");
      a.setAttribute("role", "button");
      a.setAttribute("tabindex", "0");
    });
  }

  function suppressFootnoteJump() {
    // iOS fires both `touchend` and `click` for a single tap; running
    // our toggle logic twice in a row would open then immediately
    // close the tooltip on the same tap. Dedupe by marker+timestamp.
    var lastHandled = { marker: null, t: 0 };
    var handler = function (e) {
      var a = e.target.closest && e.target.closest("a.xref-fn");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      var now = Date.now();
      if (lastHandled.marker === a && now - lastHandled.t < 600) return;
      lastHandled = { marker: a, t: now };
      var idx = a.dataset.lawnotesIdx;
      if (sidenotesActive && idx != null) {
        var aside = document.getElementById("lawsnotes-sn-" + idx);
        if (aside) scrollAsideIntoView(aside);
      } else if (window.lawsnotesShowTooltipForMarker) {
        window.lawsnotesShowTooltipForMarker(a);
      }
    };
    document.addEventListener("click", handler, true);
    // iOS commits anchor navigation at touchstart; only a non-passive
    // touchstart preventDefault can cancel it. (Even after we strip
    // href entirely via neutraliseFootnoteHrefs, leaving this in is
    // belt-and-braces against any browser quirk that might still
    // treat the cached anchor as navigable.)
    document.addEventListener("touchstart", function (e) {
      var a = e.target.closest && e.target.closest("a.xref-fn");
      if (!a) return;
      e.preventDefault();
    }, { capture: true, passive: false });
    document.addEventListener("touchend", handler, true);
  }

  function scrollAsideIntoView(aside) {
    var rect = aside.getBoundingClientRect();
    var miniBar = document.querySelector(".mini-bar");
    var stickyTop = (miniBar ? miniBar.offsetHeight : 0);
    var vh = window.innerHeight;
    var fullyVisible = rect.top >= stickyTop + 8 && rect.bottom <= vh - 8;
    if (!fullyVisible) {
      var target = window.pageYOffset + rect.top - stickyTop - 64;
      window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
    aside.classList.add("lawsnotes-sidenote--flash");
    setTimeout(function () {
      aside.classList.remove("lawsnotes-sidenote--flash");
    }, 900);
  }

  function start() {
    neutraliseFootnoteHrefs();
    suppressFootnoteJump();
    addPageBodyClasses();
    applyRuntimeSettingsClasses();
    loadCardMetadata();
    relocateFileLinks();
    appendSeeFullVolume();
    injectArticleHeaderMeta();
    wrapAuthorAffiliations();
    buildArticleDetails();
    tagAbstract();
    renameCiteHeading();
    relabelIssueTitles();
    relabelArticlesPageTitle();
    cleanCardMetaLine();
    bindPaginateBy();
    if (SETTINGS.showDropCaps !== false) {
      setTitleDropLetter();
      tagDropCapParagraph();
      setCardDropLetters();
    }
    addUrlBreakHints();
    bridgeRevealClicks();
    bridgeDyslexiaToggle();
    bridgeResizeText();
    initTooltips();
    setTimeout(function () { if (mq.matches) buildSidenotes(); }, 0);
    observeReflows();
    if (mq.addEventListener) mq.addEventListener("change", onBreakpoint);
    else if (mq.addListener) mq.addListener(onBreakpoint);

    // Stable runtime API exposed to editor-supplied custom JS via
    // window.lawsnotesOnReady. Adding to this surface is fine; removing
    // from it without a plugin major-version bump is not.
    _flushReadyQueue({
      settings: SETTINGS,
      showTooltipForMarker: window.lawsnotesShowTooltipForMarker || function () {},
      buildSidenotes: buildSidenotes,
      teardownSidenotes: teardownSidenotes,
      reflow: function () { if (sidenotesActive) layout(); },
    });
  }

  /* Translate per-journal runtime settings into body classes that
     CSS hooks against. Lets editors flip features (cite dropdown
     visibility, endnote-list collapse, etc.) without needing CSS
     edits. */
  function applyRuntimeSettingsClasses() {
    if (SETTINGS.hideCiteDropdown !== false) {
      document.body.classList.add("lawsnotes-hide-cite-dropdown");
    }
    if (SETTINGS.hideEndnoteListWhenSidenotes === false) {
      document.body.classList.add("lawsnotes-keep-endnote-list");
    }
    if (!SETTINGS.logoUrl) {
      document.body.classList.add("lawsnotes-no-logo");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
