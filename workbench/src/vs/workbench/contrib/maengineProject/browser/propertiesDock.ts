/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/editorFrame.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IMAEngineProjectService } from '../../../services/maengineProject/common/maengineProject.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * MAENGINE PROPERTIES DOCK API & SERVICE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * The Properties dock renders in the Auxiliary (right) Sidebar. It provides a
 * unified inspection surface for whichever editor or entity is currently selected.
 *
 * Editors can feed properties in two ways:
 * 1. Declarative selection publication:
 *    Call `propertiesDockService.setProperties({ title: 'Node 104', rows: [...] })`.
 * 2. EditorFrame integration:
 *    Editor frames with `{ properties: { title: '...' } }` automatically dock their
 *    custom properties content DOM directly into the Auxiliary sidebar when active.
 *
 * USAGE EXAMPLE (in any domain editor or controller):
 * ```typescript
 * const dock = accessor.get(IMAEnginePropertiesDockService);
 * dock.setProperties({
 *     title: 'Boundary Condition 1',
 *     detail: 'Fixed Support',
 *     rows: [
 *         { name: 'Faces', value: 'Face 4, Face 7' },
 *         { name: 'Degrees of Freedom', value: 'UX=0, UY=0, UZ=0' },
 *         { name: 'Reaction Force', value: '1,420 N', problem: false }
 *     ],
 *     warning: undefined
 * });
 * ```
 */

export const PROPERTIES_VIEW_CONTAINER_ID = 'workbench.view.maengine.properties';
export const PROPERTIES_VIEW_ID = 'maengine.properties';

export const PROPERTIES_LOCATION_SETTING = 'maengine.properties.location';
export type PropertiesLocation = 'panel' | 'editor';

/** A single key/value row in a properties sheet. */
export interface IPropertyRow {
	readonly name: string;
	readonly value: string | HTMLElement;
	readonly problem?: boolean;
	readonly hint?: string;
}

/** Complete selection metadata published to the Properties dock. */
export interface IPropertiesSelection {
	readonly title: string;
	readonly detail?: string;
	readonly rows: readonly IPropertyRow[];
	readonly warning?: string;
	readonly note?: string;
	readonly actions?: readonly { readonly label: string; readonly run: () => void }[];
}

/** An editor frame whose properties panel can dock into the Properties view. */
export interface IPropertiesDockFrame {
	readonly element: HTMLElement;
	dock(host: HTMLElement | undefined): void;
}

export const IMAEnginePropertiesDockService = createDecorator<IMAEnginePropertiesDockService>('maenginePropertiesDockService');

export interface IMAEnginePropertiesDockService {
	readonly _serviceBrand: undefined;

	readonly enabled: boolean;
	readonly onDidChangeEnabled: Event<void>;

	readonly frames: readonly IPropertiesDockFrame[];
	readonly onDidChangeFrames: Event<void>;
	registerFrame(frame: IPropertiesDockFrame): IDisposable;

	readonly currentProperties: IPropertiesSelection | undefined;
	readonly onDidChangeProperties: Event<IPropertiesSelection | undefined>;
	setProperties(properties: IPropertiesSelection | undefined): void;
	clearProperties(): void;

	reveal(): Promise<void>;
	hide(): void;
}

/** Appends a property sheet section heading (.ma-props-heading). */
export function appendPropertyHeading(container: HTMLElement, text: string, detail?: string): HTMLElement {
	if (!detail) {
		return append(container, $('.ma-props-heading', undefined, text));
	}
	const heading = append(container, $('.ma-props-heading'));
	append(heading, $('span', undefined, text));
	append(heading, $('span.ma-props-detail', undefined, detail));
	return heading;
}

/** Appends a key/value row (.ma-props-row). Value may be string or custom HTMLElement. */
export function appendPropertyRow(container: HTMLElement, name: string, value: string | HTMLElement, problem?: boolean): HTMLElement {
	const row = append(container, $('.ma-props-row'));
	append(row, $('span.name', undefined, name));
	const cell = append(row, $('span.value'));
	if (problem) {
		cell.classList.add('problem');
		append(cell, $(`span${ThemeIcon.asCSSSelector(Codicon.warning)}`)).setAttribute('aria-hidden', 'true');
	}
	if (typeof value !== 'string') {
		append(cell, value);
	} else if (problem) {
		append(cell, $('span', undefined, value));
	} else {
		cell.textContent = value;
	}
	return row;
}

