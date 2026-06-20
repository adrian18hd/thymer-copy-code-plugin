# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **Thymer Global (App) plugin** called "Copy Code". It adds copy affordances in the document editor: a **Copy button on each code block** and a **floating copy icon for inline code** — each copies just that block/span to the clipboard.

Thymer (https://thymer.com) is a notebook/IDE-style app. Plugins are real JavaScript that run inside the app (desktop + browser), loaded into a workspace. Originally scaffolded from the official starter (https://github.com/thymerapp/thymer-plugin-sdk), then **flattened to a single no-build file** (see below).

## How it's built and installed

This is intentionally a **single-file, no-build plugin**. There is no `package.json`, `dev.js`, `dist/`, or `npm` step. To install/update:

1. Paste the whole of **`plugin.js`** into the plugin's **Edit Code → Custom Code** tab.
2. Paste **`plugin.json`** into the **Configuration** tab.

`jsconfig.json` + `types.d.ts` give the editor autocomplete and JSDoc/TS diagnostics for `plugin.js` (no compile step; IDE only). There is no test suite or linter.

**Why no build:** the SDK's esbuild/hot-reload loop exists to bundle multi-file projects, inline `import`ed assets, and push live over the Chrome DevTools Protocol — and it requires `export class Plugin`. This plugin is a single self-contained file with no imports/assets, so the build's only effect would be stripping `export`. We removed it to keep one canonical, paste-ready file. **If you later add multiple files or asset `import`s, re-introduce the SDK build** (`npm i` the SDK's deps, restore `dev.js`/`package.json`) — and switch back to `export class Plugin`, since the build needs it.

## Architecture

A plugin is **two files**:

- **`plugin.js`** — the code. Exactly one class `Plugin` (here `class Plugin extends AppPlugin`; `CollectionPlugin` is the other base, scoped to one collection/database).
- **`plugin.json`** — the manifest/config (`name`, `icon`, `description`, and for collection plugins the custom properties/views). Behavior for things declared here (formulas, render hooks) is implemented in `plugin.js` and **must reference fields by the exact same id/label** as the JSON.

**The `export`/`import` rule:** Thymer's Custom Code field evaluates **plain script**, so `export`/`import` throw `unexpected token 'export'`. This repo therefore uses bare `class Plugin` and no `import`s. (`export class Plugin` + `import` are only valid under the SDK build loop, which this repo no longer uses.)

**The API surface** lives entirely in `types.d.ts` (~4,800 lines of JSDoc — the source of truth; rely on it over guessing). On the plugin instance:
- `this.ui` (`UIAPI`) — toasters, command palette, status bar, sidebar items/widgets, panels, `injectCSS`, `createButton`/`createIcon`, `getActivePanel()`.
- `this.data` (`DataAPI`) — records, collections, search (`searchByQuery`), blobs.
- `this.events` (`EventsAPI`) — subscribe to `panel.navigated/focused`, `lineitem.created/updated/deleted/moved`, `reload`, etc.
- `this.ws` (`WebSocketAPI`) — real-time messaging.
- CollectionPlugin only: `this.collection`, `this.properties`, `this.views`.

**Document model:** a document is a `PluginRecord`; its content is a tree of `PluginLineItem`s (`record.getLineItems()`, `item.getChildren()`). Each line item has a `type` (`PluginLineItemType`: `text`, `task`, `heading`, `block`, `table`, …) and `segments` (`PluginLineItemSegment[]`, each with a `type` like `text`/`bold`/`code` and a `text` value). A **code block** is a line item (type `block`, optionally with `getHighlightLanguage()` set); its code may live in `segments` or across child line items.

### Lifecycle rules (important)

- **Never override the `constructor`.** Put init logic in `onLoad()`; clean up in `onUnload()`.
- Subscriptions/observers created in `onLoad()` should be torn down in `onUnload()` (Thymer re-instantiates the plugin when it reloads, e.g. on a config/code update), or you'll leak listeners and inject duplicate UI. This plugin removes its `MutationObserver`, document/scroll listeners, timer, and the floating button in `onUnload()`.

## This plugin's key constraint: copy UI requires DOM injection

Thymer has **no API to render UI on a specific line item inside a document**:
- Render hooks (`this.views.afterRenderBoardCard/...`, custom property render) exist **only for collection views** (board/gallery/table), not for document content.
- There is **no caret/selection/"current block" API**, so "copy the block at the cursor" isn't possible via API either.

So `plugin.js` uses the **DOM-injection** technique (same as the SDK's `robot-cursor` example): `ui.injectCSS()` for styling + DOM access. Two distinct patterns, because blocks and inline code have different constraints:

- **Code blocks** — a `MutationObserver` on `document.body` finds rendered code blocks and appends a `contenteditable="false"` "Copy" button (icon + label) **into** each block container. The editor is a managed contenteditable surface that re-renders on edits, so the scan re-runs (debounced to once per `requestAnimationFrame`) and `decorate()` is idempotent (skips blocks that already have a button).
- **Inline code** (`.lineitem-code`) — instead of injecting a button into every span (noisy, mutates contenteditable, scales badly), there is **one shared icon-only floating button** appended to `<body>`. Delegated `mouseover`/`mouseout` (capture phase) reveal it over the hovered span, positioned via `getBoundingClientRect()`. It copies `span.textContent`. A ~120ms hide delay lets the cursor travel from span to button; it hides on `scroll` (capture) since rects go stale. This **never mutates the editor's inline text**.

Both share `copyText()` (clipboard write + error toaster) and a transient `ti ti-copy` → `ti ti-check` state. All listeners/observers/timers/the floating button are torn down in `onUnload()`.

### The code-block DOM (observed)

Confirmed against the live app (classes are undocumented; re-verify if a build renames them):

```html
<!-- Code block WITH a language: -->
<div class="listitem listitem-block" data-guid="…">
  <div class="block-container-div container-border block-codelang block-lang-bash block-style-plain" ns-type="bash">
    <div class="listitem listitem-text" data-guid="…"><div class="line-div"><span class="lineitem-text">grep <span class="hljs-string">"Accepted"</span> /var/log/auth.log</span></div></div>
    <div class="listitem listitem-br"   data-guid="…">…blank line…</div>
    …
    <span class="block-nstype-button">bash</span>   <!-- language label / drag handle -->
  </div>
</div>

<!-- Code block with NO language: no `.block-codelang`, no `.block-lang-*`, ns-type="block" -->
<div class="listitem listitem-block" data-guid="…">
  <div class="block-container-div container-border block-style-plain" ns-type="block">
    <div class="listitem listitem-text" data-guid="…"><div class="line-div"><span class="lineitem-text">dotnet ef migrations add InitialCreate</span></div></div>
    <span class="block-nstype-button">block</span>
  </div>
</div>
```

- **`CODE_BLOCK_SELECTOR = '.listitem-block > .block-container-div'`** — the bordered inner container of a code block. We key off the **`.listitem-block` wrapper** (the dedicated code-block line-item type), **not `.block-codelang`**: a code block with no language set renders *without* `.block-codelang` (ns-type="block", `.block-style-plain`), so the old `.block-codelang` selector silently skipped those blocks (the "Copy button stopped showing" bug). Quote/note/warning blocks use other wrappers (e.g. `.listitem-quote`), so `.listitem-block` still excludes them.
- Each code line is a **direct-child `.listitem`**; `.listitem-br` is a blank line; text is in `.lineitem-text`. Syntax highlighting is nested `.hljs-*` spans, so `textContent` reconstructs the source. `readCodeText()` joins lines with `\n` and maps nbsp → space.
- **Language** (when set) is the container's `ns-type` attr (also `block-lang-<lang>` + `block-codelang`); a language-less block has `ns-type="block"` and none of those.
- **Inline code** is `INLINE_CODE_SELECTOR = '.lineitem-code'` (an inline span within regular text; not used for block lines, which are `.lineitem-text`). Backreference-footer inline code is a different class, `.tlr-seg-code` — not currently covered.

To re-inspect after a Thymer update: in the debug Chrome console, select a code block in Elements and check `$0.closest('.listitem-block')` and the inner `.block-container-div` (plus its `ns-type`).

**Alternative (more robust against highlight quirks):** the outer `.listitem-block` and each line carry `data-guid`. You could map those back to `PluginLineItem`s via `record.getLineItems()` and read text through the API instead of scraping the DOM. There is also a dedicated `.listview-overlaybuttons` layer if you prefer overlaying buttons outside the contenteditable flow.

## Gotchas

- Plugin code is stored in workspace data — keep it small (a few MB). Host large assets/deps externally and `fetch` them (don't add `import`s without re-introducing the build; see "Why no build").
- The Thymer plugin API is **beta**; breaking changes are expected. When something doesn't match, re-check `types.d.ts`.
- `.cursor/rules/plugin-rule.mdc` holds lifecycle/`export` guidance for Cursor users — note its generic "single export" wording reflects the SDK build; this repo pastes `plugin.js` directly, so it uses bare `class Plugin` (no `export`).
