/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/tablesView.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IMAEngineProjectService, IMechastudioProject } from '../../../services/maengineProject/common/maengineProject.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * MAENGINE TABLES VIEW & DATA GRID API
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * The Tables panel sits in the bottom panel tray and renders tabular simulation
 * datasets (nodes, elements, materials, boundary conditions, convergence logs).
 *
 * It features sub-tabs, sortable column headers, a real-time text filter box,
 * dropdown category filters, and calm empty states.
 *
 * USAGE EXAMPLE (registering a table provider):
 * ```typescript
 * const registration = MAEngineTables.registerTable({
 *     id: 'materialsTable',
 *     label: 'Materials',
 *     getData: () => ({
 *         columns: [
 *             { id: 'name', label: 'Material Name', sortable: true },
 *             { id: 'density', label: 'Density (kg/m³)', align: 'right', sortable: true },
 *             { id: 'yield', label: 'Yield Strength (MPa)', align: 'right', sortable: true }
 *         ],
 *         rows: [
 *             { name: 'Steel S355', density: 7850, yield: 355 },
 *             { name: 'Alloy 7075-T6', density: 2810, yield: 503 }
 *         ]
 *     })
 * });
 * ```
 */

export const TABLES_VIEW_ID = 'maengine.tables';
export const TABLES_VIEW_CONTAINER_ID = 'workbench.panel.maengineTables';
const ACTIVE_TAB_KEY = 'maengine.tables.activeTab';

/** Column specification for generic tabular data grid. */
export interface ITableColumn<T = any> {
	readonly id: string;
	readonly label: string;
	readonly width?: number | string;
	readonly minWidth?: number;
	readonly align?: 'left' | 'center' | 'right';
	readonly sortable?: boolean;
	readonly getValue?: (row: T) => string | number | boolean;
	readonly renderCell?: (row: T, container: HTMLElement) => void;
}

/** Dropdown filter specification for tables. */
export interface ITableFilter<T = any> {
	readonly id: string;
	readonly label: string;
	readonly options: readonly { readonly id: string; readonly label: string }[];
	readonly defaultOptionId?: string;
	readonly filter?: (row: T, optionId: string) => boolean;
}

/** Complete dataset provided by a table provider. */
export interface ITableData<T = any> {
	readonly columns: readonly ITableColumn<T>[];
	readonly rows: readonly T[];
	readonly filters?: readonly ITableFilter<T>[];
	readonly emptyText?: string;
}

/** Provider interface for declarative data tables. */
export interface IMAEngineTableProvider<T = any> {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	getData(): ITableData<T> | Promise<ITableData<T>>;
	readonly onDidChangeData?: Event<void>;
}

/** Custom table component handle (e.g. for canvas-based or virtualized grids). */
export interface IMAEngineTable extends IDisposable {
	layout(width: number, height: number): void;
	setVisible?(visible: boolean): void;
	focus?(): void;
}

/** Descriptor for custom table implementations. */
export interface IMAEngineTableDescriptor {
	readonly id: string;
	label(): string;
	create(container: HTMLElement, instantiationService: IInstantiationService): IMAEngineTable;
}

/**
 * Registry for MAEngine data tables.
 */
export class MAEngineTableRegistry extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly customTables: IMAEngineTableDescriptor[] = [];
	private readonly providers: IMAEngineTableProvider[] = [];

	registerTable<T = any>(provider: IMAEngineTableProvider<T>): IDisposable {
		this.providers.push(provider);
		const changeListener = provider.onDidChangeData?.(() => this._onDidChange.fire());
		this._onDidChange.fire();

		return toDisposable(() => {
			changeListener?.dispose();
			const idx = this.providers.indexOf(provider);
			if (idx >= 0) {
				this.providers.splice(idx, 1);
				this._onDidChange.fire();
			}
		});
	}

	registerCustomTable(descriptor: IMAEngineTableDescriptor): IDisposable {
		this.customTables.push(descriptor);
		this._onDidChange.fire();

		return toDisposable(() => {
			const idx = this.customTables.indexOf(descriptor);
			if (idx >= 0) {
				this.customTables.splice(idx, 1);
				this._onDidChange.fire();
			}
		});
	}

	tablesOf(_project: IMechastudioProject | undefined): readonly (IMAEngineTableDescriptor | IMAEngineTableProvider)[] {
		return [...this.customTables, ...this.providers];
	}
}