/** Appends a muted explanatory note (.ma-props-note). */
export function appendPropertyNote(container: HTMLElement, text: string): HTMLElement {
	return append(container, $('.ma-props-note', undefined, text));
}

export function dockStyleClasses(element: HTMLElement): string[] {
	const classes = new Set<string>(['maengine-editor-frame']);
	for (let node: HTMLElement | null = element; node && !node.classList.contains('editor-instance') && !node.classList.contains('editor-group-container'); node = node.parentElement) {
		for (const name of Array.from(node.classList)) {
			if (name.startsWith('maengine-') || name.startsWith('ma-')) {
				classes.add(name);
			}
		}
	}
	return [...classes];
}

class MAEnginePropertiesDockService extends Disposable implements IMAEnginePropertiesDockService {

	declare readonly _serviceBrand: undefined;

	private readonly _frames: IPropertiesDockFrame[] = [];
	private _currentProperties: IPropertiesSelection | undefined;

	private readonly _onDidChangeFrames = this._register(new Emitter<void>());
	readonly onDidChangeFrames = this._onDidChangeFrames.event;

	private readonly _onDidChangeEnabled = this._register(new Emitter<void>());
	readonly onDidChangeEnabled = this._onDidChangeEnabled.event;

	private readonly _onDidChangeProperties = this._register(new Emitter<IPropertiesSelection | undefined>());
	readonly onDidChangeProperties = this._onDidChangeProperties.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PROPERTIES_LOCATION_SETTING)) {
				this._onDidChangeEnabled.fire();
			}
		}));
	}

	get enabled(): boolean {
		return this.configurationService.getValue<PropertiesLocation>(PROPERTIES_LOCATION_SETTING) !== 'editor';
	}

	get frames(): readonly IPropertiesDockFrame[] {
		return this._frames;
	}

	get currentProperties(): IPropertiesSelection | undefined {
		return this._currentProperties;
	}

	setProperties(properties: IPropertiesSelection | undefined): void {
		this._currentProperties = properties;
		this._onDidChangeProperties.fire(properties);
	}

	clearProperties(): void {
		this.setProperties(undefined);
	}

	registerFrame(frame: IPropertiesDockFrame): IDisposable {
		this._frames.push(frame);
		this._onDidChangeFrames.fire();
		return toDisposable(() => {
			const index = this._frames.indexOf(frame);
			if (index >= 0) {
				this._frames.splice(index, 1);
				this._onDidChangeFrames.fire();
			}
		});
	}

	async reveal(): Promise<void> {
		await this.viewsService.openView(PROPERTIES_VIEW_ID, false);
	}

	hide(): void {
		this.viewsService.closeView(PROPERTIES_VIEW_ID);
	}
}

registerSingleton(IMAEnginePropertiesDockService, MAEnginePropertiesDockService, InstantiationType.Delayed);

/**
 * The Properties View Pane inside the Auxiliary Sidebar.
 */
export class PropertiesDockView extends ViewPane {

	static readonly ID = PROPERTIES_VIEW_ID;

