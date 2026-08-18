// ==UserScript==
// @name         chatgpt
// @namespace    chatgpt
// @version      1
// @description  chatgpt
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const KEEP_PAIRS = 3;
  const KEEP_TURNS = KEEP_PAIRS * 2;
  const APPLY_DELAY = 300;
  const GENERATING_DELAY = 800;
  const SCROLL_PAUSE = 350;
  const EST_TURN_HEIGHT = "500px"; // rough average turn height for contain-intrinsic-size

  let timer;
  let scrollTimer;
  let scrolling = false;
  let applying = false;
  let lastUrl = location.href;
  let observedRoot = null;
  let observer = null;

  const root = () => document.querySelector("main") || document.body;

  const generating = () => !!document.querySelector(
    'button[data-testid="stop-button"],button[aria-label*="Stop" i],[aria-busy="true"]'
  );

  const style = () => {
    if (document.getElementById("cgc4-style")) return;

    const el = document.createElement("style");
    el.id = "cgc4-style";
    el.textContent = `
      /* Scoped to the class alone (not "main article.cgc4-old") so it still
         matches when turns() falls back to non-<article> nodes, e.g.
         section[data-turn="user"]. */
      main .cgc4-old {
        content-visibility:auto!important;
        contain:layout style paint!important;
        contain-intrinsic-size:auto ${EST_TURN_HEIGHT}!important;
      }
      main .cgc4-old pre {
        max-height:110px!important;
        overflow:auto!important;
        contain:layout paint!important;
      }
      main .cgc4-old table {
        display:block!important;
        max-height:150px!important;
        overflow:auto!important;
        contain:layout paint!important;
      }
      main .cgc4-old img,
      main .cgc4-old video,
      main .cgc4-old canvas,
      main .cgc4-old iframe {
        max-height:180px!important;
        object-fit:contain!important;
        contain:layout paint!important;
      }
      /* Paused instead of speeding up to .001s: an !important animation-duration
         override doesn't stop infinite-loop animations (typing indicators,
         spinners), it just makes them iterate ~1000x/sec, which is worse than
         doing nothing. animation-play-state:paused actually freezes them. */
      main .cgc4-old *,
      main .cgc4-old *::before,
      main .cgc4-old *::after {
        animation-play-state:paused!important;
        transition-duration:.001s!important;
        scroll-behavior:auto!important;
      }
    `;
    document.documentElement.appendChild(el);
  };

  const turns = () => {
    const r = root();
    let list = [];

    for (const selector of [
      'article[data-testid^="conversation-turn"]',
      'article[data-testid*="conversation-turn"]',
      'section[data-turn="user"]',
      'section[data-turn="assistant"]'
    ]) {
      list = [...r.querySelectorAll(selector)];
      if (list.length) break;
    }

    if (!list.length) {
      list = [...r.querySelectorAll("[data-message-author-role]")]
        .map(el => el.closest("article") || el);
    }

    if (!list.length) list = [...r.querySelectorAll("article")];

    const seen = new Set();
    const deduped = list.filter(el => {
      if (!(el instanceof HTMLElement) || seen.has(el) || !el.textContent.trim()) return false;
      seen.add(el);
      return true;
    });

    // querySelectorAll already returns document order, and the fixed-selector
    // branches break after the first match (nothing to merge/reorder). Only
    // the data-message-author-role fallback can produce out-of-order or
    // duplicate nodes via closest("article"), so only sort in that case.
    const needsSort = list.length && !list[0].matches?.(
      'article[data-testid^="conversation-turn"],article[data-testid*="conversation-turn"],section[data-turn="user"],section[data-turn="assistant"],article'
    );

    if (!needsSort) return deduped;

    return deduped.sort((a, b) => {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  };

  const userTurn = el => {
    const role = el.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role");
    return role === "user" || el.getAttribute("data-turn") === "user";
  };

  const keepFrom = list => {
    let users = 0;

    for (let i = list.length - 1; i >= 0; i--) {
      if (userTurn(list[i]) && ++users === KEEP_PAIRS) return i;
    }

    return Math.max(0, list.length - KEEP_TURNS);
  };

  const apply = () => {
    if (applying || generating()) return;

    applying = true;

    try {
      const list = turns();

      // Root can change (SPA navigation swaps <main>) - keep the observer
      // scoped to the live conversation container instead of document.body.
      watchRoot();

      if (list.length <= KEEP_TURNS) {
        list.forEach(el => el.classList.remove("cgc4-old"));
        return;
      }

      const start = keepFrom(list);

      list.forEach((el, i) => {
        const old = i < start;
        el.classList.toggle("cgc4-old", old);

        if (old) {
          el.querySelectorAll("img,iframe").forEach(node => {
            if (!node.hasAttribute("loading")) node.setAttribute("loading", "lazy");
          });

          el.querySelectorAll("video").forEach(node => {
            if (!node.hasAttribute("preload")) node.setAttribute("preload", "metadata");
          });
        }
      });
    } finally {
      applying = false;
    }
  };

  const schedule = () => {
    clearTimeout(timer);

    if (scrolling) {
      timer = setTimeout(schedule, SCROLL_PAUSE);
      return;
    }

    timer = setTimeout(() => {
      if ("requestIdleCallback" in window) {
        requestIdleCallback(apply, { timeout: 1200 });
      } else {
        requestAnimationFrame(apply);
      }
    }, generating() ? GENERATING_DELAY : APPLY_DELAY);
  };

  // Narrow the MutationObserver to the conversation root instead of
  // document.body, so mutations in the sidebar/header/etc during streaming
  // don't trigger irrelevant callback churn. Re-attaches if root() changes
  // (e.g. after client-side navigation swaps out <main>).
  const watchRoot = () => {
    const r = root();
    if (r === observedRoot) return;

    observedRoot = r;
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      if (!applying) schedule();
    });

    observer.observe(r, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-testid", "data-message-author-role", "data-turn", "aria-busy"]
    });
  };

  window.addEventListener("scroll", () => {
    scrolling = true;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrolling = false;
      schedule();
    }, SCROLL_PAUSE);
  }, { passive: true });

  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    schedule();
  }, 1000);

  style();
  watchRoot();
  setTimeout(schedule, 500);
})();
