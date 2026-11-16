/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/materialEditor.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
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
import { MAEngineTables } from '../../maengineProject/browser/tablesView.js';
import { MaterialEditorInput } from './materialEditorInput.js';

interface IMaterialCard {
	readonly id: string;
	readonly name: string;
	readonly elasticModulus_MPa: number;
	readonly poissonsRatio: number;
	readonly density_tonne_mm3: number;
	readonly yieldStrength_MPa?: number;
	readonly thermalConductivity_W_mK?: number;
	readonly expansionCoefficient_perK?: number;
}

interface IMaterialsData {
	readonly schema?: number;
	readonly materials?: readonly IMaterialCard[];
}

export class MaterialEditor extends EditorPane {

	private frame!: EditorFrame;
	private viewMode: 'library' | 'assigned' = 'library';
	private contentContainer!: HTMLElement;
	private selectedMaterialId: string | undefined;

	private readonly inputDisposables = this._register(new DisposableStore());
	private currentData: IMaterialsData | undefined;

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
		super(MaterialEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.frame = this._register(this.instantiationService.createInstance(EditorFrame, parent, {
			id: 'maengine.materialEditor',
			ariaLabel: localize('materialEditor.aria', "Materials"),
			properties: { title: localize('properties', "Properties") }
		}));
		this.frame.element.classList.add('maengine-material-editor');
		this.frame.setActions([this.frame.togglePropertiesAction]);

		this._register(this.frame.createSegmented(
			this.frame.titleSlot,
			[
				{ id: 'library', label: localize('mat.library', "Library"), icon: Codicon.library },
				{ id: 'assigned', label: localize('mat.assigned', "Assigned"), icon: Codicon.check }
			],
			'library',
			mode => this.switchView(mode)
		));

		this.contentContainer = append(this.frame.main, $('.ma-mat-content'));
	}

