/**
 * Copy Code — a Thymer Global (App) plugin.
 *
 * Adds copy affordances to the document editor:
 *   - Code blocks: a "Copy" button (on hover) that copies the whole block.
 *   - Inline code (`.lineitem-code` spans): a small floating copy icon on hover
 *     that copies just that span.
 *
 * Why DOM injection? Thymer has no API to render a button on a specific line item
 * inside a document — render hooks only exist for collection views (board/gallery/
 * table cards), and there is no caret/selection API. So, like the official
 * robot-cursor example, we injectCSS() + watch the editor DOM with a
 * MutationObserver and add our own UI.
 *
 * Block buttons are injected into the block container. Inline code uses ONE shared
 * floating button positioned over the hovered span — this avoids mutating the
 * (contenteditable) inline text and scales to many spans per document.
 *
 * Install: copy this whole file into Thymer -> your plugin -> Edit Code ->
 * Custom Code, and paste plugin.json into Configuration. The class is declared as
 * `class Plugin` (NOT `export class Plugin`): the Custom Code field evaluates plain
 * script, so `export`/`import` would throw "unexpected token 'export'".
 */

// ---------------------------------------------------------------------------
// Thymer editor DOM (observed; classes are undocumented and may change builds)
// ---------------------------------------------------------------------------
//   .listitem.listitem-block                       outer wrapper (has data-guid)
//     .block-container-div                          <- the code block (our target)
//          [ns-type="bash"] [.block-lang-bash]     language (only when one is set)
//          [.block-codelang]                        present ONLY when a language is set
//       .listitem.listitem-text > .line-div > .lineitem-text   one code line
//       .listitem.listitem-br   ...                blank line
//       .block-nstype-button                       the little "bash"/"block" label/handle
//   .lineitem-code                                 <- inline code span
// We match the code block via its `.listitem-block` wrapper (the dedicated
// code-block line-item type), NOT `.block-codelang`: a code block with no
// language set renders WITHOUT `.block-codelang` (ns-type="block",
// .block-style-plain), so keying off the language class skipped those blocks.
// Quote/note/warning blocks use other wrappers (e.g. .listitem-quote), so this
// selector still excludes them. If a future build renames these, update this
// constant (see CLAUDE.md -> "The code-block DOM (observed)").
const CODE_BLOCK_SELECTOR = '.listitem-block > .block-container-div';
const INLINE_CODE_SELECTOR = '.lineitem-code';

const BTN_CLASS = 'copy-code-btn';
const INLINE_BTN_CLASS = 'copy-inline-code-btn';

class Plugin extends AppPlugin {
	/** @type {MutationObserver|null} */
	observer = null;
	/** @type {boolean} */
	scanQueued = false;

	// Inline copy: one shared floating button, repositioned over the hovered span.
	/** @type {HTMLButtonElement|null} */
	inlineBtn = null;
	/** @type {HTMLElement|null} */
	inlineIcon = null;
	/** @type {HTMLElement|null} */
	inlineTarget = null;
	/** @type {number} */
	inlineHideTimer = 0;