export const MAEngineTables = new MAEngineTableRegistry();

interface IOpenTableEntry {
	readonly id: string;
	readonly element: HTMLElement;
	readonly table: IMAEngineTable;
}

/**
 * Generic DOM data grid implementation for `IMAEngineTableProvider`.
 */
class GenericDataGridTable extends Disposable implements IMAEngineTable {

	private readonly store = this._register(new DisposableStore());
	private sortColumn: string | undefined;
	private sortAsc = true;
	private filterQuery = '';
	private activeFilters = new Map<string, string>();
	private currentData: ITableData | undefined;

	private toolbar: HTMLElement;
	private searchInput: HTMLInputElement;
	private filterSelects = new Map<string, HTMLSelectElement>();
	private countLabel: HTMLElement;
	private scrollContainer: HTMLElement;
	private gridTable: HTMLTableElement;
	private emptyNotice: HTMLElement;

	constructor(
		container: HTMLElement,
		private readonly provider: IMAEngineTableProvider,
	) {
		super();

		const root = append(container, $('.ma-tables-table'));

		// 1. Toolbar
		this.toolbar = append(root, $('.ma-tables-toolbar'));

		const searchBox = append(this.toolbar, $('.ma-tables-search-box'));
		append(searchBox, $(`span${ThemeIcon.asCSSSelector(Codicon.search)}`));
		this.searchInput = append(searchBox, $<HTMLInputElement>('input.ma-tables-search-input', {
			type: 'text',
			placeholder: localize('tables.searchPlaceholder', "Filter rows..."),
			'aria-label': localize('tables.searchAria', "Filter table rows"),
		}));
		this.store.add(addDisposableListener(this.searchInput, EventType.INPUT, () => {
			this.filterQuery = this.searchInput.value.toLowerCase().trim();
			this.renderRows();
		}));

		this.countLabel = append(this.toolbar, $('span.ma-tables-count'));

		// 2. Data scroll area & Table
		this.scrollContainer = append(root, $('.ma-tables-scroll'));
		this.gridTable = append(this.scrollContainer, $<HTMLTableElement>('table.ma-tables-grid', { role: 'table' }));
		this.emptyNotice = append(this.scrollContainer, $('.ma-tables-empty'));

		if (provider.onDidChangeData) {
			this.store.add(provider.onDidChangeData(() => void this.reload()));
		}

		void this.reload();
	}

	async reload(): Promise<void> {
		this.currentData = await this.provider.getData();
		this.buildFilters();
		this.renderGrid();
	}

	private buildFilters(): void {
		// Clear existing filter selects
		for (const sel of this.filterSelects.values()) {
			sel.remove();
		}
		this.filterSelects.clear();
		this.activeFilters.clear();

		const filters = this.currentData?.filters;
		if (!filters || !filters.length) {
			return;
		}

		for (const f of filters) {
			const select = append(this.toolbar, $<HTMLSelectElement>('select.ma-tables-filter-select', { 'aria-label': f.label }));
			for (const opt of f.options) {
				const optionElem = append(select, $<HTMLOptionElement>('option', { value: opt.id }, opt.label));
				if (opt.id === f.defaultOptionId) {
					optionElem.selected = true;
				}
			}
			const selectedId = f.defaultOptionId ?? f.options[0]?.id ?? '';
			this.activeFilters.set(f.id, selectedId);
			this.filterSelects.set(f.id, select);

			this.store.add(addDisposableListener(select, EventType.CHANGE, () => {
				this.activeFilters.set(f.id, select.value);
				this.renderRows();
			}));
		}

		// Keep count label at far right
		this.toolbar.appendChild(this.countLabel);
	}