	private switchView(mode: 'library' | 'assigned'): void {
		this.viewMode = mode;
		this.render();
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();

		const resource = (input as MaterialEditorInput).resource;
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
			this.currentData = JSON.parse(content.value.toString()) as IMaterialsData;
		} catch {
			this.currentData = undefined;
		}
		this.render();
	}

	private render(): void {
		const data = this.currentData;
		const materials = data?.materials ?? [];

		if (materials.length === 0) {
			this.frame.setEmpty({
				icon: Codicon.library,
				title: localize('mat.emptyTitle', "No materials yet"),
				text: localize('mat.emptyText', "Add a material from the library to configure study properties."),
				actions: [{
					label: localize('mat.addAction', "Add Material..."),
					primary: true,
					run: () => this.addMaterial()
				}]
			});
			this.frame.setStatus({
				text: localize('mat.emptyStatus', "No materials defined"),
				link: { label: localize('mat.addAction', "Add Material..."), run: () => this.addMaterial() }
			});
			this.propertiesDockService.clearProperties();
			return;
		}

		this.frame.setEmpty(undefined);
		this.frame.setStatus({
			text: localize('mat.status', "{0} materials defined in study library", materials.length)
		});

		// Register Materials table in bottom Tables Panel
		this.inputDisposables.add(MAEngineTables.registerTable({
			id: 'maengine.materials.table',
			label: localize('table.materials', "Materials"),
			getData: () => ({
				columns: [
					{ id: 'name', label: localize('col.name', "Material Name"), sortable: true, getValue: (m: IMaterialCard) => m.name },
					{ id: 'e', label: localize('col.e', "E (MPa)"), align: 'right', sortable: true, getValue: (m: IMaterialCard) => m.elasticModulus_MPa },
					{ id: 'nu', label: localize('col.nu', "Poisson's Ratio"), align: 'right', sortable: true, getValue: (m: IMaterialCard) => m.poissonsRatio },
					{ id: 'density', label: localize('col.density', "Density (tonne/mm³)"), align: 'right', sortable: true, getValue: (m: IMaterialCard) => m.density_tonne_mm3 },
					{ id: 'yield', label: localize('col.yield', "Yield Strength (MPa)"), align: 'right', sortable: true, getValue: (m: IMaterialCard) => m.yieldStrength_MPa ?? 'n/a' }
				],
				rows: materials
			})
		}));

		clearNode(this.contentContainer);

		if (this.viewMode === 'assigned') {
			const assignedList = materials.filter(m => m.id === 'structural_steel');
			if (assignedList.length === 0) {
				const empty = append(this.contentContainer, $('.ma-mat-empty-note', undefined, localize('mat.noAssigned', "No materials assigned to geometry bodies yet.")));
				empty.style.color = 'var(--ma-muted, var(--vscode-descriptionForeground))';
				empty.style.fontSize = 'var(--ma-font-s, 12px)';
				return;
			}
			this.renderCards(assignedList, true);
		} else {
			this.renderCards(materials, false);
		}

		// Initial selection
		if (materials.length > 0 && !this.selectedMaterialId) {
			this.selectMaterial(materials[0]);
		}
	}

	private renderCards(materials: readonly IMaterialCard[], isAssignedView: boolean): void {
		const grid = append(this.contentContainer, $('.ma-mat-grid'));

		for (const mat of materials) {
			const card = append(grid, $('.ma-mat-card'));
			if (this.selectedMaterialId === mat.id) {
				card.classList.add('selected');
			}

			const header = append(card, $('.ma-mat-card-header'));
			append(header, $('span.ma-mat-card-title', undefined, mat.name));

			if (mat.id === 'structural_steel' || isAssignedView) {
				append(header, $('span.ma-mat-card-badge', undefined, localize('mat.assignedBadge', "Assigned to Body")));
			}

			const props = append(card, $('.ma-mat-card-props'));
			const addProp = (name: string, val: string) => {
				const item = append(props, $('.ma-mat-prop-item'));
				append(item, $('span', undefined, `${name}:`));
				append(item, $('span.ma-mat-prop-value', undefined, val));
			};

			addProp("E", `${mat.elasticModulus_MPa.toLocaleString()} MPa`);
			addProp("ν", String(mat.poissonsRatio));
			addProp("Density", `${mat.density_tonne_mm3} tonne/mm³`);
			if (mat.yieldStrength_MPa) {
				addProp("Yield", `${mat.yieldStrength_MPa} MPa`);
			}

			this.inputDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
				for (const child of Array.from(grid.children)) {
					child.classList.remove('selected');
				}
				card.classList.add('selected');
				this.selectMaterial(mat);
			}));
		}
	}

	private selectMaterial(mat: IMaterialCard): void {
		this.selectedMaterialId = mat.id;
		this.propertiesDockService.setProperties({
			title: mat.name,
			detail: mat.id,
			rows: [
				{ name: localize('prop.modulus', "Young's Modulus (E)"), value: `${mat.elasticModulus_MPa.toLocaleString()} MPa` },
				{ name: localize('prop.poisson', "Poisson's Ratio (ν)"), value: String(mat.poissonsRatio) },
				{ name: localize('prop.density', "Density"), value: `${mat.density_tonne_mm3} tonne/mm³` },
				{ name: localize('prop.yield', "Yield Strength"), value: mat.yieldStrength_MPa ? `${mat.yieldStrength_MPa} MPa` : localize('prop.na', "n/a") },
				{ name: localize('prop.thermal', "Thermal Conductivity"), value: mat.thermalConductivity_W_mK ? `${mat.thermalConductivity_W_mK} W/(m·K)` : localize('prop.na', "n/a") },
				{ name: localize('prop.expansion', "Thermal Expansion"), value: mat.expansionCoefficient_perK ? `${mat.expansionCoefficient_perK} 1/K` : localize('prop.na', "n/a") },
			]
		});
	}

	private addMaterial(): void {
		this.notificationService.info(localize('mat.addInfo', "Material catalog: select a material card from the library."));
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