	private contentArea: HTMLElement | undefined;
	private hostArea: HTMLElement | undefined;
	private emptyArea: HTMLElement | undefined;
	private activeDockedFrame: IPropertiesDockFrame | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly editorService: IEditorService,
		@IMAEnginePropertiesDockService private readonly dockService: IMAEnginePropertiesDockService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.dockService.onDidChangeProperties(() => this.update()));
		this._register(this.dockService.onDidChangeFrames(() => this.updateActiveFrame()));
		this._register(this.dockService.onDidChangeEnabled(() => this.update()));
		this._register(this.editorService.onDidActiveEditorChange(() => this.updateActiveFrame()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('maengine-properties-dock');

		this.hostArea = append(container, $('.ma-props-dock-host'));
		this.contentArea = append(container, $('.ma-props-dock-content'));
		this.emptyArea = append(container, $('.ma-props-dock-empty'));
		this.emptyArea.textContent = localize('properties.hint', "Select an item to see its properties.");

		this.updateActiveFrame();
	}

	private updateActiveFrame(): void {
		if (!this.hostArea) {
			return;
		}

		const activePane = this.editorService.activeEditorPane;
		const activeElem = (activePane as any)?.getContainer?.() as HTMLElement | undefined;
		let targetFrame: IPropertiesDockFrame | undefined;

		if (activeElem && this.dockService.enabled) {
			targetFrame = this.dockService.frames.find(f => activeElem.contains(f.element));
		}

		if (this.activeDockedFrame !== targetFrame) {
			if (this.activeDockedFrame) {
				this.activeDockedFrame.dock(undefined);
				this.activeDockedFrame = undefined;
			}

			if (targetFrame) {
				this.activeDockedFrame = targetFrame;
				targetFrame.dock(this.hostArea);
				this.hostArea.className = `ma-props-dock-host ${dockStyleClasses(targetFrame.element).join(' ')}`;
			} else {
				this.hostArea.className = 'ma-props-dock-host';
			}
		}

		this.update();
	}

	private update(): void {
		if (!this.contentArea || !this.emptyArea || !this.hostArea) {
			return;
		}

		this.renderDisposables.clear();
		clearNode(this.contentArea);

		const hasDockedContent = !!this.activeDockedFrame && this.hostArea.children.length > 0;
		const props = this.dockService.currentProperties;

		if (hasDockedContent) {
			this.hostArea.classList.remove('hidden');
			this.contentArea.classList.add('hidden');
			this.emptyArea.classList.add('hidden');
			return;
		}

		this.hostArea.classList.add('hidden');

		if (!props) {
			this.contentArea.classList.add('hidden');
			this.emptyArea.classList.remove('hidden');
			return;
		}

		this.contentArea.classList.remove('hidden');
		this.emptyArea.classList.add('hidden');

		// Render published properties sheet
		const sheet = append(this.contentArea, $('.ma-props-sheet'));
		appendPropertyHeading(sheet, props.title, props.detail);

		if (props.warning) {
			const warnBox = append(sheet, $('.ma-props-warning'));
			append(warnBox, $(`span${ThemeIcon.asCSSSelector(Codicon.warning)}`));
			append(warnBox, $('span', undefined, props.warning));
		}

		for (const row of props.rows) {
			appendPropertyRow(sheet, row.name, row.value, row.problem);
		}

		if (props.note) {
			appendPropertyNote(sheet, props.note);
		}

		if (props.actions?.length) {
			const actionRow = append(sheet, $('.ma-props-actions'));
			for (const act of props.actions) {
				const link = append(actionRow, $('a.ma-props-action-link', { role: 'button', tabIndex: 0 }, act.label));
				this.renderDisposables.add(addDisposableListener(link, EventType.CLICK, () => act.run()));
				this.renderDisposables.add(addDisposableListener(link, EventType.KEY_DOWN, e => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						act.run();
					}
				}));
			}
		}
	}
}

const propertiesViewIcon = registerIcon('maengine-properties-view-icon', Codicon.symbolProperty, localize('propertiesViewIcon', "View icon of the MAEngine Properties dock."));

const propertiesContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: PROPERTIES_VIEW_CONTAINER_ID,
	title: localize2('properties', "Properties"),
	icon: propertiesViewIcon,
	order: 0,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [PROPERTIES_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: PROPERTIES_VIEW_CONTAINER_ID,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: PROPERTIES_VIEW_ID,
	name: localize2('properties', "Properties"),
	containerIcon: propertiesViewIcon,
	ctorDescriptor: new SyncDescriptor(PropertiesDockView),
	canToggleVisibility: false,
	canMoveView: true,
	order: 0,
}], propertiesContainer);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'maengineLayout',
	title: localize('layout.settings', "MAEngine Layout"),
	type: 'object',
	properties: {
		[PROPERTIES_LOCATION_SETTING]: {
			type: 'string',
			enum: ['panel', 'editor'],
			enumDescriptions: [
				localize('properties.location.panel', "In the Properties panel in the auxiliary sidebar on the right of the window."),
				localize('properties.location.editor', "In a column on the right of each editor."),
			],
			default: 'panel',
			description: localize('properties.location', "Where MAEngine editors show the properties of the selection."),
		},
	},
});

/**
 * Controls default visibility of the Auxiliary Sidebar (Properties dock):
 * Visible by default when a project is open (like SAEngine), hidden when none.
 */
export class PropertiesDockVisibilityContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.maengine.propertiesDockVisibility';

	constructor(
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();

		this._register(this.projectService.onDidChangeProject(project => this.updateVisibility(!!project)));
		this.updateVisibility(!!this.projectService.project);
	}

	private updateVisibility(hasProject: boolean): void {
		if (hasProject) {
			this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
			void this.viewsService.openView(PROPERTIES_VIEW_ID, false);
		} else {
			this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		}
	}
}

registerWorkbenchContribution2(PropertiesDockVisibilityContribution.ID, PropertiesDockVisibilityContribution, WorkbenchPhase.AfterRestored);