	private renderGrid(): void {
		clearNode(this.gridTable);
		if (!this.currentData || !this.currentData.columns.length) {
			this.emptyNotice.textContent = this.currentData?.emptyText || localize('tables.noData', "No table data available.");
			this.emptyNotice.classList.add('visible');
			return;
		}

		this.emptyNotice.classList.remove('visible');

		// Header
		const thead = append(this.gridTable, $('thead'));
		const headerRow = append(thead, $('tr'));
		for (const col of this.currentData.columns) {
			const th = append(headerRow, $<HTMLTableCellElement>('th', {
				role: 'columnheader',
				scope: 'col',
				id: `col-${col.id}`,
			}));
			if (col.align) {
				th.classList.add(`align-${col.align}`);
			}
			if (col.width) {
				th.style.width = typeof col.width === 'number' ? `${col.width}px` : col.width;
			}
			if (col.minWidth) {
				th.style.minWidth = `${col.minWidth}px`;
			}

			const labelSpan = append(th, $('span', undefined, col.label));
			if (col.sortable) {
				th.classList.add('sortable');
				const sortIcon = append(th, $('span.sort-icon'));
				if (this.sortColumn === col.id) {
					sortIcon.className = `sort-icon ${ThemeIcon.asClassName(this.sortAsc ? Codicon.chevronUp : Codicon.chevronDown)}`;
				} else {
					sortIcon.className = `sort-icon ${ThemeIcon.asClassName(Codicon.unfold)}`;
					sortIcon.style.opacity = '0.35';
				}

				this.store.add(addDisposableListener(th, EventType.CLICK, () => {
					if (this.sortColumn === col.id) {
						if (this.sortAsc) {
							this.sortAsc = false;
						} else {
							this.sortColumn = undefined;
						}
					} else {
						this.sortColumn = col.id;
						this.sortAsc = true;
					}
					this.renderGrid();
				}));
			} else {
				labelSpan.style.cursor = 'default';
			}
		}

		// Body
		append(this.gridTable, $('tbody'));
		this.renderRows();
	}

	private renderRows(): void {
		const tbody = this.gridTable.querySelector('tbody');
		if (!tbody || !this.currentData) {
			return;
		}

		clearNode(tbody);

		let rows = [...this.currentData.rows];

		// 1. Filter by dropdowns
		const filters = this.currentData.filters;
		if (filters?.length) {
			for (const f of filters) {
				const activeId = this.activeFilters.get(f.id);
				if (activeId && f.filter) {
					rows = rows.filter(r => f.filter!(r, activeId));
				}
			}
		}

		// 2. Filter by search query
		if (this.filterQuery) {
			const query = this.filterQuery;
			const cols = this.currentData.columns;
			rows = rows.filter(row => {
				for (const col of cols) {
					const val = col.getValue ? col.getValue(row) : (row as any)[col.id];
					if (val !== undefined && val !== null && String(val).toLowerCase().includes(query)) {
						return true;
					}
				}
				return false;
			});
		}

		// 3. Sort
		if (this.sortColumn) {
			const colId = this.sortColumn;
			const col = this.currentData.columns.find(c => c.id === colId);
			const asc = this.sortAsc ? 1 : -1;
			rows.sort((a, b) => {
				const valA = col?.getValue ? col.getValue(a) : (a as any)[colId];
				const valB = col?.getValue ? col.getValue(b) : (b as any)[colId];
				if (valA === valB) {
					return 0;
				}
				if (valA === undefined || valA === null) {
					return 1;
				}
				if (valB === undefined || valB === null) {
					return -1;
				}
				if (typeof valA === 'number' && typeof valB === 'number') {
					return (valA - valB) * asc;
				}
				return String(valA).localeCompare(String(valB)) * asc;
			});
		}

		// Update count label
		const total = this.currentData.rows.length;
		if (rows.length === total) {
			this.countLabel.textContent = total === 1 ? localize('tables.rowCount1', "1 row") : localize('tables.rowCountN', "{0} rows", total.toLocaleString());
		} else {
			this.countLabel.textContent = localize('tables.filteredCount', "{0} of {1} rows", rows.length.toLocaleString(), total.toLocaleString());
		}

		if (rows.length === 0) {
			this.emptyNotice.textContent = localize('tables.noMatching', "No matching rows.");
			this.emptyNotice.classList.add('visible');
			return;
		}

		this.emptyNotice.classList.remove('visible');

		for (const row of rows) {
			const tr = append(tbody, $('tr', { role: 'row' }));
			for (const col of this.currentData.columns) {
				const td = append(tr, $<HTMLTableCellElement>('td', { role: 'cell' }));
				if (col.align) {
					td.classList.add(`align-${col.align}`);
				}
				if (col.renderCell) {
					col.renderCell(row, td);
				} else {
					const val = col.getValue ? col.getValue(row) : (row as any)[col.id];
					if (typeof val === 'number') {
						td.classList.add('numeric');
					}
					td.textContent = val !== undefined && val !== null ? String(val) : '';
					if (td.textContent) {
						td.title = td.textContent;
					}
				}
			}
		}
	}

