# Copy Code — Thymer plugin

A Thymer Global (App) plugin that adds **copy affordances** to the document editor:

- **Code blocks** — a "Copy" button on hover that copies the whole block.
- **Inline code** — a small floating copy icon on hover that copies that span.

## Install / update

This is a single-file plugin — no build step. In Thymer → your plugin → **Edit Code**:

1. Paste the contents of [`plugin.js`](./plugin.js) into the **Custom Code** tab.
2. Paste the contents of [`plugin.json`](./plugin.json) into the **Configuration** tab.

`plugin.js` uses `class Plugin` (no `export`), because the Custom Code field
evaluates plain script — `export`/`import` would throw `unexpected token 'export'`.

> Want live reload instead of copy-paste? The official
> [Thymer Plugin SDK](https://github.com/thymerapp/thymer-plugin-sdk) provides an
> esbuild + hot-reload setup (it expects `export class Plugin`). See CLAUDE.md.

## How it works

Thymer has no API to render UI on a specific line item inside a document, so this
plugin injects into the editor DOM (the supported way — same technique as the SDK's
`robot-cursor` example): code blocks (`.block-codelang`) get a button injected into
the container; inline code (`.lineitem-code`) shares one floating button positioned
on hover. These editor classes are undocumented and may change between Thymer builds
— if the buttons stop appearing, update `CODE_BLOCK_SELECTOR` / `INLINE_CODE_SELECTOR`
in [`plugin.js`](./plugin.js). See *The code-block DOM* in [CLAUDE.md](./CLAUDE.md).

## Layout

| File | Purpose |
|------|---------|
| `plugin.js` | The plugin — paste into Custom Code (`class Plugin extends AppPlugin`) |
| `plugin.json` | Manifest — paste into Configuration (name, icon, description) |
| `types.d.ts` | Full Thymer plugin API (reference + editor autocomplete) |
| `jsconfig.json` | Type-checks `plugin.js` against `types.d.ts` in your editor |
