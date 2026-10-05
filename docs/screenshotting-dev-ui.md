# Screenshotting the dev UI (Playwright/Peekaboo)

Moved here from AGENTS.md to keep the auto loaded docs inside their budget (#2393, #3325).

Screenshots against `next dev` hang and time out: element shots wait forever on
CSS animations to "settle" (the `.pn-*` entrance/pulse keyframes never do), and
full-page shots stall on font loading. Before capturing, freeze motion by
injecting this style via `browser_evaluate`, then take the shot:

```js
const s = document.createElement('style');
s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';
document.head.appendChild(s);
```

A JPEG capture also succeeds where PNG times out. Save outside the repo root
(or delete after) so stray images aren't committed.