	layout(_width: number, _height: number): void {
		// Handled via CSS flexbox & overflow
	}

	focus(): void {
		this.searchInput.focus();
	}
}

/**
 * The Tables Panel View Pane.
 */
export class TablesView extends ViewPane {

	static readonly ID = TABLES_VIEW_ID;

	private tabs: HTMLElement | undefined;
	private tablesBody: HTMLElement | undefined;
	private empty: HTMLElement | undefined;
	private readonly tabStore = this._register(new DisposableStore());
	private readonly open = new Map<string, IOpenTableEntry>();
	private readonly tabButtons = new Map<string, HTMLElement>();
	private active: string | undefined;

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
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(toDisposable(() => this.closeTables()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('maengine-tables-view');

		this.tabs = append(container, $('.ma-tables-tabs', { role: 'tablist', 'aria-label': localize('tables.aria', "Simulation Data Tables") }));
		this.tablesBody = append(container, $('.ma-tables-body'));
		this.empty = append(this.tablesBody, $('.ma-tables-empty'));

		this._register(addDisposableListener(this.tabs, EventType.KEY_DOWN, e => this.onTabKey(new StandardKeyboardEvent(e))));
		this._register(MAEngineTables.onDidChange(() => this.renderTables()));
		this._register(this.projectService.onDidChangeProject(() => {
			this.closeTables();
			this.renderTables();
		}));

		this.renderTables();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		const tabsHeight = this.tabs?.offsetHeight ?? 0;
		const innerHeight = Math.max(0, height - tabsHeight);
		const activeTable = this.open.get(this.active ?? '')?.table;
		activeTable?.layout(width, innerHeight);
	}

	override focus(): void {
		super.focus();
		const table = this.open.get(this.active ?? '')?.table;
		if (table?.focus) {
			table.focus();
		} else {
			this.tabButtons.get(this.active ?? '')?.focus();
		}
	}

	showTable(id: string): void {
		const tables = MAEngineTables.tablesOf(this.projectService.project);
		if (tables.some(t => t.id === id)) {
			this.active = id;
			this.storageService.store(ACTIVE_TAB_KEY, id, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this.renderTables();
		}
	}

	private renderTables(): void {
		const tabs = this.tabs;
		const body = this.tablesBody;
		if (!tabs || !body || !this.empty) {
			return;
		}

		this.tabStore.clear();
		this.tabButtons.clear();
		clearNode(tabs);

		const descriptors = MAEngineTables.tablesOf(this.projectService.project);

		for (const id of [...this.open.keys()]) {
			if (!descriptors.some(d => d.id === id)) {
				this.closeTable(id);
			}
		}

		if (descriptors.length > 0) {
			const validActive = descriptors.some(d => d.id === this.active);
			if (!validActive) {
				const remembered = this.storageService.get(ACTIVE_TAB_KEY, StorageScope.WORKSPACE);
				this.active = descriptors.some(d => d.id === remembered) ? remembered : descriptors[0].id;
			}
		} else {
			this.active = undefined;
		}

		const hasTables = descriptors.length > 0;
		this.empty.classList.toggle('visible', !hasTables);
		this.empty.textContent = this.projectService.project
			? localize('tables.none', "This project has no tables yet.")
			: localize('tables.noProject', "Open a project to see its simulation data as tables.");
		tabs.classList.toggle('hidden', !hasTables);

		for (const desc of descriptors) {
			const label = 'label' in desc && typeof desc.label === 'function' ? desc.label() : (desc as IMAEngineTableProvider).label;
			const selected = desc.id === this.active;
			const tab = append(tabs, $<HTMLButtonElement>('button.ma-tables-tab', {
				type: 'button',
				role: 'tab',
				id: `ma-tables-tab-${desc.id}`,
				'aria-selected': String(selected),
				tabIndex: selected ? 0 : -1,
			}, label));
			tab.classList.toggle('checked', selected);
			this.tabButtons.set(desc.id, tab);
			this.tabStore.add(addDisposableListener(tab, EventType.CLICK, () => this.showTable(desc.id)));
		}

		for (const [id, open] of this.open) {
			const shown = id === this.active;
			open.element.classList.toggle('hidden', !shown);
			open.table.setVisible?.(shown && this.isBodyVisible());
		}

		const activeDesc = descriptors.find(d => d.id === this.active);
		if (activeDesc && !this.open.has(activeDesc.id)) {
			const element = append(body, $('.ma-tables-table', { role: 'tabpanel', 'aria-labelledby': `ma-tables-tab-${activeDesc.id}` }));
			let table: IMAEngineTable;
			if ('create' in activeDesc) {
				table = activeDesc.create(element, this.instantiationService);
			} else {
				table = new GenericDataGridTable(element, activeDesc);
			}
			this.open.set(activeDesc.id, { id: activeDesc.id, element, table });
			table.setVisible?.(this.isBodyVisible());
		}
	}

	private onTabKey(event: StandardKeyboardEvent): void {
		const descriptors = MAEngineTables.tablesOf(this.projectService.project);
		if (!descriptors.length) {
			return;
		}
		const index = descriptors.findIndex(d => d.id === this.active);
		let next: number | undefined;
		if (event.equals(KeyCode.RightArrow)) {
			next = (index + 1) % descriptors.length;
		} else if (event.equals(KeyCode.LeftArrow)) {
			next = (index - 1 + descriptors.length) % descriptors.length;
		} else if (event.equals(KeyCode.Home)) {
			next = 0;
		} else if (event.equals(KeyCode.End)) {
			next = descriptors.length - 1;
		}
		if (next !== undefined && descriptors[next]) {
			event.preventDefault();
			event.stopPropagation();
			this.showTable(descriptors[next].id);
			this.tabButtons.get(descriptors[next].id)?.focus();
		}
	}

	private closeTable(id: string): void {
		const open = this.open.get(id);
		if (open) {
			open.table.dispose();
			open.element.remove();
			this.open.delete(id);
		}
	}

	private closeTables(): void {
		for (const id of [...this.open.keys()]) {
			this.closeTable(id);
		}
	}
}

const tablesViewIcon = registerIcon('maengine-tables-view-icon', Codicon.table, localize('tablesViewIcon', "View icon of the MAEngine Tables panel."));

const tablesContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: TABLES_VIEW_CONTAINER_ID,
	title: localize2('tables', "Tables"),
	icon: tablesViewIcon,
	order: -2,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [TABLES_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: TABLES_VIEW_CONTAINER_ID,
}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: TABLES_VIEW_ID,
	name: localize2('tables', "Tables"),
	containerIcon: tablesViewIcon,
	ctorDescriptor: new SyncDescriptor(TablesView),
	canToggleVisibility: false,
	canMoveView: true,
	order: 0,
}], tablesContainer);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'maengine.showTables',
			title: localize2('maengine.showTables', "Show Tables"),
			metadata: { description: localize2('maengine.showTables.description', "Opens the simulation data tables below the editor.") },
			category: localize2('maengine.category', "MAEngine"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(TABLES_VIEW_ID, true);
	}
});
