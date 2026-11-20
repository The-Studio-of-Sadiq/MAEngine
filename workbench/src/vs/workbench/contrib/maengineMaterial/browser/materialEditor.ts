/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/materialEditor.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
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
	id: string;
	name: string;
	elasticModulus_MPa?: number;
	poissonsRatio?: number;
	density_tonne_mm3?: number;
	yieldStrength_MPa?: number;
	thermalConductivity_W_mK?: number;
	expansionCoefficient_perK?: number;
	[key: string]: unknown;
}

interface IMaterialsData {
	schema?: number;
	materials?: IMaterialCard[];
	[key: string]: unknown;
}

interface IGeometryBody {
	id: string;
	name?: string;
	material?: string | null;
	volume_mm3?: number;
	[key: string]: unknown;
}

interface IGeometryData {
	schema?: number;
	bodies?: IGeometryBody[];
	[key: string]: unknown;
}

interface ICardDomRefs {
	readonly card: HTMLElement;
	readonly badgeSlot: HTMLElement;
	readonly errorEl: HTMLElement;
	readonly fieldErrors: Map<string, string>;
}

const DENSITY_FACTOR = 1e12;

function toKgM3(tonnePerMm3: number): number {
	return Number((tonnePerMm3 * DENSITY_FACTOR).toPrecision(12));
}

function fromKgM3(kgPerM3: number): number {
	return Number((kgPerM3 / DENSITY_FACTOR).toPrecision(12));
}

function uniqueId(base: string, existingIds: ReadonlySet<string>): string {
	if (!existingIds.has(base)) {
		return base;
	}
	let suffix = 2;
	while (existingIds.has(`${base}_${suffix}`)) {
		suffix++;
	}
	return `${base}_${suffix}`;
}

export class MaterialEditor extends EditorPane {

	private frame!: EditorFrame;
	private viewMode: 'library' | 'assigned' = 'library';
	private contentContainer!: HTMLElement;
	private selectedMaterialId: string | undefined;

	private readonly inputDisposables = this._register(new DisposableStore());
	private renderDisposables: DisposableStore | undefined;
	private readonly _onDidChangeTableData = this._register(new Emitter<void>());

	private currentResource: URI | undefined;
	private geometryResource: URI | undefined;
	private currentData: IMaterialsData | undefined;
	private bodies: IGeometryBody[] = [];
	private lastWrittenMaterials: string | undefined;
	private lastWrittenGeometry: string | undefined;
	private cardDomRefs = new Map<string, ICardDomRefs>();
	private bodySelects: HTMLSelectElement[] = [];
	private pendingFocusMaterialId: string | undefined;

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
		this.renderDisposables = this.inputDisposables.add(new DisposableStore());

		const resource = (input as MaterialEditorInput).resource;
		this.currentResource = resource;
		this.geometryResource = resource ? joinPath(dirname(dirname(resource)), '02 Geometry', 'geometry.json') : undefined;
		this.lastWrittenMaterials = undefined;
		this.lastWrittenGeometry = undefined;

