/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/editorFrame.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { Orientation, Sash, SashState } from '../../../../base/browser/ui/sash/sash.js';
import { ToolBar } from '../../../../base/browser/ui/toolbar/toolbar.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { appendPropertyHeading, appendPropertyNote, appendPropertyRow, IMAEnginePropertiesDockService } from './propertiesDock.js';

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * MAENGINE SHARED EDITOR FRAME API
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * A reusable frame layout used across all MAEngine workbench editors (CAD, Mesh,
 * Physics, Solver, Results, Marketplace, etc.).
 *
 * STRUCTURE:
 * ┌─ Toolbar row ─────────────────────────────────────────────────────────────┐
 * │ [Title / Segmented switch] [Inline controls] ... [End slot] [Actions] [...]│
 * ├─ Main Content Area ───────────────────────────────────────────────────────┤
 * │ [Editor Canvas / Grid]      (covers content when empty: [Empty state card])│
 * ├─ Status / Hint Strip ────────────────────────────────────────────────────┤
 * │ (i) "Not built yet: mesh generation needed"           [Action: Run Mesher] │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * USAGE EXAMPLE:
 * ```typescript
 * this.frame = this._register(this.instantiationService.createInstance(EditorFrame, parent, {
 *     id: 'maengine.cadEditor',
 *     ariaLabel: localize('cadEditor', "CAD Geometry"),
 *     properties: { title: localize('properties', "Properties") }
 * }));
 * this.frame.setTitle("02 Geometry");
 * const viewSwitcher = this.frame.createSegmented(this.frame.controlsSlot, [
 *     { id: '3d', label: '3D View', icon: Codicon.cube },
 *     { id: 'sketch', label: 'Sketch', icon: Codicon.edit }
 * ], '3d', mode => this.switchView(mode));
 * this.frame.setActions([importCadAction, this.frame.togglePropertiesAction]);
 * this.frame.setStatus({ text: "Model ready for meshing", link: { label: "Run Mesh", run: () => runMesh() } });
 * this.frame.setEmpty({ title: "No CAD Model", text: "Import a STEP file or pick an example.", actions: [...] });
 * this.frame.layout(dimension.width, dimension.height);
 * ```
 */

/** Options for the properties panel on the right of the frame or docked into auxiliary sidebar. */
export interface IEditorFramePropertiesOptions {
	/** Title of the properties sheet, e.g. "Properties". */
	readonly title: string;
	/** Whether the panel defaults to visible on first open (default: true). */
	readonly defaultVisible?: boolean;
	/** Width in pixels on initial open (default: 280). */
	readonly defaultWidth?: number;
	readonly minWidth?: number;
	readonly maxWidth?: number;
}

/** Options for initializing an EditorFrame instance. */
export interface IEditorFrameOptions {
	/** Unique editor identifier for persisting frame layout state. */
	readonly id: string;
	/** Accessible ARIA label for toolbar. */
	readonly ariaLabel: string;
	/** Optional properties panel configuration. */
	readonly properties?: IEditorFramePropertiesOptions;
}

/** Configuration for the bottom status/hint strip. */
export interface IEditorFrameStatus {
	/** Status text, or structured array of text and inline HTML elements. */
	readonly text: string | readonly (string | HTMLElement)[];
	/** Visual indicator level. */
	readonly severity?: 'info' | 'warning' | 'error';
	/** Leading icon; spins when busy=true. */
	readonly icon?: ThemeIcon;
	readonly busy?: boolean;
	/** Optional trailing clickable action link (e.g. "Build", "Retry"). */
	readonly link?: { readonly label: string; readonly run: () => void };
}

/** A button in the calm empty-state card. */
export interface IEditorFrameEmptyAction {
	readonly label: string;
	readonly icon?: ThemeIcon;
	/** When true, styled as a primary action button; otherwise secondary. */
	readonly primary?: boolean;
	readonly enabled?: boolean;
	readonly run: () => void;
}

/** Definition for the calm empty-state card displayed over the main area. */
export interface IEditorFrameEmptyState {
	readonly icon?: ThemeIcon;
	readonly title: string;
	readonly text?: string;
	readonly actions?: readonly IEditorFrameEmptyAction[];
	readonly link?: { readonly label: string; readonly run: () => void };
}

/** An icon button for inline controls in the toolbar. */
export interface IEditorFrameIconButton extends IDisposable {
	readonly element: HTMLButtonElement;
	setIcon(icon: ThemeIcon): void;
	setTitle(title: string): void;
}

