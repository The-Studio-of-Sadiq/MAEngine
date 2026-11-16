/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/marketplaceEditor.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { EditorFrame } from '../../maengineProject/browser/editorFrame.js';
import { IMAEnginePropertiesDockService } from '../../maengineProject/browser/propertiesDock.js';
import { MarketplaceEditorInput } from './marketplaceEditorInput.js';

interface IMarketplacePackage {
	readonly id: string;
	readonly version: string;
	readonly name: string;
	readonly description?: string;
	readonly category?: string;
}

interface IMarketplaceData {
	schema?: number;
	installedPackages?: IMarketplacePackage[];
}

const CATALOG_PACKAGES: readonly IMarketplacePackage[] = [
	{
		id: 'materials.metals.structural',
		version: '1.0.0',
		name: 'Structural Steels & Alloys',
		description: 'Standard ASTM structural steel and alloy material cards with elastic-plastic definitions.',
		category: 'Materials'
	},
	{
		id: 'templates.cantilever',
		version: '1.0.0',
		name: 'Cantilever Benchmark Template',
		description: 'Standard cantilever beam study geometry, BCs, and verified deflection benchmarks.',
		category: 'Templates'
	},
	{
		id: 'materials.aerospace',
		version: '2.0.1',
		name: 'Aerospace & Superalloys Material Pack',
		description: 'High-temperature Inconel 718, Haynes 282, René 41, and Ti-6Al-4V stress-strain curves.',
		category: 'Materials'
	},
	{
		id: 'templates.fasteners',
		version: '1.2.0',
		name: 'ISO / ASME Fastener Catalog',
		description: 'Parametric Hex Bolts (ISO 4014) and Socket Head Caps (ISO 4762) for contact pairing.',
		category: 'Templates'
	},
	{
		id: 'templates.flanges',
		version: '1.3.0',
		name: 'ASME B16.5 Pipe Flanges',
		description: 'Weld neck, slip-on, and blind flanges with pre-selected bolt hole boundary selectors.',
		category: 'Templates'
	},
	{
		id: 'solver.contact_mortar',
		version: '1.0.0',
		name: 'Mortar Contact Formulation Pack',
		description: 'Pre-configured CalculiX penalty contact decks with Coulomb friction and damping.',
		category: 'Solver'
	}
];

export class MarketplaceEditor extends EditorPane {

	private frame!: EditorFrame;
	private viewMode: 'all' | 'installed' = 'all';
	private contentContainer!: HTMLElement;
	private searchQuery = '';
	private currentData: IMarketplaceData | undefined;
	private currentResource: any;
	private selectedId: string | undefined;

	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IMAEnginePropertiesDockService private readonly propertiesDockService: IMAEnginePropertiesDockService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(MarketplaceEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.frame = this._register(this.instantiationService.createInstance(EditorFrame, parent, {
			id: 'maengine.marketplaceEditor',
			ariaLabel: localize('marketplaceEditor.aria', "Marketplace"),
			properties: { title: localize('properties', "Properties") }
		}));
		this.frame.element.classList.add('maengine-marketplace-editor');
		this.frame.setActions([this.frame.togglePropertiesAction]);

		this._register(this.frame.createSegmented(
			this.frame.titleSlot,
			[
				{ id: 'all', label: localize('market.all', "All"), icon: Codicon.extensions },
				{ id: 'installed', label: localize('market.installed', "Installed"), icon: Codicon.check }
			],
			'all',
			mode => this.switchView(mode)
		));

		this.contentContainer = append(this.frame.main, $('.ma-market-content'));
	}

	private switchView(mode: 'all' | 'installed'): void {
		this.viewMode = mode;
		this.render();
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();

		const resource = (input as MarketplaceEditorInput).resource;
		this.currentResource = resource;
		if (resource) {
			this.inputDisposables.add(this.fileService.onDidFilesChange(e => {
				if (e.contains(resource)) {
					void this.load(resource);
				}
			}));
			await this.load(resource);
		}
	}

	override clearInput(): void {
		this.inputDisposables.clear();
		this.propertiesDockService.clearProperties();
		super.clearInput();
	}

	override dispose(): void {
		this.propertiesDockService.clearProperties();
		super.dispose();
	}

	private async load(resource: any): Promise<void> {
		try {
			const content = await this.fileService.readFile(resource);
			this.currentData = JSON.parse(content.value.toString()) as IMarketplaceData;
		} catch {
			this.currentData = undefined;
		}
		this.render();
	}

	private render(): void {
		const data = this.currentData ?? {};
		const installedList = data.installedPackages ?? [];
		const installedIds = new Set(installedList.map(p => p.id));

		// Bottom Hint Strip
		this.frame.setStatus({
			text: localize('market.status', "{0} packages installed in study", installedList.length)
		});

		clearNode(this.contentContainer);

		// Search Bar
		const searchRow = append(this.contentContainer, $('.ma-market-search-box'));
		const searchInput = append(searchRow, $<HTMLInputElement>('input.ma-market-search-input', {
			type: 'text',
			placeholder: localize('market.searchPlaceholder', "Filter packages by name, ID or category...")
		}));
		searchInput.value = this.searchQuery;

		this.inputDisposables.add(addDisposableListener(searchInput, EventType.INPUT, () => {
			this.searchQuery = searchInput.value.toLowerCase().trim();
			this.renderGrid(installedIds);
		}));

		this.renderGrid(installedIds);
	}