		if (resource && this.geometryResource) {
			const geometryUri = this.geometryResource;
			this.inputDisposables.add(MAEngineTables.registerTable<IMaterialCard>({
				id: 'maengine.materials.table',
				label: localize('table.materials', "Materials"),
				onDidChangeData: this._onDidChangeTableData.event,
				getData: () => ({
					columns: [
						{ id: 'name', label: localize('col.name', "Material Name"), sortable: true, getValue: m => m.name },
						{ id: 'e', label: localize('col.e', "E (MPa)"), align: 'right', sortable: true, getValue: m => m.elasticModulus_MPa ?? 'n/a' },
						{ id: 'nu', label: localize('col.nu', "Poisson's Ratio"), align: 'right', sortable: true, getValue: m => m.poissonsRatio ?? 'n/a' },
						{ id: 'density', label: localize('col.densityKg', "Density (kg/m³)"), align: 'right', sortable: true, getValue: m => m.density_tonne_mm3 !== undefined ? toKgM3(m.density_tonne_mm3) : 'n/a' },
						{ id: 'yield', label: localize('col.yield', "Yield Strength (MPa)"), align: 'right', sortable: true, getValue: m => m.yieldStrength_MPa ?? 'n/a' }
					],
					rows: this.currentData?.materials ?? [],
					emptyText: localize('table.materialsEmpty', "No materials defined yet.")
				})
			}));

			this.inputDisposables.add(this.fileService.onDidFilesChange(e => {
				const materialsChanged = e.contains(resource);
				const geometryChanged = e.contains(geometryUri);
				if (materialsChanged || geometryChanged) {
					void this.handleFilesChange(resource, geometryUri, materialsChanged, geometryChanged);
				}
			}));

			await this.loadAll(resource, geometryUri);
		}
	}

	override clearInput(): void {
		this.inputDisposables.clear();
		this.renderDisposables = undefined;
		this.currentResource = undefined;
		this.geometryResource = undefined;
		this.currentData = undefined;
		this.bodies = [];
		this.lastWrittenMaterials = undefined;
		this.lastWrittenGeometry = undefined;
		this.cardDomRefs.clear();
		this.bodySelects = [];
		this.propertiesDockService.clearProperties();
		super.clearInput();
	}

	override dispose(): void {
		this.propertiesDockService.clearProperties();
		super.dispose();
	}

	private async loadAll(resource: URI, geometryUri: URI): Promise<void> {
		await Promise.all([
			this.loadMaterials(resource),
			this.loadGeometry(geometryUri),
		]);
		this._onDidChangeTableData.fire();
		this.render();
	}

	private async handleFilesChange(resource: URI, geometryUri: URI, materialsChanged: boolean, geometryChanged: boolean): Promise<void> {
		let shouldRender = false;
		let materialsUpdated = false;

		if (materialsChanged) {
			try {
				const content = await this.fileService.readFile(resource);
				const text = content.value.toString();
				if (text !== this.lastWrittenMaterials) {
					this.currentData = JSON.parse(text) as IMaterialsData;
					shouldRender = true;
					materialsUpdated = true;
				}
			} catch {
				this.currentData = undefined;
				shouldRender = true;
				materialsUpdated = true;
			}
		}

		if (geometryChanged) {
			try {
				const content = await this.fileService.readFile(geometryUri);
				const text = content.value.toString();
				if (text !== this.lastWrittenGeometry) {
					const parsed = JSON.parse(text) as IGeometryData;
					this.bodies = Array.isArray(parsed?.bodies) ? parsed.bodies : [];
					shouldRender = true;
				}
			} catch {
				this.bodies = [];
				shouldRender = true;
			}
		}

		if (materialsUpdated) {
			this._onDidChangeTableData.fire();
		}
		if (shouldRender) {
			this.render();
		}
	}

	private async loadMaterials(resource: URI): Promise<void> {
		try {
			const content = await this.fileService.readFile(resource);
			this.currentData = JSON.parse(content.value.toString()) as IMaterialsData;
		} catch {
			this.currentData = undefined;
		}
	}

	private async loadGeometry(geometryUri: URI): Promise<void> {
		try {
			const content = await this.fileService.readFile(geometryUri);
			const geom = JSON.parse(content.value.toString()) as IGeometryData;
			this.bodies = Array.isArray(geom?.bodies) ? geom.bodies : [];
		} catch {
			this.bodies = [];
		}
	}

	private getBodiesUsingMaterial(materialId: string): IGeometryBody[] {
		return this.bodies.filter(b => b.material === materialId);
	}

	private updateStatus(): void {
		const count = this.currentData?.materials?.length ?? 0;
		if (count === 0) {
			this.frame.setStatus({
				text: localize('mat.emptyStatus', "No materials defined"),
				link: { label: localize('mat.addAction', "Add material"), run: () => void this.addMaterial() }
			});
			return;
		}
		this.frame.setStatus({
			text: count === 1
				? localize('mat.statusOne', "1 material defined in study library")
				: localize('mat.status', "{0} materials defined in study library", count)
		});
	}

	private render(): void {
		this.renderDisposables?.clear();
		this.cardDomRefs.clear();
		this.bodySelects = [];
		clearNode(this.contentContainer);

		const materials = this.currentData?.materials ?? [];
		this.updateStatus();

		if (materials.length === 0) {
			this.frame.setEmpty({
				icon: Codicon.library,
				title: localize('mat.emptyTitle', "No materials yet"),
				text: localize('mat.emptyText', "Add a material card to configure study properties."),
				actions: [{
					label: localize('mat.addAction', "Add material"),
					primary: true,
					run: () => void this.addMaterial()
				}]
			});
			this.selectedMaterialId = undefined;
			this.propertiesDockService.clearProperties();
			return;
		}

		this.frame.setEmpty(undefined);

		// Material cards section
		const cardsSec = append(this.contentContainer, $('.ma-mat-section'));
		const cardsHeader = append(cardsSec, $('.ma-mat-section-header'));
		append(cardsHeader, $('.ma-mat-section-title', undefined, localize('mat.cardsTitle', "Material cards")));
		const addBtn = append(cardsHeader, $<HTMLButtonElement>('button.monaco-button.ma-mat-add-btn', { type: 'button' }));
		append(addBtn, $(ThemeIcon.asCSSSelector(Codicon.add)));
		append(addBtn, $('span', undefined, localize('mat.addAction', "Add material")));
		this.renderDisposables?.add(addDisposableListener(addBtn, EventType.CLICK, () => void this.addMaterial()));

		if (this.viewMode === 'assigned') {
			const assignedList = materials.filter(m => this.getBodiesUsingMaterial(m.id).length > 0);
			if (assignedList.length === 0) {
				append(cardsSec, $('.ma-mat-empty-note', undefined, localize('mat.noAssigned', "No materials assigned to geometry bodies yet.")));
			} else {
				this.renderCards(cardsSec, assignedList);
			}
		} else {
			this.renderCards(cardsSec, materials);
		}

		// Body assignments section
		this.renderBodyAssignments(materials);

		// Maintain or initialize selection
		const selected = materials.find(m => m.id === this.selectedMaterialId) ?? materials[0];
		if (selected) {
			this.selectMaterial(selected);
		} else {
			this.selectedMaterialId = undefined;
			this.propertiesDockService.clearProperties();
		}
	}

	private renderCards(parent: HTMLElement, materials: readonly IMaterialCard[]): void {
		const grid = append(parent, $('.ma-mat-grid'));

		for (const mat of materials) {
			const card = append(grid, $('.ma-mat-card'));
			if (this.selectedMaterialId === mat.id) {
				card.classList.add('selected');
			}

			const header = append(card, $('.ma-mat-card-header'));
			const titleGroup = append(header, $('.ma-mat-card-title-group'));

			const nameInput = append(titleGroup, $<HTMLInputElement>('input.ma-mat-input.ma-mat-name-input', {
				type: 'text',
				value: mat.name ?? '',
				placeholder: localize('mat.namePlaceholder', "Material name"),
				'aria-label': localize('mat.nameAria', "Material name")
			}));
			nameInput.value = mat.name ?? '';

			append(titleGroup, $('span.ma-mat-card-id', { title: localize('mat.idTitle', "Material ID (referenced by bodies)") }, mat.id));

			const headerRight = append(header, $('.ma-mat-card-header-right'));
			const badgeSlot = append(headerRight, $('.ma-mat-card-badge-slot'));

			const dupBtn = append(headerRight, $<HTMLButtonElement>('button.ma-mat-action-btn', {
				type: 'button',
				title: localize('mat.duplicateTitle', "Duplicate material")
			}));
			append(dupBtn, $(ThemeIcon.asCSSSelector(Codicon.copy)));
			append(dupBtn, $('span', undefined, localize('mat.duplicate', "Duplicate")));

			const delBtn = append(headerRight, $<HTMLButtonElement>('button.ma-mat-action-btn.ma-mat-delete-btn', {
				type: 'button',
				title: localize('mat.deleteTitle', "Delete material")
			}));
			append(delBtn, $(ThemeIcon.asCSSSelector(Codicon.trash)));
			append(delBtn, $('span', undefined, localize('mat.delete', "Delete")));

			const fieldsGrid = append(card, $('.ma-mat-fields-grid'));
			const errorEl = append(card, $('.ma-mat-card-error'));

			const refs: ICardDomRefs = {
				card,
				badgeSlot,
				errorEl,
				fieldErrors: new Map<string, string>()
			};
			this.cardDomRefs.set(mat.id, refs);
			this.updateCardBadge(mat.id);

			this.bindCommit(nameInput, raw => {
				const trimmed = raw.trim();
				if (!trimmed) {
					return localize('mat.errName', "Material name cannot be empty.");
				}
				mat.name = trimmed;
				this.refreshBodySelectOptionName(mat.id, trimmed);
				return undefined;
			}, 'name', refs, mat);

			this.addNumericField(fieldsGrid, {
				key: 'elasticModulus_MPa',
				label: localize('mat.fieldModulus', "Young's modulus (MPa)"),
				initialValue: mat.elasticModulus_MPa,
				validate: raw => {
					const trimmed = raw.trim();
					if (!trimmed) {
						return { error: localize('mat.errModulusRequired', "Young's modulus is required and must be > 0.") };
					}
					const val = Number(trimmed);
					if (!Number.isFinite(val) || val <= 0) {
						return { error: localize('mat.errModulusPositive', "Young's modulus must be > 0.") };
					}
					return { value: val };
				},
				apply: val => {
					mat.elasticModulus_MPa = val;
				}
			}, refs, mat);

			this.addNumericField(fieldsGrid, {
				key: 'poissonsRatio',
				label: localize('mat.fieldPoisson', "Poisson's ratio (ν)"),
				initialValue: mat.poissonsRatio,
				validate: raw => {
					const trimmed = raw.trim();
					if (!trimmed) {
						return { error: localize('mat.errPoissonRequired', "Poisson's ratio is required (0 <= ν < 0.5).") };
					}
					const val = Number(trimmed);
					if (!Number.isFinite(val) || val < 0 || val >= 0.5) {
						return { error: localize('mat.errPoissonRange', "Poisson's ratio must satisfy 0 <= ν < 0.5.") };
					}
					return { value: val };
				},
				apply: val => {
					mat.poissonsRatio = val;
				}
			}, refs, mat);

			this.addNumericField(fieldsGrid, {
				key: 'density_tonne_mm3',
				label: localize('mat.fieldDensity', "Density (kg/m³)"),
				initialValue: mat.density_tonne_mm3 !== undefined ? toKgM3(mat.density_tonne_mm3) : undefined,
				validate: raw => {
					const trimmed = raw.trim();
					if (!trimmed) {
						return { error: localize('mat.errDensityRequired', "Density is required and must be >= 0.") };
					}
					const val = Number(trimmed);
					if (!Number.isFinite(val) || val < 0) {
						return { error: localize('mat.errDensityNonNeg', "Density must be >= 0.") };
					}
					return { value: fromKgM3(val) };
				},
				apply: val => {
					mat.density_tonne_mm3 = val;
				}
			}, refs, mat);

			this.addNumericField(fieldsGrid, {
				key: 'yieldStrength_MPa',
				label: localize('mat.fieldYield', "Yield strength (MPa)"),
				initialValue: mat.yieldStrength_MPa,
				validate: raw => {
					const trimmed = raw.trim();
					if (!trimmed) {
						return { value: undefined };
					}
					const val = Number(trimmed);
					if (!Number.isFinite(val) || val <= 0) {
						return { error: localize('mat.errYieldPositive', "Yield strength must be > 0 or blank.") };
					}
					return { value: val };
				},
				apply: val => {
					if (val === undefined) {
						delete mat.yieldStrength_MPa;
					} else {
						mat.yieldStrength_MPa = val;
					}
				}
			}, refs, mat);

			this.addNumericField(fieldsGrid, {
				key: 'thermalConductivity_W_mK',
				label: localize('mat.fieldThermal', "Thermal conductivity (W/m·K)"),
				initialValue: mat.thermalConductivity_W_mK,
				validate: raw => {
					const trimmed = raw.trim();
					if (!trimmed) {
						return { value: undefined };
					}
					const val = Number(trimmed);
					if (!Number.isFinite(val) || val < 0) {
						return { error: localize('mat.errThermalNonNeg', "Thermal conductivity must be >= 0 or blank.") };
					}
					return { value: val };
				},
				apply: val => {
					if (val === undefined) {
						delete mat.thermalConductivity_W_mK;
					} else {
						mat.thermalConductivity_W_mK = val;
					}
				}
			}, refs, mat);

			this.addNumericField(fieldsGrid, {
				key: 'expansionCoefficient_perK',
				label: localize('mat.fieldExpansion', "Expansion coefficient (1/K)"),
				initialValue: mat.expansionCoefficient_perK,
				validate: raw => {
					const trimmed = raw.trim();
					if (!trimmed) {
						return { value: undefined };
					}
					const val = Number(trimmed);
					if (!Number.isFinite(val) || val < 0) {
						return { error: localize('mat.errExpansionNonNeg', "Expansion coefficient must be >= 0 or blank.") };
					}
					return { value: val };
				},
				apply: val => {
					if (val === undefined) {
						delete mat.expansionCoefficient_perK;
					} else {
						mat.expansionCoefficient_perK = val;
					}
				}
			}, refs, mat);

			this.renderDisposables?.add(addDisposableListener(dupBtn, EventType.CLICK, e => {
				e.stopPropagation();
				void this.duplicateMaterial(mat);
			}));

			this.renderDisposables?.add(addDisposableListener(delBtn, EventType.CLICK, e => {
				e.stopPropagation();
				void this.deleteMaterial(mat, refs);
			}));

			this.renderDisposables?.add(addDisposableListener(card, EventType.CLICK, () => {
				for (const entry of this.cardDomRefs.values()) {
					entry.card.classList.remove('selected');
				}
				card.classList.add('selected');
				this.selectMaterial(mat);
			}));

			if (this.pendingFocusMaterialId === mat.id) {
				this.pendingFocusMaterialId = undefined;
				card.scrollIntoView({ block: 'nearest' });
				nameInput.focus();
				nameInput.select();
			}
		}
	}

	private addNumericField(
		parent: HTMLElement,
		spec: {
			readonly key: string;
			readonly label: string;
			readonly initialValue: number | undefined;
			readonly validate: (raw: string) => { value?: number; error?: string };
			readonly apply: (val: number | undefined) => void;
		},
		refs: ICardDomRefs,
		mat: IMaterialCard
	): void {
		const field = append(parent, $('.ma-mat-field'));
		append(field, $('label.ma-mat-field-label', undefined, spec.label));
		const input = append(field, $<HTMLInputElement>('input.ma-mat-input', {
			type: 'text',
			inputmode: 'decimal',
			'aria-label': spec.label
		}));
		input.value = spec.initialValue !== undefined ? String(spec.initialValue) : '';

		this.bindCommit(input, raw => {
			const res = spec.validate(raw);
			if (res.error) {
				return res.error;
			}
			spec.apply(res.value);
			return undefined;
		}, spec.key, refs, mat);
	}

	private bindCommit(
		input: HTMLInputElement,
		applyValue: (raw: string) => string | undefined,
		fieldKey: string,
		refs: ICardDomRefs,
		mat: IMaterialCard
	): void {
		let lastProcessed = input.value;
		const commit = () => {
			const raw = input.value;
			if (raw === lastProcessed) {
				return;
			}
			lastProcessed = raw;
			refs.fieldErrors.delete('__delete');
			const err = applyValue(raw);
			if (err) {
				input.classList.add('error');
				refs.fieldErrors.set(fieldKey, err);
				this.updateCardError(refs);
				return;
			}
			input.classList.remove('error');
			refs.fieldErrors.delete(fieldKey);
			this.updateCardError(refs);

			if (this.selectedMaterialId === mat.id) {
				this.selectMaterial(mat);
			}
			this._onDidChangeTableData.fire();
			void this.saveMaterials();
		};

		this.renderDisposables?.add(addDisposableListener(input, EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				commit();
			}
		}));
		this.renderDisposables?.add(addDisposableListener(input, EventType.CHANGE, () => {
			commit();
		}));
	}

	private updateCardError(refs: ICardDomRefs): void {
		const messages = Array.from(refs.fieldErrors.values());
		refs.errorEl.textContent = messages.join(' ');
		refs.errorEl.classList.toggle('visible', messages.length > 0);
	}

	private updateCardBadge(materialId: string): void {
		const refs = this.cardDomRefs.get(materialId);
		if (!refs) {
			return;
		}
		clearNode(refs.badgeSlot);
		const usedBy = this.getBodiesUsingMaterial(materialId);
		if (usedBy.length > 0) {
			const names = usedBy.map(b => b.name || b.id).join(', ');
			append(refs.badgeSlot, $('span.ma-mat-card-badge', undefined, localize('mat.usedByBadge', "Used by {0}", names)));
		}
	}

	private refreshBodySelectOptionName(materialId: string, newName: string): void {
		for (const select of this.bodySelects) {
			for (const opt of Array.from(select.options)) {
				if (opt.value === materialId) {
					opt.textContent = newName;
				}
			}
		}
	}

	private renderBodyAssignments(materials: readonly IMaterialCard[]): void {
		const sec = append(this.contentContainer, $('.ma-mat-section'));
		append(sec, $('.ma-mat-section-title', undefined, localize('mat.bodyAssignments', "Body assignments")));

		if (this.bodies.length === 0) {
			append(sec, $('.ma-mat-empty-note', undefined, localize('mat.noBodies', "No bodies yet. Read the model in the Geometry editor to list them.")));
			return;
		}

		const list = append(sec, $('.ma-mat-body-list'));
		this.bodies.forEach((body, idx) => {
			const row = append(list, $('.ma-mat-body-row'));
			append(row, $('span.ma-mat-body-name', undefined, body.name || body.id));
			const volText = body.volume_mm3 !== undefined && Number.isFinite(body.volume_mm3)
				? localize('mat.bodyVolume', "{0} mm³", Number(body.volume_mm3.toPrecision(6)).toLocaleString())
				: localize('mat.volumeUnknown', "—");
			append(row, $('span.ma-mat-body-volume', undefined, volText));

			const select = append(row, $<HTMLSelectElement>('select.ma-mat-select', {
				'aria-label': localize('mat.assignAria', "Material for {0}", body.name || body.id)
			}));
			this.bodySelects.push(select);

			append(select, $<HTMLOptionElement>('option', { value: '' }, localize('mat.notAssigned', "(not assigned)")));
			for (const mat of materials) {
				append(select, $<HTMLOptionElement>('option', { value: mat.id }, mat.name || mat.id));
			}

			const currentMat = body.material ?? '';
			if (currentMat && !materials.some(m => m.id === currentMat)) {
				append(select, $<HTMLOptionElement>('option', { value: currentMat }, localize('mat.missingMaterial', "{0} (missing)", currentMat)));
			}
			select.value = currentMat;

			this.renderDisposables?.add(addDisposableListener(select, EventType.CHANGE, () => {
				const nextMaterial = select.value === '' ? null : select.value;
				void this.assignBodyMaterial(body.id, idx, nextMaterial);
			}));
		});

		append(sec, $('.ma-mat-assignments-note', undefined, localize('mat.unassignedFallbackNote', "Bodies without a material use the first card.")));
	}

	private async assignBodyMaterial(bodyId: string, bodyIndex: number, materialId: string | null): Promise<void> {
		if (!this.geometryResource) {
			return;
		}
		try {
			const content = await this.fileService.readFile(this.geometryResource);
			const geomData = JSON.parse(content.value.toString()) as IGeometryData;
			if (!Array.isArray(geomData.bodies)) {
				return;
			}
			const idx = geomData.bodies[bodyIndex]?.id === bodyId
				? bodyIndex
				: geomData.bodies.findIndex(b => b.id === bodyId);
			if (idx < 0) {
				return;
			}
			geomData.bodies[idx].material = materialId;
			this.bodies = geomData.bodies;

			const text = JSON.stringify(geomData, null, '\t') + '\n';
			this.lastWrittenGeometry = text;
			await this.fileService.writeFile(this.geometryResource, VSBuffer.fromString(text));

			for (const mat of this.currentData?.materials ?? []) {
				this.updateCardBadge(mat.id);
			}
			const selected = this.currentData?.materials?.find(m => m.id === this.selectedMaterialId);
			if (selected) {
				this.selectMaterial(selected);
			}
		} catch (err) {
			this.lastWrittenGeometry = undefined;
			this.notificationService.error(localize('mat.saveGeometryError', "Failed to save body assignment: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	private selectMaterial(mat: IMaterialCard): void {
		this.selectedMaterialId = mat.id;
		const na = localize('prop.na', "n/a");
		const usedBy = this.getBodiesUsingMaterial(mat.id);
		this.propertiesDockService.setProperties({
			title: mat.name || mat.id,
			detail: mat.id,
			rows: [
				{ name: localize('prop.modulus', "Young's Modulus (E)"), value: mat.elasticModulus_MPa !== undefined ? `${mat.elasticModulus_MPa.toLocaleString()} MPa` : na },
				{ name: localize('prop.poisson', "Poisson's Ratio (ν)"), value: mat.poissonsRatio !== undefined ? String(mat.poissonsRatio) : na },
				{ name: localize('prop.densityKg', "Density"), value: mat.density_tonne_mm3 !== undefined ? `${toKgM3(mat.density_tonne_mm3).toLocaleString()} kg/m³` : na },
				{ name: localize('prop.yield', "Yield Strength"), value: mat.yieldStrength_MPa !== undefined ? `${mat.yieldStrength_MPa.toLocaleString()} MPa` : na },
				{ name: localize('prop.thermal', "Thermal Conductivity"), value: mat.thermalConductivity_W_mK !== undefined ? `${mat.thermalConductivity_W_mK} W/(m·K)` : na },
				{ name: localize('prop.expansion', "Thermal Expansion"), value: mat.expansionCoefficient_perK !== undefined ? `${mat.expansionCoefficient_perK} 1/K` : na },
				{ name: localize('prop.usedBy', "Used by"), value: usedBy.length > 0 ? usedBy.map(b => b.name || b.id).join(', ') : localize('prop.none', "None") },
			]
		});
	}

	private ensureDataObject(): IMaterialsData {
		if (!this.currentData) {
			this.currentData = { schema: 1, materials: [] };
		}
		if (this.currentData.schema === undefined) {
			this.currentData.schema = 1;
		}
		if (!Array.isArray(this.currentData.materials)) {
			this.currentData.materials = [];
		}
		return this.currentData;
	}

	private async addMaterial(): Promise<void> {
		if (!this.currentResource) {
			return;
		}
		const data = this.ensureDataObject();
		const materials = data.materials!;
		const existingIds = new Set(materials.map(m => m.id));
		const id = uniqueId('new_material', existingIds);
		const newMat: IMaterialCard = {
			id,
			name: localize('mat.newMaterialName', "New material")
		};
		materials.push(newMat);

		this.viewMode = 'library';
		this.selectedMaterialId = id;
		this.pendingFocusMaterialId = id;

		await this.saveMaterials();
		this._onDidChangeTableData.fire();
		this.render();
	}

	private async duplicateMaterial(mat: IMaterialCard): Promise<void> {
		if (!this.currentResource) {
			return;
		}
		const data = this.ensureDataObject();
		const materials = data.materials!;
		const existingIds = new Set(materials.map(m => m.id));
		const id = uniqueId(`${mat.id}_copy`, existingIds);
		const cloned = JSON.parse(JSON.stringify(mat)) as IMaterialCard;
		cloned.id = id;
		cloned.name = localize('mat.copyName', "{0} (copy)", mat.name || mat.id);
		materials.push(cloned);

		this.viewMode = 'library';
		this.selectedMaterialId = id;
		this.pendingFocusMaterialId = id;

		await this.saveMaterials();
		this._onDidChangeTableData.fire();
		this.render();
	}

	private async deleteMaterial(mat: IMaterialCard, refs: ICardDomRefs): Promise<void> {
		const usedBy = this.getBodiesUsingMaterial(mat.id);
		if (usedBy.length > 0) {
			const bodyNames = usedBy.map(b => b.name || b.id).join(', ');
			refs.fieldErrors.set('__delete', localize('mat.deleteInUse', "Cannot delete: used by {0}.", bodyNames));
			this.updateCardError(refs);
			return;
		}
		if (!this.currentData?.materials || !this.currentResource) {
			return;
		}
		this.currentData.materials = this.currentData.materials.filter(m => m.id !== mat.id);
		if (this.selectedMaterialId === mat.id) {
			this.selectedMaterialId = this.currentData.materials[0]?.id;
		}

		await this.saveMaterials();
		this._onDidChangeTableData.fire();
		this.render();
	}

	private async saveMaterials(): Promise<void> {
		if (!this.currentData || !this.currentResource) {
			return;
		}
		if (this.currentData.schema === undefined) {
			this.currentData.schema = 1;
		}
		const text = JSON.stringify(this.currentData, null, '\t') + '\n';
		this.lastWrittenMaterials = text;
		try {
			await this.fileService.writeFile(this.currentResource, VSBuffer.fromString(text));
		} catch (err) {
			this.lastWrittenMaterials = undefined;
			this.notificationService.error(localize('mat.saveError', "Failed to save materials: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
