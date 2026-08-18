// ==UserScript==
// @name         YouTube
// @namespace    youtube
// @version      10
// @description  YouTube clean UI / performance / comments / settings
// @author       youtube
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const KEY = 'youtube-ui-settings';

  const DEFAULTS = Object.freeze({
    flat: true,
    cleanHome: true,
    cleanSearch: true,
    cleanWatch: true,
    performance: true,
    speed3x: true,
    dislikeCount: true,
    preferH264: false,
  });

  let cfg = readConfig();
  let playerObserver = null;
  let observedPlayer = null;
  let rootObserver = null;
  let menuTimer = 0;
  let moreActionsTimer = 0;
  let speed3xTimer = 0;
  let lastURL = location.href;
  let local3xVideo = null;

  // ============================================================
  // SHADOW DOM PIERCING
  //
  // A page-level <style> tag's selectors never cross into a shadow
  // root, by design. YouTube's newer components (Shorts shelves,
  // some lockups/thumbnails) are built with real Shadow DOM, so no
  // amount of "*, *::before, *::after" in the main document stylesheet
  // can touch border-radius set inside one of those trees - the rule
  // simply doesn't match nodes it can't see. The fix: patch
  // attachShadow so every new shadow root gets its own copy of the
  // flatten rule the instant it's created. This only works because
  // the script runs at document-start, before YouTube's own bundle
  // has created a single shadow root.
  // ============================================================

  const FLAT_SHADOW_CSS = `
    *, *::before, *::after { border-radius: 0 !important; }
    .ytp-spinner, .ytp-spinner-container, .ytp-spinner-circle,
    tp-yt-paper-spinner, tp-yt-paper-spinner-lite,
    tp-yt-paper-spinner *, tp-yt-paper-spinner-lite * {
      border-radius: 50% !important;
    }
  `;

  // Deliberately NOT using shadowRoot.adoptedStyleSheets here. Lit
  // (and most other web-component bases) sets that property via a
  // plain array ASSIGNMENT the moment the component does its own
  // first render - createRenderRoot() calls attachShadow(), then
  // immediately does `renderRoot.adoptedStyleSheets = [componentStyles]`.
  // That overwrites the whole array, silently wiping out anything we
  // put there a moment earlier. A real <style> element appended as a
  // DOM child lives outside that array entirely, so the component
  // resetting its own stylesheets can't touch it.
  const piercedStyles = [];
  const knownShadowRoots = new Set();
  let shadowPierceInstalled = false;
  let currentCssText = '';

  function shouldPierceShadowHost(host) {
    if (!(host instanceof Element)) {
      return false;
    }

    // Avoid touching unrelated page/browser components. YouTube custom
    // elements are overwhelmingly ytd-/yt-/tp- based.
    const tag = host.localName || '';
    return (
      tag.startsWith('ytd-') ||
      tag.startsWith('yt-') ||
      tag.startsWith('tp-') ||
      host.id === 'movie_player'
    );
  }

  function installFullShadowCSS(root) {
    if (
      !root ||
      typeof root.appendChild !== 'function' ||
      !shouldPierceShadowHost(root.host) ||
      !currentCssText
    ) {
      return;
    }

    const existing = Array.from(
      root.querySelectorAll?.('style[data-yts-full-css]') || []
    ).find((node) => node.parentNode === root);

    if (existing) {
      existing.textContent = currentCssText;
      return;
    }

    const style = document.createElement('style');
    style.setAttribute('data-yts-full-css', '');
    style.textContent = currentCssText;
    root.appendChild(style);
  }

  function pierceRoot(root, host) {
    if (
      !root ||
      typeof root.appendChild !== 'function' ||
      !shouldPierceShadowHost(host)
    ) {
      return;
    }

    let hasFlatStyle = false;

    for (let i = piercedStyles.length - 1; i >= 0; i--) {
      const entry = piercedStyles[i];
      const existing = entry.deref();

      if (!existing) {
        piercedStyles.splice(i, 1);
        continue;
      }

      if (existing.parentNode === root) {
        hasFlatStyle = true;
        break;
      }
    }

    if (!hasFlatStyle) {
      const style = document.createElement('style');
      style.setAttribute('data-yts-flat', '');
      style.textContent = FLAT_SHADOW_CSS;
      style.disabled = !cfg.flat;
      root.appendChild(style);
      piercedStyles.push(new WeakRef(style));
    }

    installFullShadowCSS(root);
  }

  function pruneShadowRoots() {
    for (const root of knownShadowRoots) {
      if (!root.host?.isConnected) {
        knownShadowRoots.delete(root);
      }
    }
  }

  function syncShadowFlat() {
    for (let i = piercedStyles.length - 1; i >= 0; i--) {
      const style = piercedStyles[i].deref();

      if (!style || !style.isConnected) {
        piercedStyles.splice(i, 1);
        continue;
      }

      style.disabled = !cfg.flat;
    }

    pruneShadowRoots();

    for (const root of knownShadowRoots) {
      installFullShadowCSS(root);
    }
  }

  function installShadowPierce() {
    if (
      shadowPierceInstalled ||
      typeof Element ===
        'undefined' ||
      !Element.prototype.attachShadow
    ) {
      return;
    }

    const originalAttachShadow =
      Element.prototype.attachShadow;

    Element.prototype.attachShadow =
      function (init) {
        const root =
          originalAttachShadow.call(
            this,
            init
          );

        // Keep the root reference even for mode:"closed". The page itself
        // cannot query a closed root later, but our wrapper receives the
        // freshly-created root object and can safely retain that reference.
        if (shouldPierceShadowHost(this)) {
          knownShadowRoots.add(root);
          pierceRoot(root, this);
        }

        return root;
      };

    shadowPierceInstalled = true;
  }

  installShadowPierce();

  function readConfig() {
    try {
      return {
        ...DEFAULTS,
        ...JSON.parse(
          localStorage.getItem(KEY) || '{}'
        ),
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function writeConfig() {
    localStorage.setItem(
      KEY,
      JSON.stringify(cfg)
    );

    installCSS();
    syncShadowFlat();
  }

  // ============================================================
  // CSS
  // ============================================================

  function installCSS() {
    document
      .getElementById('yts-style')
      ?.remove();

    const style =
      document.createElement('style');

    style.id =
      'yts-style';

    style.textContent = `
      :root {
        --yc-bg: #0b0b0b;
        --yc-panel: #101010;
        --yc-panel-2: #151515;
        --yc-hover: #1a1a1a;
        --yc-line: #292929;
        --yc-text: #f2f2f2;
        --yc-muted: #969696;
        --yc-accent: #f1f1f1;
      }

      html,
      body,
      ytd-app,
      #content,
      #page-manager {
        background: var(--yc-bg) !important;
      }

      /* ========================================================
         FLAT GEOMETRY

         A universal override instead of an enumerated selector
         list. YouTube keeps shipping new "view-model" components
         (Shorts shelves, lockups, the player shell itself) under
         new class names with every redesign, so a fixed selector
         list quietly stops covering new surfaces. This doesn't.
         ======================================================== */

      ${cfg.flat ? `
      *,
      *::before,
      *::after {
        border-radius: 0 !important;
      }

      /* The only thing allowed to stay round: the buffering spinner. */
      .ytp-spinner,
      .ytp-spinner-container,
      .ytp-spinner-circle,
      tp-yt-paper-spinner,
      tp-yt-paper-spinner-lite,
      tp-yt-paper-spinner *,
      tp-yt-paper-spinner-lite * {
        border-radius: 50% !important;
      }

      /* Flat, compact comment section. */
      ytd-comments,
      ytd-comments #header,
      ytd-comments #sections,
      ytd-comments #contents,
      ytd-comment-thread-renderer,
      ytd-comment-replies-renderer,
      ytd-comment-view-model,
      ytd-comment-action-buttons-renderer,
      ytd-comment-view-model #main,
      ytd-comment-view-model #content,
      ytd-comment-thread-renderer #main {
        background: var(--yc-bg) !important;
        border: 0 !important;
        box-shadow: none !important;
      }

      ytd-comment-thread-renderer,
      ytd-comment-view-model {
        margin-left: 0 !important;
        padding-left: 0 !important;
      }

      /* Replies sit closer to the left edge instead of creating a huge
         staircase of indentation. */
      ytd-comment-replies-renderer {
        position: relative !important;
        margin-left: 8px !important;
        padding-left: 10px !important;
        border: 0 !important;
        width: auto !important;
      }

      /* Current ViewModel replies carry their own indentation. Flatten that
         indentation so the only visible nesting marker is our left guide. */
      ytd-comment-replies-renderer ytd-comment-view-model[is-reply],
      ytd-comment-view-model[is-reply] {
        margin-left: 0 !important;
        margin-right: 0 !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
        border-left: 0 !important;
        border-right: 0 !important;
        width: auto !important;
        max-width: none !important;
      }

      ytd-comment-replies-renderer ytd-comment-view-model[is-reply] #main,
      ytd-comment-replies-renderer ytd-comment-view-model[is-reply] #content,
      ytd-comment-view-model[is-reply] #main,
      ytd-comment-view-model[is-reply] #content {
        margin-left: 0 !important;
        padding-left: 0 !important;
      }

      ytd-comment-replies-renderer ytd-comment-replies-renderer {
        margin-left: 6px !important;
        padding-left: 8px !important;
      }

      ytd-comment-replies-renderer,
      ytd-comment-replies-renderer > *,
      ytd-comment-replies-renderer ytd-comment-view-model[is-reply] > * {
        box-sizing: border-box !important;
      }

      ytd-comment-replies-renderer > *,
      ytd-comment-replies-renderer ytd-comment-view-model[is-reply] > * {
        transform: none !important;
      }

      ytd-comment-replies-renderer::before {
        content: "" !important;
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        bottom: 0 !important;
        width: 1px !important;
        background: var(--yc-line) !important;
        display: block !important;
      }

      ytd-comment-replies-renderer::after,
      ytd-comment-replies-renderer #replies::before,
      ytd-comment-replies-renderer #replies::after,
      ytd-comment-replies-renderer #expander::before,
      ytd-comment-replies-renderer #expander::after,
      ytd-comment-thread-renderer::before,
      ytd-comment-thread-renderer::after,
      ytd-comment-view-model .threadline,
      ytd-comment-view-model .ytSubThreadThreadline,
      ytd-comment-view-model .ytSubThreadSubThreadContent::before,
      ytd-comment-view-model .ytSubThreadSubThreadContent::after {
        display: none !important;
        content: none !important;
        border: 0 !important;
        box-shadow: none !important;
      }

      ytd-comment-thread-renderer *,
      ytd-comment-replies-renderer *,
      ytd-comment-view-model * {
        box-shadow: none !important;
      }

      ytd-comment-action-buttons-renderer button,
      ytd-comment-action-buttons-renderer yt-button-view-model,
      ytd-comment-action-buttons-renderer .yt-spec-button-shape-next {
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
      }

      ytd-comment-thread-renderer #expander,
      ytd-comment-replies-renderer #expander,
      ytd-comment-thread-renderer #replies,
      ytd-comment-replies-renderer #replies {
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
      }
      ` : ''}

      /* ========================================================
         HOME PAGE
         ======================================================== */

      ${cfg.cleanHome ? `
      [page-subtype="home"]
      ytd-feed-filter-chip-bar-renderer,
      [page-subtype="home"]
      #chips-wrapper {
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
      }

      [page-subtype="home"]
      ytd-feed-filter-chip-bar-renderer {
        min-height: 46px !important;
      }

      /*
       * Not pills.
       * Not cards.
       * Just quiet text tabs.
       */

      [page-subtype="home"]
      yt-chip-cloud-chip-renderer {
        background: transparent !important;
        border: 0 !important;
        margin-right: 14px !important;
        height: 34px !important;
      }

      [page-subtype="home"]
      yt-chip-cloud-chip-renderer
      #chip-container {
        min-width: 0 !important;
        height: 34px !important;
        padding: 0 !important;
        background: transparent !important;
        border: 0 !important;
        color: var(--yc-muted) !important;
      }

      [page-subtype="home"]
      yt-chip-cloud-chip-renderer
      yt-formatted-string {
        font-size: 13px !important;
        font-weight: 500 !important;
      }

      [page-subtype="home"]
      yt-chip-cloud-chip-renderer[selected]
      #chip-container {
        color: var(--yc-text) !important;
        border-bottom: 2px solid var(--yc-accent) !important;
      }

      [page-subtype="home"]
      yt-chip-cloud-chip-renderer:hover
      #chip-container {
        color: var(--yc-text) !important;
      }

      /* No card backgrounds. */

      [page-subtype="home"]
      ytd-rich-grid-media,
      [page-subtype="home"]
      ytd-rich-item-renderer,
      [page-subtype="home"]
      ytd-video-meta-block {
        background: transparent !important;
        box-shadow: none !important;
      }

      [page-subtype="home"]
      ytd-rich-grid-renderer
      #contents {
        column-gap: 18px !important;
        row-gap: 28px !important;
      }

      [page-subtype="home"]
      ytd-rich-item-renderer {
        margin: 0 !important;
      }

      [page-subtype="home"]
      ytd-rich-grid-media
      #video-title,
      [page-subtype="home"]
      ytd-rich-grid-media h3 {
        font-size: 14px !important;
        line-height: 1.35 !important;
      }

      [page-subtype="home"]
      ytd-rich-grid-media
      #channel-name,
      [page-subtype="home"]
      ytd-rich-grid-media
      #metadata-line {
        color: var(--yc-muted) !important;
      }

      /* Sidebar */

      [page-subtype="home"]
      ytd-guide-entry-renderer[active]
      #endpoint {
        background: var(--yc-hover) !important;
      }

      [page-subtype="home"]
      ytd-guide-entry-renderer
      #endpoint:hover {
        background: #151515 !important;
      }
      ` : ''}

      /* ========================================================
         SEARCH
         ======================================================== */

      ${cfg.cleanSearch ? `
      ytd-searchbox #container {
        border: 1px solid var(--yc-line) !important;
        background: #0d0d0d !important;
        box-shadow: none !important;
      }

      ytd-searchbox #searchbox-button {
        width: 62px !important;
        border-left: 1px solid var(--yc-line) !important;
        background: #141414 !important;
      }
      ` : ''}

      /* ========================================================
         WATCH PAGE
         ======================================================== */

      ${cfg.cleanWatch ? `
      ytd-watch-metadata #top-row,
      ytd-watch-metadata #bottom-row,
      ytd-watch-metadata
      #top-level-buttons-computed {
        background: transparent !important;
        box-shadow: none !important;
      }

      /*
       * Like / dislike / share / ask / download:
       * one restrained segmented bar.
       */

      ytd-watch-metadata
      #top-level-buttons-computed {
        display: flex !important;
        align-items: center !important;
        gap: 0 !important;
        background: var(--yc-bg) !important;
        border: 1px solid var(--yc-line) !important;
        box-shadow: none !important;
      }

      /* Make every action segment use the same nearly-black surface as the
         rest of the page instead of YouTube's lighter gray button fills. */
      ytd-watch-metadata
      #top-level-buttons-computed > *,
      ytd-watch-metadata
      #top-level-buttons-computed button,
      ytd-watch-metadata
      #top-level-buttons-computed yt-button-view-model,
      ytd-watch-metadata
      #top-level-buttons-computed ytd-toggle-button-renderer,
      ytd-watch-metadata
      #top-level-buttons-computed .yt-spec-button-shape-next,
      ytd-watch-metadata
      #top-level-buttons-computed .yt-spec-button-shape-next::before,
      ytd-watch-metadata
      #top-level-buttons-computed .yt-spec-button-shape-next::after {
        background: var(--yc-bg) !important;
        box-shadow: none !important;
        text-shadow: none !important;
        filter: none !important;
      }

      ytd-watch-metadata
      #top-level-buttons-computed > * + * {
        border-left: 1px solid var(--yc-line) !important;
      }

      ytd-watch-metadata
      #top-level-buttons-computed button,
      ytd-watch-metadata
      #top-level-buttons-computed .yt-spec-button-shape-next {
        min-height: 38px !important;
        color: var(--yc-text) !important;
      }

      ytd-watch-metadata
      #top-level-buttons-computed > *:hover,
      ytd-watch-metadata
      #top-level-buttons-computed button:hover,
      ytd-watch-metadata
      #top-level-buttons-computed .yt-spec-button-shape-next:hover {
        background: var(--yc-hover) !important;
      }

      /* Keep the overflow segment identical to the rest of the action row. */
      ytd-watch-metadata
      #top-level-buttons-computed
      yt-button-view-model[aria-label*="More"],
      ytd-watch-metadata
      #top-level-buttons-computed
      [aria-label*="More actions"],
      ytd-watch-metadata
      #top-level-buttons-computed
      button[aria-label*="More"] {
        background: var(--yc-bg) !important;
        box-shadow: none !important;
        text-shadow: none !important;
        filter: none !important;
      }

      /* Also cover the overflow / three-dots action explicitly. */
      ytd-watch-metadata
      #top-level-buttons-computed
      yt-button-view-model[aria-label*="More"],
      ytd-watch-metadata
      #top-level-buttons-computed
      [aria-label*="More actions"],
      ytd-watch-metadata
      #top-level-buttons-computed
      button[aria-label*="More"] {
        box-shadow: none !important;
        text-shadow: none !important;
        filter: none !important;
      }

      /*
       * Description becomes a flat section.
       */

      ytd-watch-metadata #description,
      ytd-watch-metadata
      #description-inline-expander,
      ytd-watch-metadata
      #description-text {
        background: var(--yc-panel) !important;
        border: 1px solid var(--yc-line) !important;
        box-shadow: none !important;
      }
      ` : ''}

      /* ========================================================
         PERFORMANCE
         ======================================================== */

      ${cfg.performance ? `
      html {
        scroll-behavior: auto !important;
      }

      /*
       * Target UI motion instead of blindly disabling every animation
       * on the page.
       */

      ytd-app
      ytd-rich-grid-renderer *,
      ytd-app
      ytd-browse *,
      ytd-app
      ytd-search *,
      ytd-watch-metadata *,
      ytd-comments * {
        transition-duration: 0s !important;
      }

      #cinematics,
      #cinematics-container,
      #player-theater-container::before,
      #player-theater-container::after {
        background-image: none !important;
        filter: none !important;
        backdrop-filter: none !important;
      }

      ytd-moving-thumbnail-renderer,
      .ytp-videowall-still-image,
      .ytp-heat-map-hover {
        animation: none !important;
        transition: none !important;
      }

      /* Keep the loading spinner alive. */

      .ytp-spinner,
      .ytp-spinner-container,
      .ytp-spinner-circle {
        animation-duration: revert !important;
      }
      ` : ''}

      /* ========================================================
         SETTINGS PANEL
         ======================================================== */

      #yts-settings {
        position: fixed;
        inset: 0;

        z-index: 2147483647;

        display: none;
        align-items: flex-start;
        justify-content: center;

        padding-top: 10vh;

        background: rgba(0,0,0,.62);
      }

      #yts-settings.open {
        display: flex;
      }

      #yts-settings-card {
        width: min(
          620px,
          calc(100vw - 32px)
        );

        background: var(--yc-panel);
        color: var(--yc-text);

        border: 1px solid var(--yc-line);

        box-shadow:
          0 20px 80px rgba(0,0,0,.5);

        overflow: auto;
        max-height: 80vh;

        font-family:
          Roboto,
          Arial,
          sans-serif;
      }

      #yts-settings-head {
        display: flex;
        align-items: center;
        justify-content: space-between;

        padding: 18px 20px;

        border-bottom:
          1px solid var(--yc-line);
      }

      #yts-settings-head strong {
        font-size: 18px;
        font-weight: 500;
      }

      #yts-settings-head small {
        display: block;

        color: var(--yc-muted);

        margin-top: 3px;

        font-size: 11px;
      }

      #yts-close {
        width: 34px;
        height: 34px;

        border: 1px solid var(--yc-line);

        background: transparent;
        color: var(--yc-text);

        cursor: pointer;

        font-size: 18px;
      }

      #yts-close:hover {
        background: var(--yc-hover);
      }

      .yts-option {
        display: flex;
        align-items: center;
        justify-content: space-between;

        gap: 20px;

        padding: 16px 20px;

        border-bottom:
          1px solid #1f1f1f;
      }

      .yts-option strong {
        display: block;

        font-size: 14px;
        font-weight: 500;
      }

      .yts-option span {
        display: block;

        margin-top: 4px;

        max-width: 520px;

        color: var(--yc-muted);

        font-size: 12px;
        line-height: 1.45;
      }

      .yts-switch {
        appearance: none;

        width: 38px;
        height: 22px;

        flex: 0 0 auto;

        margin: 0;

        border: 0;

        background: #333;

        position: relative;

        cursor: pointer;
      }

      .yts-switch::after {
        content: "";

        position: absolute;

        left: 3px;
        top: 3px;

        width: 16px;
        height: 16px;

        background: #aaa;
      }

      .yts-switch:checked {
        background: #eee;
      }

      .yts-switch:checked::after {
        transform:
          translateX(16px);

        background: #111;
      }

      #yts-note {
        padding: 14px 20px;

        color: var(--yc-muted);

        font-size: 12px;
        line-height: 1.5;

        border-bottom:
          1px solid #1f1f1f;
      }

      #yts-key {
        padding: 12px 20px;

        color: #777;

        font-size: 11px;
      }

      #yts-key kbd {
        padding: 2px 5px;

        border: 1px solid #333;

        background: #181818;

        color: #ddd;

        font-family: monospace;
      }

      /*
       * "3x" row injected into the PLAYER's own speed submenu -
       * styled to match native .ytp-menuitem rows there.
       */
      .yts-local {
        opacity: .5;

        margin-left: .35em;

        font-size: .85em;
      }

      /*
       * "YouTube settings" row injected into the below-video "..."
       * (More actions) popup, next to Share / Ask / Download. This is
       * a different menu system than the player's, so it gets its own
       * styling that matches a normal YouTube dropdown row instead of
       * the player's dark ytp-menuitem look.
       */
      .yts-settings-entry {
        display: flex !important;
        align-items: center !important;
        gap: 16px !important;

        padding: 10px 16px !important;

        cursor: pointer !important;

        color: var(--yc-text) !important;
        font-family: Roboto, Arial, sans-serif !important;
      }

      .yts-settings-entry:hover,
      .yts-settings-entry:focus-visible {
        background: var(--yc-hover) !important;
        outline: none !important;
      }

      .yts-settings-entry-icon {
        display: flex !important;
        flex: 0 0 auto !important;

        width: 24px !important;
        height: 24px !important;

        color: var(--yc-muted) !important;
      }

      .yts-settings-entry-label {
        font-size: 14px !important;
        line-height: 1.4 !important;
      }

      .yts-dislike-count {
        display: inline-flex !important;
        align-items: center !important;
        margin-left: 6px !important;
        color: inherit !important;
        font: inherit !important;
        line-height: 1 !important;
        font-weight: 400 !important;
        white-space: nowrap !important;
        opacity: .92 !important;
      }
    `;

    (
      document.head ||
      document.documentElement
    ).appendChild(style);

    currentCssText = style.textContent;

    pruneShadowRoots();

    for (const root of knownShadowRoots) {
      installFullShadowCSS(root);
    }
  }

  // ============================================================
  // SETTINGS PANEL
  // ============================================================

  function settingRows() {
    const row = (
      key,
      title,
      desc
    ) => `
      <label class="yts-option">
        <div>
          <strong>${title}</strong>

          <span>
            ${desc}
          </span>
        </div>

        <input
          class="yts-switch"
          data-key="${key}"
          type="checkbox"
          ${cfg[key] ? 'checked' : ''}
        >
      </label>
    `;

    return `
      ${row(
        'flat',
        'Flat UI',
        'Removes every rounded corner on the page â€” thumbnails, menus, cards, avatars, buttons, the player itself, and anything YouTube renders inside a shadow root (Shorts shelves, newer lockups). Only the video-loading spinner stays circular.'
      )}

      ${row(
        'cleanHome',
        'Cleaner home',
        'Turns the category bar into quiet text tabs, removes card-like backgrounds, and tightens the video grid.'
      )}

      ${row(
        'cleanSearch',
        'Cleaner search',
        'Gives the search box a flat, restrained treatment without tying it to the home-page setting.'
      )}

      ${row(
        'cleanWatch',
        'Cleaner watch page',
        'Makes the action row one flat segmented control and removes the floating description-card feel.'
      )}

      ${row(
        'performance',
        'Performance mode',
        'Removes decorative UI motion and ambient effects without killing the player loading spinner.'
      )}

      ${row(
        'speed3x',
        '3Ã— playback',
        "Adds a local 3Ã— option to YouTube's Playback speed menu."
      )}

      ${row(
        'dislikeCount',
        'Dislike count',
        'Shows the estimated dislike count using Return YouTube Dislike data.'
      )}

      ${row(
        'preferH264',
        'Prefer H.264 / AVC1',
        'Experimental. Filters VP9/AV1 capability so the browser is more likely to receive H.264. Reload after changing for it to fully take effect.'
      )}

      <div id="yts-note">
        Dislike estimates are provided by
        <a
          href="https://returnyoutubedislike.com/"
          target="_blank"
          rel="noreferrer"
          style="color:inherit;"
        >Return YouTube Dislike</a>.
        Codec preference is deliberately opt-in.
        It only influences capability checks; H.264 is not automatically faster,
        and hardware VP9/AV1 decode can be better on some machines.
      </div>

      <div id="yts-key">
        Open these controls from the "..." (More actions) menu below
        the video, next to Share, Ask and Download.
      </div>
    `;
  }

  function ensureSettings() {
    if (
      document.getElementById(
        'yts-settings'
      )
    ) {
      return;
    }

    const overlay =
      document.createElement(
        'div'
      );

    overlay.id =
      'yts-settings';

    overlay.innerHTML = `
      <div
        id="yts-settings-card"
        role="dialog"
        aria-modal="true"
      >
        <div
          id="yts-settings-head"
        >
          <div>
            <strong>
              YouTube
            </strong>

            <small>
              Clean interface settings
            </small>
          </div>

          <button
            id="yts-close"
            type="button"
            aria-label="Close"
          >
            Ã—
          </button>
        </div>

        ${settingRows()}
      </div>
    `;

    overlay.addEventListener(
      'click',
      (event) => {
        if (
          event.target === overlay
        ) {
          closeSettings();
        }
      }
    );

    overlay
      .querySelector(
        '#yts-close'
      )
      .addEventListener(
        'click',
        closeSettings
      );

    overlay
      .querySelectorAll(
        '.yts-switch'
      )
      .forEach((input) => {
        input.addEventListener(
          'change',
          () => {
            const key =
              input.dataset.key;

            if (!key) return;

            cfg[key] =
              input.checked;

            writeConfig();

            if (
              key ===
              'preferH264'
            ) {
              // Best-effort: apply immediately for anything probed
              // after this point. Streams/formats already negotiated
              // before the toggle won't retroactively change, hence
              // the reload note below.
              if (cfg.preferH264) {
                installCodecHook();
              } else {
                uninstallCodecHook();
              }

              const note = overlay.querySelector('#yts-note');
              if (note && key === 'preferH264') {
                note.innerHTML =
                  'Codec preference changed. It is saved until you change it again; the current page uses the new setting immediately for future capability checks. Reloading YouTube is recommended before starting a new video.';
              }
            }

            if (
              key === 'dislikeCount'
            ) {
              if (cfg.dislikeCount) {
                loadDislikeCount();
              } else {
                refreshDislikeUI();
              }
            }

            if (
              key === 'speed3x' &&
              !cfg.speed3x
            ) {
              local3xVideo = null;
              clearTimeout(speed3xTimer);

              document
                .querySelectorAll(
                  '.yts-3x'
                )
                .forEach(
                  (node) =>
                    node.remove()
                );
            }
          }
        );
      });

    document.documentElement
      .appendChild(
        overlay
      );
  }

  function openSettings() {
    ensureSettings();

    const panel =
      document.getElementById(
        'yts-settings'
      );

    if (!panel) return;

    panel.classList.add(
      'open'
    );

    panel
      .querySelectorAll(
        '.yts-switch'
      )
      .forEach((input) => {
        input.checked =
          Boolean(
            cfg[
              input.dataset.key
            ]
          );
      });
  }

  function closeSettings() {
    document
      .getElementById(
        'yts-settings'
      )
      ?.classList.remove(
        'open'
      );
  }

  // ============================================================
  // DISLIKE COUNT
  // ============================================================

  const RYD_ORIGIN =
    'https://returnyoutubedislikeapi.com';

  const RYD_API =
    `${RYD_ORIGIN}/votes?videoId=`;

  const dislikeCache =
    new Map();

  let dislikeAbort = null;
  let pendingDislike = null;

  function installRYDPreconnect() {
    if (
      document.querySelector(
        'link[data-yts-ryd-preconnect]'
      )
    ) {
      return;
    }

    const link =
      document.createElement('link');

    link.rel = 'preconnect';
    link.href = RYD_ORIGIN;
    link.crossOrigin = 'anonymous';
    link.dataset.ytsRydPreconnect = '';

    (
      document.head ||
      document.documentElement
    ).appendChild(link);
  }

  installRYDPreconnect();

  function getVideoId() {
    try {
      return new URL(
        location.href
      ).searchParams.get('v') || '';
    } catch {
      return '';
    }
  }

  function formatCount(value) {
    const count =
      Number(value);

    if (
      !Number.isFinite(count) ||
      count < 0
    ) {
      return '';
    }

    return new Intl.NumberFormat(
      undefined,
      {
        notation: 'compact',
        maximumFractionDigits: 1,
      }
    ).format(
      Math.round(count)
    );
  }

  function findDislikeButton() {
    return (
      document.querySelector(
        '#actions dislike-button-view-model button'
      ) ||
      document.querySelector(
        '#top-level-buttons-computed dislike-button-view-model button'
      ) ||
      document.querySelector(
        'dislike-button-view-model button'
      ) ||
      document.querySelector(
        '#top-level-buttons-computed [data-testid="dislike-button"]'
      ) ||
      [
        ...document.querySelectorAll(
          '#top-level-buttons-computed button'
        ),
      ].find((button) =>
        /dislike|no me gusta|Ð½Ðµ Ð½Ñ€Ð°Ð²Ð¸Ñ‚ÑÑ|je n.?aime pas|nÃ£o gostei/i.test(
          button.getAttribute(
            'aria-label'
          ) || ''
        )
      ) ||
      null
    );
  }

  function removeDislikeNodes() {
    document
      .querySelectorAll(
        '.yts-dislike-count'
      )
      .forEach(
        (node) => node.remove()
      );
  }

  function applyDislikeCount(
    value
  ) {
    const button =
      findDislikeButton();

    if (!button) {
      pendingDislike =
        value;

      return false;
    }

    const existing =
      button.querySelector(
        '.yts-dislike-count'
      );

    if (!value) {
      existing?.remove();
      pendingDislike = null;
      return true;
    }

    const node =
      existing ||
      document.createElement(
        'span'
      );

    node.className =
      'yts-dislike-count';

    node.textContent =
      value;

    node.title =
      'Estimated dislikes Â· Return YouTube Dislike';

    node.setAttribute(
      'aria-label',
      `${value} estimated dislikes`
    );

    if (!existing) {
      button.appendChild(node);
    }

    pendingDislike = null;
    return true;
  }

  async function fetchDislikeCount(
    videoId
  ) {
    if (!videoId) {
      return '';
    }

    if (
      dislikeCache.has(videoId)
    ) {
      return dislikeCache.get(
        videoId
      );
    }

    dislikeAbort?.abort();

    const controller =
      new AbortController();

    dislikeAbort =
      controller;

    try {
      const response =
        await fetch(
          `${RYD_API}${encodeURIComponent(videoId)}`,
          {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
            cache: 'default',
            signal:
              controller.signal,
          }
        );

      if (!response.ok) {
        throw new Error(
          `RYD request failed: ${response.status}`
        );
      }

      const data =
        await response.json();

      if (
        controller.signal.aborted
      ) {
        return '';
      }

      const formatted =
        formatCount(
          data?.dislikes
        );

      dislikeCache.set(
        videoId,
        formatted
      );

      return formatted;
    } catch (error) {
      if (
        error?.name !==
        'AbortError'
      ) {
        console.debug(
          '[YouTube] dislike count unavailable',
          error
        );
      }

      return '';
    } finally {
      if (
        dislikeAbort ===
        controller
      ) {
        dislikeAbort = null;
      }
    }
  }

  async function loadDislikeCount(
    videoId = getVideoId()
  ) {
    if (
      !cfg.dislikeCount ||
      !videoId
    ) {
      removeDislikeNodes();
      pendingDislike = null;
      return;
    }

    const count =
      await fetchDislikeCount(
        videoId
      );

    if (
      videoId !==
      getVideoId()
    ) {
      return;
    }

    applyDislikeCount(
      count
    );
  }

  function refreshDislikeUI() {
    if (!cfg.dislikeCount) {
      removeDislikeNodes();
      pendingDislike = null;
      return;
    }

    if (
      pendingDislike !== null
    ) {
      applyDislikeCount(
        pendingDislike
      );
      return;
    }

    const cached =
      dislikeCache.get(
        getVideoId()
      );

    if (cached) {
      applyDislikeCount(
        cached
      );
    }
  }

  // Called on every SPA navigation (see navigationChanged() and the
  // initial start() below). This used to be called without ever being
  // defined, which threw a ReferenceError on load and on every
  // navigation - silently breaking attachRootObserver()/
  // attachPlayerObserver() right after it in both callers, since the
  // throw happened before they ran.
  function handleDislikeNavigation() {
    // The previous video's dislike node lived on a button that's been
    // torn down by now, and any pendingDislike value could still be
    // referring to a video id that no longer matches the URL.
    removeDislikeNodes();
    pendingDislike = null;
    loadDislikeCount();
  }

  // ============================================================
  // PLAYER MENU (the player's own gear / three-dot settings menu,
  // opened from the video controls - handles the local 3x speed
  // option only. The "YouTube settings" entry now lives in the
  // below-video "..." menu instead; see MORE ACTIONS MENU below.)
  // ============================================================

  // getClientRects().length works for position:fixed elements too;
  // offsetParent is spec'd to return null for fixed-position elements
  // in Chromium/WebKit regardless of actual visibility, which used to
  // make this silently miss menus while in fullscreen/theater mode.
  function isVisible(el) {
    if (!el) return false;

    const style = getComputedStyle(el);

    if (
      style.display === 'none' ||
      style.visibility === 'hidden'
    ) {
      return false;
    }

    return el.getClientRects().length > 0;
  }

  function visiblePlayerMenus() {
    return [
      ...document.querySelectorAll(
        '#movie_player .ytp-settings-menu,' +
        '#movie_player .ytp-panel-menu'
      ),
    ].filter(isVisible);
  }

  function isSpeedMenu(menu) {
    if (!menu) return false;

    // Prefer YouTube's actual speed-menu row labels when available.
    const labels = [
      ...menu.querySelectorAll(
        '.ytp-menuitem-label'
      ),
    ].map((node) =>
      (node.textContent || '').trim()
    );

    const hasNormal = labels.some(
      (label) => /^Normal$/i.test(label)
    );

    const hasSpeed = labels.some(
      (label) => /^(?:1(?:\.0)?|1\.25|1\.5|1\.75|2(?:\.0)?)x?$/i.test(label)
    );

    if (hasNormal && hasSpeed) {
      return true;
    }

    // Fallback for player builds whose menu markup has changed.
    const text =
      menu.textContent || '';

    return (
      /(?:^|\s)Normal(?:\s|$)/i.test(text) &&
      /(?:^|\s)(?:1\.25|1\.5|1\.75|2(?:\.0)?)(?:x)?(?:\s|$)/i.test(text)
    );
  }

  function add3x(menu) {
    if (
      !cfg.speed3x ||
      !isSpeedMenu(menu)
    ) {
      return;
    }

    if (
      menu.querySelector(
        '.yts-3x'
      )
    ) {
      return;
    }

    const item =
      document.createElement(
        'div'
      );

    item.className =
      'ytp-menuitem yts-3x';

    item.setAttribute(
      'role',
      'menuitem'
    );

    item.tabIndex = 0;

    item.innerHTML = `
      <div class="ytp-menuitem-label">
        3Ã—
        <span class="yts-local">
          (local)
        </span>
      </div>

      <div class="ytp-menuitem-content"></div>
    `;

    const activate =
      (event) => {
        event.preventDefault();
        event.stopPropagation();

        const video =
          document.querySelector(
            '#movie_player video.html5-main-video,' +
            '#movie_player video'
          );

        if (!video) return;

        local3xVideo = video;
        video.playbackRate = 3;
        maintainLocal3x();

        try {
          video.defaultPlaybackRate = 3;
        } catch {}

        menu.dispatchEvent(
          new KeyboardEvent(
            'keydown',
            {
              key: 'Escape',
              code: 'Escape',
              bubbles: true,
              cancelable: true,
            }
          )
        );

        if (isVisible(menu)) {
          menu.dispatchEvent(
            new MouseEvent(
              'mouseleave',
              {
                bubbles: true,
              }
            )
          );
        }
      };

    item.addEventListener(
      'click',
      activate,
      true
    );

    item.addEventListener(
      'keydown',
      (event) => {
        if (
          event.key === 'Enter' ||
          event.key === ' '
        ) {
          activate(event);
        }
      },
      true
    );

    menu.appendChild(
      item
    );
  }

  function maintainLocal3x() {
    clearTimeout(speed3xTimer);

    if (!cfg.speed3x || !local3xVideo) {
      return;
    }

    if (!local3xVideo.isConnected) {
      local3xVideo = null;
      return;
    }

    if (Math.abs(local3xVideo.playbackRate - 3) > 0.01) {
      local3xVideo.playbackRate = 3;
    }

    speed3xTimer = setTimeout(maintainLocal3x, 250);
  }

  function processPlayerMenus() {
    for (
      const menu of
        visiblePlayerMenus()
    ) {
      if (
        isSpeedMenu(menu)
      ) {
        add3x(menu);
      }
    }
  }

  function schedulePlayerMenuWork() {
    clearTimeout(
      menuTimer
    );

    menuTimer =
      setTimeout(
        processPlayerMenus,
        35
      );
  }

  document.addEventListener(
    'click',
    (event) => {
      const target =
        event.target instanceof
        Element
          ? event.target
          : event.target?.parentElement;

      if (!target) return;

      if (
        target.closest(
          '#movie_player .ytp-settings-button,' +
          '#movie_player .ytp-panel-menu .ytp-menuitem'
        )
      ) {
        schedulePlayerMenuWork();
      }
    },
    true
  );

  // ============================================================
  // "MORE ACTIONS" MENU
  //
  // YouTube's current desktop watch page uses ytd-menu-renderer /
  // yt-button-view-model for the overflow trigger. The popup can be
  // rendered in a light DOM popup container or inside an open ShadowRoot,
  // depending on the current experiment/rollout. We therefore:
  //   1) identify the exact below-video trigger by aria-label/title,
  //   2) search document + every open YouTube ShadowRoot,
  //   3) prefer actual list/menu containers (#items, role=menu, paper-listbox),
  //   4) score candidates by proximity to the trigger and by known menu text,
  //   5) observe shadow roots only briefly after the user opens the menu.
  // ============================================================

  let lastMoreActionsTrigger = null;
  let moreActionsObserver = null;
  const temporaryMenuObservers = new Map();

  function activeShadowRoots() {
    pruneShadowRoots();
    return [document, ...knownShadowRoots];
  }

  function allMatching(selector) {
    const result = [];
    const seen = new Set();
    for (const root of activeShadowRoots()) {
      try {
        for (const el of root.querySelectorAll(selector)) {
          if (!seen.has(el)) {
            seen.add(el);
            result.push(el);
          }
        }
      } catch {}
    }
    return result;
  }

  function elementLabel(el) {
    if (!(el instanceof Element)) return '';
    const values = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.textContent,
    ];

    try {
      values.push(
        ...Array.from(el.querySelectorAll('[aria-label], [title]')).flatMap((node) => [
          node.getAttribute('aria-label'),
          node.getAttribute('title'),
        ])
      );
    } catch {}

    return values.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function composedAncestors(el) {
    const nodes = [];
    let node = el;

    while (node) {
      if (node instanceof Element) nodes.push(node);

      if (node.parentElement) {
        node = node.parentElement;
        continue;
      }

      const root = node.getRootNode?.();
      if (root && root.host) {
        node = root.host;
      } else {
        break;
      }
    }

    return nodes;
  }

  function isInsideWatchMetadata(el) {
    return composedAncestors(el).some(
      (node) =>
        node.matches?.('ytd-watch-metadata') ||
        node.id === 'top-level-buttons-computed' ||
        node.id === 'actions' ||
        node.matches?.('ytd-menu-renderer')
    );
  }

  function isWatchMoreActionsButton(el) {
    if (!(el instanceof Element)) return false;
    if (composedAncestors(el).some((node) => node.id === 'movie_player')) return false;

    const label = elementLabel(el);
    if (!/(?:^|\\b)(?:more actions|more options|overflow|more)(?:\\b|$)/i.test(label)) {
      return false;
    }

    return isInsideWatchMetadata(el) && isVisible(el);
  }

  function findCurrentMoreActionsButton() {
    const directSelectors = [
      'ytd-watch-metadata ytd-menu-renderer button[aria-label]',
      'ytd-watch-metadata ytd-menu-renderer [aria-label]',
      'ytd-watch-metadata #top-level-buttons-computed button[aria-label]',
      'ytd-watch-metadata #top-level-buttons-computed [aria-label]',
      'ytd-watch-metadata #actions button[aria-label]',
      'ytd-watch-metadata #actions [aria-label]',
      'ytd-watch-metadata segmented-like-dislike-button-view-model button[aria-label]',
      'ytd-watch-metadata yt-button-view-model[aria-label]',
      'ytd-watch-metadata yt-button-shape[aria-label]',
    ];

    for (const selector of directSelectors) {
      const candidates = allMatching(selector).filter(isVisible);
      if (candidates.length) return candidates[0];
    }

    const fallback = allMatching(
      'ytd-watch-metadata button, ytd-watch-metadata [role="button"], ytd-watch-metadata yt-button-view-model, ytd-watch-metadata yt-button-shape'
    );

    return fallback.find(isWatchMoreActionsButton) || null;
  }

  function isVisibleMenuCandidate(el) {
    if (!el || !isVisible(el)) return false;
    if (el.closest?.('#movie_player')) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 10) return false;

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
      return false;
    }
    return true;
  }

  function popupTextScore(el) {
    const text = (el.textContent || '').toLowerCase();
    let score = 0;

    if (el.matches?.('[role="menu"], #items, tp-yt-paper-listbox')) score += 2;
    const labels = [
      ['share', 5],
      ['ask', 4],
      ['save', 5],
      ['download', 5],
      ['report', 3],
      ['clip', 2],
      ['not interested', 2],
      ['create a clip', 2],
    ];

    for (const [needle, value] of labels) {
      if (text.includes(needle)) score += value;
    }
    return score;
  }

  function popupDistanceToTrigger(popup, trigger) {
    if (!trigger) return Number.POSITIVE_INFINITY;
    const a = trigger.getBoundingClientRect();
    const b = popup.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    return Math.hypot(ax - bx, ay - by);
  }

  function menuContainersFromRoot(root) {
    const selectors = [
      'tp-yt-iron-dropdown ytd-menu-popup-renderer #items',
      'ytd-popup-container ytd-menu-popup-renderer #items',
      'ytd-popup-container tp-yt-paper-listbox',
      'tp-yt-paper-listbox',
      '[role="menu"]',
      '#items',
      'ytd-menu-popup-renderer',
      'yt-sheet-view-model',
      'ytd-popup-container',
    ];

    const results = [];
    const seen = new Set();
    for (const selector of selectors) {
      try {
        for (const el of root.querySelectorAll(selector)) {
          if (seen.has(el) || !isVisibleMenuCandidate(el)) continue;
          seen.add(el);
          results.push(el);
        }
      } catch {}
    }
    return results;
  }

  function popupCandidates() {
    const candidates = [];
    const seen = new Set();

    for (const root of activeShadowRoots()) {
      for (const el of menuContainersFromRoot(root)) {
        if (!seen.has(el)) {
          seen.add(el);
          candidates.push(el);
        }
      }
    }

    return candidates;
  }

  function findMoreActionsPopup() {
    const trigger = lastMoreActionsTrigger || findCurrentMoreActionsButton();
    const candidates = popupCandidates();
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const ta = popupTextScore(a);
      const tb = popupTextScore(b);
      if (ta !== tb) return tb - ta;

      const da = popupDistanceToTrigger(a, trigger);
      const db = popupDistanceToTrigger(b, trigger);
      if (da !== db) return da - db;

      // Prefer actual menu/list containers over the outer sheet wrapper.
      const aRole = a.matches?.('[role="menu"], #items, tp-yt-paper-listbox') ? 0 : 1;
      const bRole = b.matches?.('[role="menu"], #items, tp-yt-paper-listbox') ? 0 : 1;
      if (aRole !== bRole) return aRole - bRole;

      // Prefer smaller, actionable containers.
      return (a.textContent || '').length - (b.textContent || '').length;
    });

    return candidates[0] || null;
  }

  function settingsEntryExistsAnywhere() {
    return allMatching('.yts-settings-entry').length > 0;
  }

  function addSettingsEntry(container) {
    if (!container || container.querySelector?.('.yts-settings-entry')) return false;

    // Do not inject into a generic wrapper if there is a concrete list inside it.
    const nested = container.querySelector?.('[role="menu"], #items, tp-yt-paper-listbox');
    if (nested && nested !== container) {
      return addSettingsEntry(nested);
    }

    const item = document.createElement('div');
    item.className = 'yts-settings-entry';
    item.setAttribute('role', 'menuitem');
    item.tabIndex = 0;
    item.setAttribute('data-yts-settings-entry', '');
    item.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:16px',
      'box-sizing:border-box',
      'width:100%',
      'min-height:48px',
      'padding:10px 16px',
      'margin:0',
      'border:0',
      'background:transparent',
      'color:inherit',
      'font:inherit',
      'text-align:left',
      'cursor:pointer',
    ].join(';');

    item.innerHTML = `
      <span aria-hidden="true" style="display:flex;flex:0 0 auto;width:24px;height:24px;align-items:center;justify-content:center;opacity:.8">
        <svg viewBox="0 0 24 24" width="24" height="24" style="display:block">
          <path fill="currentColor" d="M19.14,12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.4,2.81c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41L9.25,5.35c-.59.24-1.13.56-1.62.94L5.24,5.33c-.22-.08-.47,0-.59.22L2.74,8.87c-.12.21-.08.47.12.61l2.03,1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03,1.58c-.18.14-.23.41-.12.61l1.92,3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36,2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.07-.21.02-.47-.12-.61l-2.03-1.58ZM12,15.6A3.6,3.6,0,1,1,12,8.4a3.6,3.6,0,0,1,0,7.2Z"/>
        </svg>
      </span>
      <span style="font-size:14px;line-height:1.4;white-space:nowrap">YouTube settings</span>
    `;

    const hoverOn = () => { item.style.background = 'rgba(255,255,255,.08)'; };
    const hoverOff = () => { item.style.background = 'transparent'; };
    item.addEventListener('mouseenter', hoverOn);
    item.addEventListener('mouseleave', hoverOff);
    item.addEventListener('focus', hoverOn);
    item.addEventListener('blur', hoverOff);

    const activate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      try { container.closest?.('tp-yt-iron-dropdown')?.close?.(); } catch {}
      try { container.closest?.('yt-sheet-view-model')?.close?.(); } catch {}
      openSettings();
    };

    item.addEventListener('click', activate, true);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    }, true);

    container.appendChild(item);

    // YouTube sometimes re-renders #items immediately after opening the menu.
    // Keep the custom row alive for the lifetime of this popup without using
    // a permanent page-wide observer.
    try {
      const observer = new MutationObserver(() => {
        if (!container.isConnected) {
          observer.disconnect();
          return;
        }
        if (!container.querySelector('.yts-settings-entry')) {
          container.appendChild(item);
        }
      });
      observer.observe(container, { childList: true, subtree: false });
      window.setTimeout(() => observer.disconnect(), 5000);
    } catch {}

    return true;
  }

  function processMoreActionsPopup() {
    if (settingsEntryExistsAnywhere()) return true;

    const popup = findMoreActionsPopup();
    if (popup) {
      return addSettingsEntry(popup);
    }

    // Fallback: current desktop menu variants expose the item renderer
    // directly. If a visible Download/Report menu is present, inject into
    // its nearest concrete menu parent even when the trigger could not be
    // captured due to an experimental Shadow DOM wrapper.
    const itemNodes = allMatching('ytd-menu-service-item-renderer').filter(isVisibleMenuCandidate);
    for (const item of itemNodes) {
      const text = (item.textContent || '').toLowerCase();
      if (!/(?:download|report|share|ask|save)/.test(text)) continue;

      const parent = item.parentElement;
      if (parent && isVisibleMenuCandidate(parent)) {
        return addSettingsEntry(parent);
      }
    }

    return false;
  }

  function stopTemporaryMenuObservers() {
    for (const observer of temporaryMenuObservers.values()) {
      try { observer.disconnect(); } catch {}
    }
    temporaryMenuObservers.clear();
  }

  function armTemporaryMenuObservers() {
    stopTemporaryMenuObservers();

    const roots = activeShadowRoots();
    for (const root of roots) {
      if (root === document) continue;
      try {
        const observer = new MutationObserver(() => {
          if (lastMoreActionsTrigger) processMoreActionsPopup();
        });
        observer.observe(root, { childList: true, subtree: true });
        temporaryMenuObservers.set(root, observer);
      } catch {}
    }

    window.setTimeout(stopTemporaryMenuObservers, 2500);
  }

  function scheduleMoreActionsWork() {
    window.clearTimeout(moreActionsTimer);
    moreActionsTimer = window.setTimeout(processMoreActionsPopup, 30);
  }

  function processMoreActionsBurst() {
    [0, 20, 50, 100, 180, 300, 500, 800, 1200, 1800].forEach((delay) => {
      window.setTimeout(processMoreActionsPopup, delay);
    });
  }

  document.addEventListener('click', (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const candidates = [
      ...path.filter((node) => node instanceof Element),
      event.target instanceof Element ? event.target : null,
    ].filter(Boolean);

    const trigger = candidates.find((node) => {
      if (isWatchMoreActionsButton(node)) return true;
      const closestButton = node.closest?.(
        'button, [role="button"], yt-icon-button, tp-yt-paper-icon-button, yt-button-view-model, yt-button-shape'
      );
      return !!closestButton && isWatchMoreActionsButton(closestButton);
    }) || findCurrentMoreActionsButton();

    if (!trigger) return;

    lastMoreActionsTrigger = trigger;
    armTemporaryMenuObservers();
    processMoreActionsBurst();
  }, true);

  function installMoreActionsObserver() {
    if (moreActionsObserver || !document.documentElement) return;

    moreActionsObserver = new MutationObserver(() => {
      if (lastMoreActionsTrigger) scheduleMoreActionsWork();
    });

    moreActionsObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  installMoreActionsObserver();
    // ============================================================
  // END MORE ACTIONS MENU
  // ============================================================

  // ============================================================
  // PERFORMANCE-SAFE OBSERVERS
  // ============================================================

  function attachPlayerObserver() {
    const player =
      document.getElementById(
        'movie_player'
      );

    if (!player) {
      if (playerObserver) {
        playerObserver.disconnect();
        playerObserver = null;
      }

      observedPlayer = null;
      attachRootObserver();
      return false;
    }

    if (
      playerObserver &&
      observedPlayer === player
    ) {
      return true;
    }

    playerObserver?.disconnect();

    playerObserver = null;
    observedPlayer = player;

    playerObserver =
      new MutationObserver(
        (mutations) => {
          for (
            const mutation of
              mutations
          ) {
            if (
              mutation.type !==
              'childList'
            ) {
              continue;
            }

            for (
              const node of
                mutation.addedNodes
            ) {
              if (
                !(node instanceof
                  Element)
              ) {
                continue;
              }

              if (
                node.matches?.(
                  '.ytp-settings-menu,' +
                  '.ytp-panel-menu'
                ) ||
                node.querySelector?.(
                  '.ytp-settings-menu,' +
                  '.ytp-panel-menu'
                )
              ) {
                schedulePlayerMenuWork();
              }

              if (
                node.matches?.(
                  '#actions,' +
                  'dislike-button-view-model,' +
                  'ytd-watch-metadata'
                ) ||
                node.querySelector?.(
                  '#actions dislike-button-view-model,' +
                  'dislike-button-view-model'
                )
              ) {
                refreshDislikeUI();
              }
            }
          }
        }
      );

    playerObserver.observe(
      player,
      {
        childList: true,
        subtree: true,
      }
    );

    // We only need the root observer while the player is unavailable.
    // This keeps the fallback without paying for a permanent whole-page
    // mutation observer during normal playback.
    if (rootObserver) {
      rootObserver.disconnect();
      rootObserver = null;
    }

    return true;
  }

  function attachRootObserver() {
    if (rootObserver) {
      return;
    }

    // There is nothing to wait for when the player is already attached.
    if (document.getElementById('movie_player')) {
      return;
    }

    const root =
      document.getElementById(
        'page-manager'
      ) ||
      document.body ||
      document.documentElement;

    if (!root) {
      return;
    }

    rootObserver =
      new MutationObserver(
        (mutations) => {
          for (
            const mutation of
              mutations
          ) {
            if (
              mutation.type !==
              'childList'
            ) {
              continue;
            }

            for (
              const node of
                mutation.addedNodes
            ) {
              if (
                !(node instanceof
                  Element)
              ) {
                continue;
              }

              if (
                node.id ===
                  'movie_player' ||
                node.querySelector?.(
                  '#movie_player'
                )
              ) {
                attachPlayerObserver();
                return;
              }
            }
          }
        }
      );

    rootObserver.observe(
      root,
      {
        childList: true,
        subtree: true,
      }
    );
  }

  function navigationChanged() {
    if (
      location.href ===
      lastURL
    ) {
      return;
    }

    lastURL =
      location.href;

    handleDislikeNavigation();

    playerObserver?.disconnect();

    playerObserver =
      null;

    observedPlayer = null;

    local3xVideo = null;
    clearTimeout(speed3xTimer);

    attachRootObserver();
    attachPlayerObserver();
  }

  window.addEventListener(
    'yt-navigate-finish',
    navigationChanged,
    {
      passive: true,
    }
  );

  window.addEventListener(
    'popstate',
    navigationChanged,
    {
      passive: true,
    }
  );

  window.addEventListener(
    'yt-player-updated',
    () => {
      attachPlayerObserver();

      const id =
        getVideoId();

      const cached =
        dislikeCache.get(id);

      if (cached) {
        applyDislikeCount(
          cached
        );
      } else {
        loadDislikeCount(id);
      }
    },
    {
      passive: true,
    }
  );

  // ============================================================
  // CODEC
  // ============================================================

  // The preference is persisted in localStorage, but the actual monkey
  // patches only exist for the lifetime of this page. Keep references to
  // the originals so turning the setting OFF can immediately restore the
  // browser APIs without requiring a reload.
  let codecHookInstalled = false;
  let originalMediaSourceIsTypeSupported = null;
  let originalCanPlayType = null;
  let originalDecodingInfo = null;

  function isModernCodecType(type) {
    const value = String(type || '');

    return (
      /(?:^|[;,)\s])codecs\s*=\s*["']?[^"'\s;]*(?:vp09|vp9|av01)[^"'\s;]*["']?/i.test(value) ||
      /(?:^|[;,)\s])(?:vp09|vp9|av01)(?:[._-]|$)/i.test(value)
    );
  }

  function installCodecHook() {
    if (codecHookInstalled || !cfg.preferH264) return;

    try {
      if (
        typeof MediaSource !== 'undefined' &&
        typeof MediaSource.isTypeSupported === 'function'
      ) {
        originalMediaSourceIsTypeSupported = MediaSource.isTypeSupported;

        MediaSource.isTypeSupported = function (type) {
          if (isModernCodecType(type)) return false;
          return originalMediaSourceIsTypeSupported.call(MediaSource, type);
        };
      }
    } catch (error) {
      console.debug('[YouTube] MediaSource H.264 hook failed', error);
    }

    try {
      if (
        typeof HTMLMediaElement !== 'undefined' &&
        typeof HTMLMediaElement.prototype.canPlayType === 'function'
      ) {
        originalCanPlayType = HTMLMediaElement.prototype.canPlayType;

        HTMLMediaElement.prototype.canPlayType = function (type) {
          if (isModernCodecType(type)) return '';
          return originalCanPlayType.call(this, type);
        };
      }
    } catch (error) {
      console.debug('[YouTube] canPlayType H.264 hook failed', error);
    }

    try {
      if (
        navigator.mediaCapabilities &&
        typeof navigator.mediaCapabilities.decodingInfo === 'function'
      ) {
        originalDecodingInfo = navigator.mediaCapabilities.decodingInfo;

        navigator.mediaCapabilities.decodingInfo = async function (config) {
          const contentType =
            config?.video?.contentType ||
            config?.audio?.contentType ||
            '';

          if (isModernCodecType(contentType)) {
            return {
              supported: false,
              smooth: false,
              powerEfficient: false,
            };
          }

          return originalDecodingInfo.call(navigator.mediaCapabilities, config);
        };
      }
    } catch (error) {
      console.debug('[YouTube] mediaCapabilities H.264 hook failed', error);
    }

    codecHookInstalled = true;
  }

  function uninstallCodecHook() {
    if (!codecHookInstalled) return;

    try {
      if (
        originalMediaSourceIsTypeSupported &&
        typeof MediaSource !== 'undefined'
      ) {
        MediaSource.isTypeSupported = originalMediaSourceIsTypeSupported;
      }
    } catch {}

    try {
      if (
        originalCanPlayType &&
        typeof HTMLMediaElement !== 'undefined'
      ) {
        HTMLMediaElement.prototype.canPlayType = originalCanPlayType;
      }
    } catch {}

    try {
      if (
        originalDecodingInfo &&
        navigator.mediaCapabilities
      ) {
        navigator.mediaCapabilities.decodingInfo = originalDecodingInfo;
      }
    } catch {}

    originalMediaSourceIsTypeSupported = null;
    originalCanPlayType = null;
    originalDecodingInfo = null;
    codecHookInstalled = false;
  }

  // ============================================================
  // START
  // ============================================================

  installCodecHook();
  installCSS();

  function start() {
    ensureSettings();
    installMoreActionsObserver();
    attachRootObserver();
    attachPlayerObserver();
    handleDislikeNavigation();
  }

  if (
    document.readyState ===
    'loading'
  ) {
    document.addEventListener(
      'DOMContentLoaded',
      start,
      { once: true }
    );
  } else {
    start();
  }
})();