	private renderGrid(installedIds: Set<string>): void {
		const existingGrid = this.contentContainer.querySelector('.ma-market-grid');
		if (existingGrid) {
			existingGrid.remove();
		}

		const grid = append(this.contentContainer, $('.ma-market-grid'));
		let filtered = CATALOG_PACKAGES;

		if (this.viewMode === 'installed') {
			filtered = filtered.filter(p => installedIds.has(p.id));
		}

		if (this.searchQuery) {
			filtered = filtered.filter(p =>
				p.name.toLowerCase().includes(this.searchQuery) ||
				p.id.toLowerCase().includes(this.searchQuery) ||
				(p.category && p.category.toLowerCase().includes(this.searchQuery)) ||
				(p.description && p.description.toLowerCase().includes(this.searchQuery))
			);
		}

		if (filtered.length === 0) {
			const empty = append(grid, $('.ma-market-empty-note', undefined,
				this.viewMode === 'installed'
					? localize('market.noInstalled', "No packages currently installed.")
					: localize('market.noMatches', "No packages matching filter.")
			));
			empty.style.color = 'var(--ma-muted, var(--vscode-descriptionForeground))';
			empty.style.fontSize = 'var(--ma-font-s, 12px)';
			empty.style.padding = 'var(--ma-space-2, 8px) 0';
			return;
		}

		for (const pkg of filtered) {
			const isInstalled = installedIds.has(pkg.id);
			const card = append(grid, $('.ma-market-card'));
			if (this.selectedId === pkg.id) {
				card.classList.add('selected');
			}

			const main = append(card, $('.ma-market-card-main'));
			const titleRow = append(main, $('.ma-market-card-title-row'));
			append(titleRow, $('span.ma-market-card-title', undefined, pkg.name));
			append(titleRow, $('span.ma-market-card-ver', undefined, `v${pkg.version}`));

			if (pkg.description) {
				append(main, $('span.ma-market-card-desc', undefined, pkg.description));
			}

			const side = append(card, $('.ma-market-card-side'));
			if (isInstalled) {
				append(side, $('span.ma-market-pill-installed', undefined, localize('market.installedBadge', "Installed")));
				const uninstBtn = append(side, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('market.uninstall', "Uninstall")));
				uninstBtn.style.padding = '2px 8px';
				uninstBtn.style.fontSize = 'var(--ma-font-xs, 11px)';
				this.inputDisposables.add(addDisposableListener(uninstBtn, EventType.CLICK, e => {
					e.stopPropagation();
					void this.togglePackage(pkg, false);
				}));
			} else {
				const instBtn = append(side, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('market.install', "Install")));
				instBtn.style.padding = '2px 8px';
				instBtn.style.fontSize = 'var(--ma-font-xs, 11px)';
				this.inputDisposables.add(addDisposableListener(instBtn, EventType.CLICK, e => {
					e.stopPropagation();
					void this.togglePackage(pkg, true);
				}));
			}

			this.inputDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
				for (const child of Array.from(grid.children)) {
					child.classList.remove('selected');
				}
				card.classList.add('selected');
				this.selectPackage(pkg, isInstalled);
			}));
		}

		if (filtered.length > 0 && !this.selectedId) {
			this.selectPackage(filtered[0], installedIds.has(filtered[0].id));
		}
	}

	private selectPackage(pkg: IMarketplacePackage, isInstalled: boolean): void {
		this.selectedId = pkg.id;
		this.propertiesDockService.setProperties({
			title: pkg.name,
			detail: pkg.id,
			rows: [
				{ name: localize('prop.packageId', "Package ID"), value: pkg.id },
				{ name: localize('prop.version', "Version"), value: `v${pkg.version}` },
				{ name: localize('prop.category', "Category"), value: pkg.category ?? localize('prop.na', "n/a") },
				{ name: localize('prop.status', "Status"), value: isInstalled ? localize('market.installedState', "Installed") : localize('market.availableState', "Available") },
				{ name: localize('prop.description', "Description"), value: pkg.description ?? localize('prop.na', "n/a") }
			],
			actions: [
				{
					label: isInstalled ? localize('market.uninstallAction', "Uninstall Package") : localize('market.installAction', "Install Package"),
					run: () => void this.togglePackage(pkg, !isInstalled)
				}
			]
		});
	}

	private async togglePackage(pkg: IMarketplacePackage, install: boolean): Promise<void> {
		if (!this.currentData || !this.currentResource) {
			return;
		}
		const list = this.currentData.installedPackages ?? (this.currentData.installedPackages = []);
		if (install) {
			if (!list.some(p => p.id === pkg.id)) {
				list.push({ id: pkg.id, version: pkg.version, name: pkg.name });
			}
			this.notificationService.info(localize('market.installedNotice', "Package '{0}' installed.", pkg.name));
		} else {
			this.currentData.installedPackages = list.filter(p => p.id !== pkg.id);
			this.notificationService.info(localize('market.uninstalledNotice', "Package '{0}' uninstalled.", pkg.name));
		}

		await this.fileService.writeFile(this.currentResource, VSBuffer.fromString(JSON.stringify(this.currentData, null, '\t')));
		this.render();
		this.selectPackage(pkg, install);
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
