// ==UserScript==
// @name         Instagram
// @namespace    https://www.instagram.com/
// @version      1
// @description  instagram
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const PAUSE_VERTICAL_ZONE = 0.8;
    const EMOJI_FONT = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Twemoji Mozilla", sans-serif';
    const processedEmoji = new WeakSet();

    function getEmojiFromImage(img) {
        if (!(img instanceof HTMLImageElement)) return null;

        const src = img.currentSrc || img.src || '';
        if (!/emoji/i.test(src)) return null;

        const match = src.match(/\/([0-9a-f]+(?:-[0-9a-f]+)*)\.png(?:[?#].*)?$/i);
        if (!match) return null;

        try {
            const codePoints = match[1].split('-').map(hex => parseInt(hex, 16));
            if (!codePoints.length || codePoints.some(cp => !Number.isFinite(cp))) return null;
            return String.fromCodePoint(...codePoints);
        } catch {
            return null;
        }
    }

    function replaceEmojiImage(img) {
        if (!(img instanceof HTMLImageElement)) return;
        if (processedEmoji.has(img)) return;

        processedEmoji.add(img);

        const emoji = getEmojiFromImage(img);
        if (!emoji) return;

        const width = img.width || parseFloat(img.getAttribute('width')) || 16;
        const height = img.height || parseFloat(img.getAttribute('height')) || width;

        const span = document.createElement('span');

        span.textContent = emoji;
        span.dataset.igNativeEmoji = '1';
        span.style.cssText = `
            display:inline-block !important;
            width:${width}px !important;
            height:${height}px !important;
            line-height:${height}px !important;
            font-family:${EMOJI_FONT} !important;
            font-size:${height}px !important;
            font-variant-emoji:emoji !important;
            vertical-align:-0.15em !important;
            text-align:center !important;
            white-space:nowrap !important;
        `;

        img.replaceWith(span);
    }

    function processEmojiNode(node) {
        if (!(node instanceof Element)) return;

        if (node instanceof HTMLImageElement) {
            replaceEmojiImage(node);
            return;
        }

        if (!node.querySelectorAll) return;

        for (const img of node.querySelectorAll('img')) {
            replaceEmojiImage(img);
        }
    }

    let emojiQueue = new Set();
    let emojiJobScheduled = false;

    function processEmojiQueue() {
        emojiJobScheduled = false;
        if (!emojiQueue.size) return;

        const queue = emojiQueue;
        emojiQueue = new Set();

        for (const node of queue) {
            processEmojiNode(node);
        }
    }

    function scheduleEmojiWork() {
        if (emojiJobScheduled) return;

        emojiJobScheduled = true;

        if ('requestIdleCallback' in window) {
            requestIdleCallback(processEmojiQueue, { timeout: 500 });
        } else {
            setTimeout(processEmojiQueue, 50);
        }
    }

    function startEmojiSystem() {
        if (!document.body) {
            requestAnimationFrame(startEmojiSystem);
            return;
        }

        for (const img of document.body.querySelectorAll('img')) {
            replaceEmojiImage(img);
        }

        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node instanceof Element) {
                        emojiQueue.add(node);
                    }
                }
            }

            scheduleEmojiWork();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function isHomeFeed() {
        return location.pathname === '/' || location.pathname === '';
    }

    function findVideoAtPoint(x, y) {
        const element = document.elementFromPoint(x, y);
        if (!element) return null;

        if (element instanceof HTMLVideoElement) {
            return element;
        }

        const directVideo = element.closest?.('video');
        if (directVideo instanceof HTMLVideoElement) {
            return directVideo;
        }

        let current = element;

        while (current && current !== document.body) {
            if (current instanceof Element) {
                const video = current.querySelector?.('video');

                if (video instanceof HTMLVideoElement) {
                    const rect = video.getBoundingClientRect();

                    if (
                        x >= rect.left &&
                        x <= rect.right &&
                        y >= rect.top &&
                        y <= rect.bottom
                    ) {
                        return video;
                    }
                }
            }

            current = current.parentElement;
        }

        for (const video of document.querySelectorAll('video')) {
            const rect = video.getBoundingClientRect();

            if (
                rect.width > 0 &&
                rect.height > 0 &&
                x >= rect.left &&
                x <= rect.right &&
                y >= rect.top &&
                y <= rect.bottom
            ) {
                return video;
            }
        }

        return null;
    }

    function isInsidePauseZone(video, x, y) {
        const rect = video.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const zoneHeight = rect.height * PAUSE_VERTICAL_ZONE;
        const top = rect.top + (rect.height - zoneHeight) / 2;
        const bottom = top + zoneHeight;

        return (
            x >= rect.left &&
            x <= rect.right &&
            y >= top &&
            y <= bottom
        );
    }

    let pendingClick = null;

    document.addEventListener('pointerdown', event => {
        if (!isHomeFeed()) return;

        if (
            event.pointerType === 'mouse' &&
            event.button !== 0
        ) {
            return;
        }

        const video = findVideoAtPoint(
            event.clientX,
            event.clientY
        );

        if (!video) return;

        if (
            !isInsidePauseZone(
                video,
                event.clientX,
                event.clientY
            )
        ) {
            return;
        }

        pendingClick = {
            video,
            x: event.clientX,
            y: event.clientY,
            time: performance.now()
        };

        if (video.paused) {
            video.play().catch(() => {});
        } else {
            video.pause();
        }

        event.preventDefault();
        event.stopPropagation();
    }, true);

    document.addEventListener('click', event => {
        if (!pendingClick) return;

        const state = pendingClick;
        pendingClick = null;

        if (performance.now() - state.time > 800) {
            return;
        }

        const dx = event.clientX - state.x;
        const dy = event.clientY - state.y;

        if (dx * dx + dy * dy > 144) {
            return;
        }

        if (
            !isInsidePauseZone(
                state.video,
                event.clientX,
                event.clientY
            )
        ) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
    }, true);

    document.addEventListener('pointercancel', () => {
        pendingClick = null;
    }, true);

    window.addEventListener('blur', () => {
        pendingClick = null;
    }, { passive: true });

    if (document.readyState === 'loading') {
        document.addEventListener(
            'DOMContentLoaded',
            startEmojiSystem,
            { once: true }
        );
    } else {
        startEmojiSystem();
    }
})();