	onLoad() {
		this.ui.injectCSS(`
			${CODE_BLOCK_SELECTOR} { position: relative; }
			.${BTN_CLASS} {
				position: absolute;
				top: 20px;
				right: 10px;
				display: inline-flex;
				align-items: center;
				gap: 4px;
				padding: 2px 8px;
				font-size: 11px;
				font-family: var(--ed-variable-width-font, system-ui, sans-serif);
				line-height: 1.6;
				border-radius: 6px;
				border: 1px solid var(--ed-container-border-color, rgba(127,127,127,0.35));
				background: var(--cards-bg, rgba(127,127,127,0.12));
				color: var(--text-muted, inherit);
				cursor: pointer;
				opacity: 0;
				transition: opacity 0.12s ease;
				user-select: none;
				z-index: 6;
			}
			${CODE_BLOCK_SELECTOR}:hover .${BTN_CLASS} { opacity: 0.85; }
			.${BTN_CLASS}:hover { opacity: 1; background: var(--cards-hover-bg, var(--bg-hover, rgba(127,127,127,0.2))); }
			.${BTN_CLASS}.copied { color: var(--text-status-online, #2e9e54); border-color: currentColor; }

			.${INLINE_BTN_CLASS} {
				position: fixed;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				width: 20px;
				height: 20px;
				padding: 0;
				border-radius: 5px;
				border: 1px solid var(--ed-container-border-color, rgba(127,127,127,0.35));
				background: var(--cards-bg, rgba(127,127,127,0.12));
				color: var(--text-muted, inherit);
				font-size: 12px;
				cursor: pointer;
				opacity: 0;
				pointer-events: none;
				transition: opacity 0.1s ease;
				user-select: none;
				z-index: 9999;
			}
			.${INLINE_BTN_CLASS}.visible { opacity: 0.9; pointer-events: auto; }
			.${INLINE_BTN_CLASS}:hover { opacity: 1; background: var(--cards-hover-bg, var(--bg-hover, rgba(127,127,127,0.2))); }
			.${INLINE_BTN_CLASS}.copied { color: var(--text-status-online, #2e9e54); border-color: currentColor; }
		`);

		// --- Code blocks: decorate now, and keep up with re-renders. The editor
		// lives in a contenteditable surface that re-renders on edits, so we
		// re-scan (debounced to once per frame) rather than a one-time pass.
		this.scanAll();
		this.observer = new MutationObserver(() => this.scheduleScan());
		this.observer.observe(document.body, { childList: true, subtree: true });

		// --- Inline code: one shared floating button.
		this.buildInlineButton();
		this.onOver = (ev) => this.handleOver(ev);
		this.onOut = (ev) => this.handleOut(ev);
		this.onScroll = () => this.hideInline();
		document.addEventListener('mouseover', this.onOver, true);
		document.addEventListener('mouseout', this.onOut, true);
		// Bounding rects go stale on scroll; just hide while scrolling.
		window.addEventListener('scroll', this.onScroll, true);
	}

	onUnload() {
		if (this.observer) this.observer.disconnect();
		this.observer = null;
		document.querySelectorAll('.' + BTN_CLASS).forEach((b) => b.remove());

		document.removeEventListener('mouseover', this.onOver, true);
		document.removeEventListener('mouseout', this.onOut, true);
		window.removeEventListener('scroll', this.onScroll, true);
		clearTimeout(this.inlineHideTimer);
		if (this.inlineBtn) this.inlineBtn.remove();
		this.inlineBtn = this.inlineIcon = this.inlineTarget = null;
	}

	// ---- Code blocks --------------------------------------------------------

	scheduleScan() {
		if (this.scanQueued) return;
		this.scanQueued = true;
		requestAnimationFrame(() => {
			this.scanQueued = false;
			this.scanAll();
		});
	}

	scanAll() {
		document.querySelectorAll(CODE_BLOCK_SELECTOR).forEach((el) => this.decorate(/** @type {HTMLElement} */(el)));
	}