/** Segment definition for segmented view switchers. */
export interface ISegmentedOption<T extends string = string> {
	readonly id: T;
	readonly label: string;
	readonly icon?: ThemeIcon;
}

/** Control handle for a segmented switcher. */
export interface ISegmentedControl<T extends string = string> extends IDisposable {
	readonly element: HTMLElement;
	getValue(): T;
	setValue(value: T): void;
	setEnabled(value: T, enabled: boolean): void;
}

/** Persisted layout state of the properties panel. */
export interface IEditorFrameState {
	readonly visible: boolean;
	readonly width: number;
}

const DEFAULT_PANEL_WIDTH = 280;
const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 640;
const MIN_MAIN_WIDTH = 240;

export function clampPanelWidth(width: number, available: number, min = MIN_PANEL_WIDTH, max = MAX_PANEL_WIDTH): number {
	const upper = Math.max(min, Math.min(max, available - MIN_MAIN_WIDTH));
	return Math.round(Math.max(min, Math.min(upper, Number.isFinite(width) ? width : min)));
}

export function readFrameState(raw: string | undefined, defaults: IEditorFrameState): IEditorFrameState {
	try {
		const value = raw ? JSON.parse(raw) : undefined;
		return {
			visible: typeof value?.visible === 'boolean' ? value.visible : defaults.visible,
			width: typeof value?.width === 'number' && Number.isFinite(value.width) ? value.width : defaults.width,
		};
	} catch {
		return defaults;
	}
}

export { appendPropertyHeading, appendPropertyRow, appendPropertyNote };

export function appliesOnLeave(text: string, applied: string): boolean {
	return text.trim() !== applied.trim();
}

/** Commits input value on Enter or blur when modified. */
export function applyPropertyOnCommit(input: HTMLInputElement, apply: (text: string) => void): IDisposable {
	const store = new DisposableStore();
	let applied = input.value;
	const commit = () => {
		applied = input.value;
		apply(input.value);
	};
	store.add(addDisposableListener(input, EventType.KEY_DOWN, e => {
		if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			commit();
		}
	}));
	store.add(addDisposableListener(input, EventType.BLUR, () => {
		if (input.isConnected && appliesOnLeave(input.value, applied)) {
			commit();
		}
	}));
	return store;
}

/**
 * Main reusable frame component for MAEngine editors.
 */
export class EditorFrame extends Disposable {

	readonly element: HTMLElement;
	/** Left slot of toolbar: title or primary segmented view switcher. */
	readonly titleSlot: HTMLElement;
	/** Inline controls slot: small buttons, zoom pickers, toggles. */
	readonly controlsSlot: HTMLElement;
	/** End slot before action buttons: status pill ("Out of date", "Stale"). */
	readonly endSlot: HTMLElement;
	/** Content area: flex column holding the editor's canvas, viewport or table. */
	readonly main: HTMLElement;
	/** Content container for properties sheet; undefined if frame has no properties configured. */
	readonly properties: HTMLElement | undefined;
	/** Action that toggles properties visibility (dock or side-panel). */
	readonly togglePropertiesAction: Action;

	private readonly toolbar: ToolBar;
	private readonly progress: ProgressBar;
	private readonly body: HTMLElement;
	private readonly panel: HTMLElement | undefined;
	private readonly sash: Sash | undefined;
	private readonly status: HTMLElement;
	private readonly statusStore = this._register(new DisposableStore());
	private readonly helpSlot: HTMLElement;
	private readonly helpStore = this._register(new DisposableStore());
	private readonly emptyElement: HTMLElement;
	private readonly emptyStore = this._register(new DisposableStore());
	private readonly storageKey: string;
	private state: IEditorFrameState;
	private dockHost: HTMLElement | undefined;
	private width = 0;
	private height = 0;

	private readonly _onDidLayoutMain = this._register(new Emitter<void>());
	/** Fired when main canvas area changes size (frame resized, panel toggled). */
	readonly onDidLayoutMain: Event<void> = this._onDidLayoutMain.event;

