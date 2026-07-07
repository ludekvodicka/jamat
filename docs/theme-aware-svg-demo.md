---
title: Theme-aware SVG — inline vs sidecar
subtitle: Why ![](x.svg) can't follow the theme, and how an inline ```svg fence does
status: demo
---

# Theme-aware SVG in mdext

The figure below is an **inline ` ```svg ` fence**. Its ink is `fill="currentColor"` (with `opacity`
for the muted shades and hairlines) — and because the fence renders **inline in the DOM**,
`currentColor` resolves to the viewer's theme text colour. Toggle Jamat light/dark and the ink,
outlines, and baseline follow; the brand series hues (same in both themes) stay put.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 210" width="640" height="210" font-family="system-ui, sans-serif" fill="currentColor">
  <text x="20" y="24" font-size="13" font-weight="700">Product health — theme-aware</text>

  <!-- KPI cards: bordered, transparent fill; ink = currentColor, muted = currentColor @ low opacity; delta hues fixed -->
  <rect x="20"  y="40" width="186" height="64" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.22"/>
  <text x="36" y="64"  font-size="11" opacity="0.6">Revenue</text>
  <text x="36" y="92"  font-size="21" font-weight="700" font-family="ui-monospace, monospace">$48.2k</text>
  <text x="150" y="64" fill="#1baf7a" font-size="11" font-weight="700">▲ 12%</text>

  <rect x="223" y="40" width="186" height="64" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.22"/>
  <text x="239" y="64"  font-size="11" opacity="0.6">Active users</text>
  <text x="239" y="92"  font-size="21" font-weight="700" font-family="ui-monospace, monospace">3,120</text>
  <text x="360" y="64" fill="#1baf7a" font-size="11" font-weight="700">▲ 4%</text>

  <rect x="426" y="40" width="186" height="64" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.22"/>
  <text x="442" y="64"  font-size="11" opacity="0.6">Open tickets</text>
  <text x="442" y="92"  font-size="21" font-weight="700" font-family="ui-monospace, monospace">18</text>
  <text x="556" y="64"  font-size="11" font-weight="700" opacity="0.6">▬ 0%</text>

  <!-- Mini trend: baseline currentColor @ low opacity (themes), two brand series fixed -->
  <rect x="20" y="120" width="592" height="76" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.22"/>
  <text x="36" y="140" font-size="11" opacity="0.6">Traffic · last 7 days</text>
  <line x1="36" y1="186" x2="596" y2="186" stroke="currentColor" stroke-opacity="0.22" stroke-width="1"/>
  <path d="M 40 180 L 132 172 L 224 175 L 316 160 L 408 152 L 500 158 L 592 146" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round"/>
  <path d="M 40 184 L 132 183 L 224 184 L 316 179 L 408 181 L 500 176 L 592 172" fill="none" stroke="#1baf7a" stroke-width="2" stroke-linejoin="round"/>
</svg>
```

The **ink** (`$48.2k`, labels), the **card outlines**, and the **baseline** are `currentColor` (some at
reduced `opacity`) → they recolour with the theme. **Visitors (blue)** and **Signups (aqua)** are
literal brand hex → identical in light and dark.

:::note[The catch — why the dashboard's sidecar SVGs stay white]
`![](assets/x.svg)` renders in an **isolated `<img>`**: host CSS variables and `currentColor` do **not**
reach inside it (they fall back to the baked value), and its own `@media (prefers-color-scheme)`
follows the **OS**, not Jamat's forced-dark class. So a light-baked sidecar is always a white slab on a
dark viewer. To be theme-reactive, a figure must be an **inline ` ```svg `** like this one — drive its
ink with **`fill="currentColor"`** (a plain, sanitizer-safe attribute; `+ opacity` for muted shades).
`var(--mdext-*)` via inline `style` also works but its CSS may be filtered — prefer `currentColor`.
Regenerate theme-sensitive figures as inline fences, not `.svg` files.
:::