	/** Add a copy button to a code block, unless it already has one. @param {HTMLElement} container */
	decorate(container) {
		if (container.querySelector(':scope > .' + BTN_CLASS)) return;

		const btn = document.createElement('button');
		btn.className = BTN_CLASS;
		btn.type = 'button';
		btn.contentEditable = 'false'; // keep the editor from treating it as content
		btn.title = 'Copy this code block';

		// Tabler icon (ships with Thymer) + label.
		const icon = document.createElement('span');
		icon.className = 'ti ti-copy';
		const label = document.createElement('span');
		label.className = BTN_CLASS + '-label';
		label.textContent = 'Copy';
		btn.append(icon, label);

		// Don't let the editor place a caret / steal focus on press.
		btn.addEventListener('mousedown', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
		});
		btn.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			this.copyBlock(container, btn);
		});

		container.appendChild(btn);
	}

	/** @param {HTMLElement} container @param {HTMLButtonElement} btn */
	async copyBlock(container, btn) {
		const text = readCodeText(container);
		const icon = btn.querySelector('.ti');
		const label = btn.querySelector('.' + BTN_CLASS + '-label');
		await this.copyText(text, () => {
			if (icon) icon.className = 'ti ti-check';
			if (label) label.textContent = 'Copied';
			btn.classList.add('copied');
			setTimeout(() => {
				if (icon) icon.className = 'ti ti-copy';
				if (label) label.textContent = 'Copy';
				btn.classList.remove('copied');
			}, 1500);
		});
	}

	// ---- Inline code --------------------------------------------------------

	buildInlineButton() {
		const btn = document.createElement('button');
		btn.className = INLINE_BTN_CLASS;
		btn.type = 'button';
		btn.title = 'Copy inline code';
		const icon = document.createElement('span');
		icon.className = 'ti ti-copy';
		btn.appendChild(icon);

		btn.addEventListener('mousedown', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
		});
		btn.addEventListener('mouseenter', () => clearTimeout(this.inlineHideTimer));
		btn.addEventListener('mouseleave', () => this.scheduleHideInline());
		btn.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			this.copyInline();
		});

		document.body.appendChild(btn);
		this.inlineBtn = btn;
		this.inlineIcon = icon;
	}

	/** @param {MouseEvent} ev */
	handleOver(ev) {
		const t = /** @type {HTMLElement} */ (ev.target);
		const code = t && t.closest ? t.closest(INLINE_CODE_SELECTOR) : null;
		if (code) this.showInlineButton(/** @type {HTMLElement} */(code));
	}

	/** @param {MouseEvent} ev */
	handleOut(ev) {
		const t = /** @type {HTMLElement} */ (ev.target);
		const code = t && t.closest ? t.closest(INLINE_CODE_SELECTOR) : null;
		if (!code) return;
		// Moving onto the button keeps it open.
		const to = /** @type {Node} */ (ev.relatedTarget);
		if (to && this.inlineBtn && (to === this.inlineBtn || this.inlineBtn.contains(to))) return;
		this.scheduleHideInline();
	}

	/** @param {HTMLElement} span */
	showInlineButton(span) {
		clearTimeout(this.inlineHideTimer);
		if (this.inlineTarget === span) return; // already shown for this span
		this.inlineTarget = span;
		if (this.inlineIcon) this.inlineIcon.className = 'ti ti-copy';
		if (this.inlineBtn) this.inlineBtn.classList.remove('copied');

		const r = span.getBoundingClientRect();
		// Float at the top-right corner of the span (tweak to taste).
		if (this.inlineBtn) {
			this.inlineBtn.style.left = Math.round(r.right - 14) + 'px';
			this.inlineBtn.style.top = Math.round(r.top - 16) + 'px';
			this.inlineBtn.classList.add('visible');
		}
	}

	scheduleHideInline() {
		clearTimeout(this.inlineHideTimer);
		this.inlineHideTimer = setTimeout(() => this.hideInline(), 120);
	}

	hideInline() {
		if (this.inlineBtn) this.inlineBtn.classList.remove('visible');
		this.inlineTarget = null;
	}

	async copyInline() {
		if (!this.inlineTarget) return;
		const text = (this.inlineTarget.textContent || '').replace(/\u00a0/g, ' ');
		const icon = this.inlineIcon;
		const btn = this.inlineBtn;
		await this.copyText(text, () => {
			if (icon) icon.className = 'ti ti-check';
			if (btn) btn.classList.add('copied');
			setTimeout(() => {
				if (icon) icon.className = 'ti ti-copy';
				if (btn) btn.classList.remove('copied');
			}, 1500);
		});
	}

	// ---- Shared -------------------------------------------------------------

	/** @param {string} text @param {() => void} onOk */
	async copyText(text, onOk) {
		try {
			await navigator.clipboard.writeText(text);
			onOk();
		} catch (err) {
			this.ui.addToaster({
				title: 'Copy failed',
				message: String((err && err.message) || err),
				dismissible: true,
				autoDestroyTime: 3000,
			});
		}
	}
}

/**
 * Reconstruct a code block's source text from its rendered line items.
 * Each direct-child `.listitem` is one line; `.listitem-br` is a blank line.
 * `textContent` of `.lineitem-text` flattens the syntax-highlight spans back to
 * plain source. Our injected button is a <button> (not a `.listitem`), so it's
 * naturally excluded.
 *
 * @param {HTMLElement} container
 * @returns {string}
 */
function readCodeText(container) {
	const lines = [];
	container.querySelectorAll(':scope > .listitem').forEach((item) => {
		if (item.classList.contains('listitem-br')) {
			lines.push('');
			return;
		}
		const textEl = item.querySelector('.lineitem-text');
		const raw = textEl ? textEl.textContent : '';
		lines.push((raw || '').replace(/\u00a0/g, ' ')); // nbsp -> space
	});
	return lines.join('\n');
}