	constructor(
		container: HTMLElement,
		private readonly options: IEditorFrameOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IStorageService private readonly storageService: IStorageService,
		@IHoverService private readonly hoverService: IHoverService,
		@IMAEnginePropertiesDockService private readonly dockService: IMAEnginePropertiesDockService,
	) {
		super();
		this.storageKey = `maengine.editorFrame.${options.id}`;
		const panelOptions = options.properties;
		this.state = readFrameState(this.storageService.get(this.storageKey, StorageScope.PROFILE), {
			visible: panelOptions?.defaultVisible ?? true,
			width: panelOptions?.defaultWidth ?? DEFAULT_PANEL_WIDTH,
		});

		this.element = append(container, $('.maengine-editor-frame'));

		const bar = append(this.element, $('.ma-frame-toolbar', { role: 'toolbar', 'aria-label': options.ariaLabel }));
		this.titleSlot = append(bar, $('.ma-frame-title'));
		this.helpSlot = append(bar, $('.ma-frame-help'));
		this.controlsSlot = append(bar, $('.ma-frame-controls'));
		append(bar, $('.ma-frame-spacer'));
		this.endSlot = append(bar, $('.ma-frame-end'));

		this.toolbar = this._register(new ToolBar(append(bar, $('.ma-frame-actions')), contextMenuService, {
			orientation: ActionsOrientation.HORIZONTAL,
			ariaLabel: options.ariaLabel,
			toggleMenuTitle: localize('editorFrame.more', "More Actions..."),
			highlightToggledItems: true,
		}));

		this.progress = this._register(new ProgressBar(bar, defaultProgressBarStyles));
		this.progress.getContainer().classList.add('ma-frame-progress');

		this.body = append(this.element, $('.ma-frame-body'));
		this.main = append(this.body, $('.ma-frame-main'));
		this.emptyElement = append(this.main, $('.ma-frame-empty'));

		this.togglePropertiesAction = this._register(new Action(
			'maengine.editorFrame.toggleProperties',
			panelOptions ? localize('editorFrame.toggleProperties', "Toggle {0}", panelOptions.title) : '',
			ThemeIcon.asClassName(Codicon.layoutSidebarRightOff),
			!!panelOptions,
			async () => this.toggleProperties()
		));

		if (panelOptions) {
			this.panel = append(this.body, $('.ma-frame-panel'));
			const header = append(this.panel, $('.ma-frame-panel-header'));
			append(header, $('span.ma-frame-panel-title', undefined, panelOptions.title));
			const hideLabel = localize('editorFrame.hideProperties', "Hide {0}", panelOptions.title);
			const close = append(header, $<HTMLButtonElement>('button.ma-frame-panel-close', { type: 'button', 'aria-label': hideLabel }));
			this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), close, hideLabel));
			append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
			this._register(addDisposableListener(close, EventType.CLICK, () => this.setPropertiesVisible(false)));
			this.properties = append(this.panel, $('.ma-frame-panel-content'));

			const sash = this.sash = this._register(new Sash(this.body, { getVerticalSashLeft: () => this.mainWidth() }, { orientation: Orientation.VERTICAL }));
			let start = 0;
			this._register(sash.onDidStart(() => start = this.state.width));
			this._register(sash.onDidChange(e => this.resizePanel(start + e.startX - e.currentX, false)));
			this._register(sash.onDidEnd(() => this.save()));
			this._register(sash.onDidReset(() => this.resizePanel(panelOptions.defaultWidth ?? DEFAULT_PANEL_WIDTH, true)));

			const content = this.properties;
			this._register(this.dockService.registerFrame({ element: this.element, dock: host => this.setDockHost(host) }));
			this._register(toDisposable(() => {
				if (this.dockHost) {
					content.remove();
				}
			}));
			this._register(this.dockService.onDidChangeEnabled(() => this.applyPanel()));
		}

		this.status = append(this.element, $('.ma-frame-status', { role: 'status', 'aria-live': 'polite' }));
		this.applyPanel();
		this.setHelp(undefined);
	}

	/**
	 * Creates a segmented switch control (e.g. Plan | 3D | Analysis) in the specified container.
	 */
	createSegmented<T extends string>(
		container: HTMLElement,
		segments: readonly ISegmentedOption<T>[],
		initial: T,
		onSelect: (id: T) => void
	): ISegmentedControl<T> {
		const store = new DisposableStore();
		const element = append(container, $('.ma-segmented', { role: 'radiogroup', 'aria-label': this.options.ariaLabel }));
		const buttons = new Map<T, HTMLButtonElement>();
		let current = initial;

		const update = (selected: T) => {
			current = selected;
			for (const [id, btn] of buttons) {
				const active = id === selected;
				btn.classList.toggle('active', active);
				btn.setAttribute('aria-checked', String(active));
				btn.tabIndex = active ? 0 : -1;
			}
		};

		for (const seg of segments) {
			const btn = append(element, $<HTMLButtonElement>('button.ma-segment', {
				type: 'button',
				role: 'radio',
				'aria-label': seg.label,
			}));
			if (seg.icon) {
				append(btn, $(ThemeIcon.asCSSSelector(seg.icon)));
			}
			append(btn, $('span', undefined, seg.label));
			buttons.set(seg.id, btn);

			store.add(addDisposableListener(btn, EventType.CLICK, () => {
				if (current !== seg.id) {
					update(seg.id);
					onSelect(seg.id);
				}
			}));
		}

		update(initial);

		return {
			element,
			getValue: () => current,
			setValue: next => update(next),
			setEnabled: (id, enabled) => {
				const btn = buttons.get(id);
				if (btn) {
					btn.disabled = !enabled;
				}
			},
			dispose: () => {
				store.dispose();
				element.remove();
			}
		};
	}

	/** Small toolbar icon button for inline controls (+ / - / view resets). */
	createIconButton(container: HTMLElement, icon: ThemeIcon, title: string, run: () => void): IEditorFrameIconButton {
		const store = new DisposableStore();
		const element = append(container, $<HTMLButtonElement>('button.ma-frame-icon-button', { type: 'button', 'aria-label': title }));
		const glyph = append(element, $(ThemeIcon.asCSSSelector(icon)));
		const hover = store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), element, title));
		store.add(addDisposableListener(element, EventType.CLICK, () => run()));
		return {
			element,
			setIcon: next => glyph.className = ThemeIcon.asClassName(next),
			setTitle: next => {
				element.setAttribute('aria-label', next);
				hover.update(next);
			},
			dispose: () => store.dispose(),
		};
	}

	/** Status pill in the toolbar ("Out of date", "Stale"). */
	createPill(text: string, options: { readonly severity?: 'warn' | 'fail'; readonly icon?: ThemeIcon; readonly title?: string; readonly run?: () => void }): IDisposable {
		const store = new DisposableStore();
		const pill = append(this.endSlot, $<HTMLElement>(options.run ? 'button.ma-frame-pill' : 'span.ma-frame-pill'));
		if (options.severity) {
			pill.classList.add(options.severity);
		}
		if (options.icon) {
			append(pill, $(ThemeIcon.asCSSSelector(options.icon)));
		}
		append(pill, $('span', undefined, text));
		if (options.title) {
			store.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), pill, options.title));
		}
		const run = options.run;
		if (run) {
			store.add(addDisposableListener(pill, EventType.CLICK, () => run()));
		}
		store.add(toDisposable(() => pill.remove()));
		return store;
	}

	/** Configures primary icon actions and overflow menu actions. */
	setActions(primary: readonly IAction[], secondary: readonly IAction[] = []): void {
		this.toolbar.setActions(primary, secondary);
	}

	/** Sets plain title text in the title slot. */
	setTitle(title: string): void {
		clearNode(this.titleSlot);
		append(this.titleSlot, $('span.ma-frame-title-text', undefined, title));
	}

	/** Updates the bottom status/hint strip. Pass undefined to clear. */
	setStatus(status: IEditorFrameStatus | undefined): void {
		this.statusStore.clear();
		clearNode(this.status);
		this.status.className = `ma-frame-status${status?.severity ? ` ${status.severity}` : ''}`;
		if (!status) {
			return;
		}
		const icon = status.busy ? ThemeIcon.modify(Codicon.loading, 'spin') : status.icon
			?? (status.severity === 'error' ? Codicon.error : status.severity === 'warning' ? Codicon.warning : undefined);
		if (icon) {
			append(this.status, $(`span.ma-frame-status-icon${ThemeIcon.asCSSSelector(icon)}`));
		}
		const text = append(this.status, $('span.ma-frame-status-text'));
		for (const part of typeof status.text === 'string' ? [status.text] : status.text) {
			if (typeof part === 'string') {
				append(text, $('span', undefined, part));
			} else {
				append(text, part);
			}
		}
		const link = status.link;
		if (link) {
			const anchor = append(this.status, $<HTMLAnchorElement>('a.ma-frame-status-link', { role: 'button', tabIndex: 0 }, link.label));
			this.statusStore.add(addDisposableListener(anchor, EventType.CLICK, () => link.run()));
			this.statusStore.add(addDisposableListener(anchor, EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					link.run();
				}
			}));
		}
	}

	/** Optional help button in toolbar. */
	setHelp(text: string | undefined): void {
		this.helpStore.clear();
		clearNode(this.helpSlot);
		if (!text) {
			return;
		}
		const label = localize('editorFrame.help', "About This Editor");
		const button = append(this.helpSlot, $<HTMLButtonElement>('button.ma-frame-icon-button.ma-frame-help-button', { type: 'button', 'aria-label': label }));
		append(button, $(ThemeIcon.asCSSSelector(Codicon.question)));
		const content = new MarkdownString();
		content.appendText(text);
		this.helpStore.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, { markdown: content, markdownNotSupportedFallback: text }));
	}

	/** Calm empty-state card displayed over the main canvas area. */
	setEmpty(state: IEditorFrameEmptyState | undefined): void {
		this.emptyStore.clear();
		clearNode(this.emptyElement);
		this.main.appendChild(this.emptyElement);
		this.emptyElement.classList.toggle('visible', !!state);
		if (!state) {
			return;
		}
		const content = append(this.emptyElement, $('.ma-frame-empty-content'));
		if (state.icon) {
			append(content, $(`span.ma-frame-empty-icon${ThemeIcon.asCSSSelector(state.icon)}`));
		}
		append(content, $('.ma-frame-empty-title', undefined, state.title));
		if (state.text) {
			append(content, $('.ma-frame-empty-text', undefined, state.text));
		}
		if (state.actions?.length) {
			const actions = append(content, $('.ma-frame-empty-actions'));
			for (const action of state.actions) {
				const button = this.emptyStore.add(new Button(actions, { ...defaultButtonStyles, secondary: !action.primary, supportIcons: true }));
				button.label = action.icon ? `$(${action.icon.id}) ${action.label}` : action.label;
				button.enabled = action.enabled ?? true;
				this.emptyStore.add(button.onDidClick(() => action.run()));
			}
		}
		const link = state.link;
		if (link) {
			const anchor = append(content, $<HTMLAnchorElement>('a.ma-frame-empty-link', { role: 'button', tabIndex: 0 }, link.label));
			this.emptyStore.add(addDisposableListener(anchor, EventType.CLICK, () => link.run()));
			this.emptyStore.add(addDisposableListener(anchor, EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					link.run();
				}
			}));
		}
	}

	showProgress(fraction?: number): void {
		if (fraction === undefined) {
			this.progress.infinite().show();
		} else {
			this.progress.total(1000).setWorked(Math.round(Math.max(0, Math.min(1, fraction)) * 1000)).show();
		}
	}

	hideProgress(): void {
		this.progress.stop().hide();
	}

	get isPropertiesVisible(): boolean {
		if (!this.panel) {
			return false;
		}
		return !!this.dockHost || this.showsOwnColumn;
	}

	setPropertiesVisible(visible: boolean): void {
		if (!this.panel) {
			return;
		}
		if (this.dockService.enabled) {
			if (visible) {
				void this.dockService.reveal();
			}
			return;
		}
		if (visible === this.state.visible) {
			return;
		}
		this.state = { ...this.state, visible };
		this.applyPanel();
		this.save();
	}

	private toggleProperties(): void {
		if (!this.panel) {
			return;
		}
		if (this.dockService.enabled) {
			if (this.dockHost) {
				this.dockService.hide();
			} else {
				void this.dockService.reveal();
			}
			return;
		}
		this.setPropertiesVisible(!this.state.visible);
	}

	private setDockHost(host: HTMLElement | undefined): void {
		const content = this.properties;
		if (!this.panel || !content || host === this.dockHost) {
			return;
		}
		this.dockHost = host;
		if (host) {
			host.appendChild(content);
		} else {
			this.panel.appendChild(content);
		}
		this.applyPanel();
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		this.applyPanel();
	}

	private get showsOwnColumn(): boolean {
		return !!this.panel && !this.dockHost && !this.dockService.enabled && this.state.visible;
	}

	private mainWidth(): number {
		return this.showsOwnColumn ? Math.max(0, this.width - this.panelWidth()) : this.width;
	}

	private panelWidth(): number {
		const options = this.options.properties;
		return this.width ? clampPanelWidth(this.state.width, this.width, options?.minWidth, options?.maxWidth) : this.state.width;
	}

	private resizePanel(width: number, save: boolean): void {
		const options = this.options.properties;
		this.state = { ...this.state, width: clampPanelWidth(width, this.width, options?.minWidth, options?.maxWidth) };
		this.applyPanel();
		if (save) {
			this.save();
		}
	}

	private applyPanel(): void {
		this.togglePropertiesAction.checked = this.isPropertiesVisible;
		const visible = this.showsOwnColumn;
		if (this.panel) {
			this.panel.classList.toggle('hidden', !visible);
			this.panel.style.width = `${this.panelWidth()}px`;
		}
		if (this.sash) {
			this.sash.state = visible ? SashState.Enabled : SashState.Disabled;
			this.sash.layout();
		}
		if (this.width && this.height) {
			this._onDidLayoutMain.fire();
		}
	}

	private save(): void {
		this.storageService.store(this.storageKey, JSON.stringify(this.state), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}
