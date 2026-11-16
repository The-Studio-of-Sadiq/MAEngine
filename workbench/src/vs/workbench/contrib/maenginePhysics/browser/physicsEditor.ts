/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/physicsEditor.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
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
import { PhysicsEditorInput } from './physicsEditorInput.js';

interface IConstraint {
	id: string;
	type: string;
	selector: string;
	ux?: number | null;
	uy?: number | null;
	uz?: number | null;
}

interface ILoad {
	id: string;
	type: string;
	selector: string;
	vector?: number[];
	magnitude?: number;
}

interface IPhysicsData {
	schema?: number;
	constraints?: IConstraint[];
	loads?: ILoad[];
	gravity?: number[] | null;
}

interface IGeometryData {
	selectors?: { name?: string }[];
}

export class PhysicsEditor extends EditorPane {

	private frame!: EditorFrame;
	private contentContainer!: HTMLElement;
	private currentData: IPhysicsData | undefined;
	private currentResource: URI | undefined;
	private selectedId: string | undefined;
	private selectorNames: string[] = [];
	private lastWritten: string | undefined;
	private tableRegistration: IDisposable | undefined;

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
		super(PhysicsEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.frame = this._register(this.instantiationService.createInstance(EditorFrame, parent, {
			id: 'maengine.physicsEditor',
			ariaLabel: localize('physicsEditor.aria', "Boundary Conditions & Loads"),
			properties: { title: localize('properties', "Properties") }
		}));
		this.frame.element.classList.add('maengine-physics-editor');
		this.frame.setTitle(localize('physics.title', "Boundary Conditions & Loads"));
		this.frame.setActions([this.frame.togglePropertiesAction]);

		this.contentContainer = append(this.frame.main, $('.ma-physics-content'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();

		const resource = (input as PhysicsEditorInput).resource;
		this.currentResource = resource;
		if (resource) {
			const geometryUri = joinPath(dirname(dirname(resource)), '02 Geometry', 'geometry.json');
			this.inputDisposables.add(this.fileService.onDidFilesChange(async e => {
				if (e.contains(resource) || e.contains(geometryUri)) {
					const geometryChanged = e.contains(geometryUri);
					const physicsChanged = e.contains(resource);
					if (physicsChanged) {
						try {
							const content = await this.fileService.readFile(resource);
							const text = content.value.toString();
							if (text === this.lastWritten) {
								if (!geometryChanged) {
									return;
								}
							} else {
								this.currentData = JSON.parse(text) as IPhysicsData;
							}
						} catch {
							this.currentData = undefined;
						}
					}
					if (geometryChanged) {
						await this.loadGeometry(resource);
					}
					this.render();
				}
			}));
			await this.load(resource);
		}
	}

	override clearInput(): void {
		this.inputDisposables.clear();
		this.tableRegistration?.dispose();
		this.tableRegistration = undefined;
		this.propertiesDockService.clearProperties();
		super.clearInput();
	}

	override dispose(): void {
		this.tableRegistration?.dispose();
		this.tableRegistration = undefined;
		this.propertiesDockService.clearProperties();
		super.dispose();
	}

	private async load(resource: URI): Promise<void> {
		try {
			const content = await this.fileService.readFile(resource);
			this.currentData = JSON.parse(content.value.toString()) as IPhysicsData;
		} catch {
			this.currentData = undefined;
		}
		await this.loadGeometry(resource);
		this.render();
	}

	private async loadGeometry(resource: URI): Promise<void> {
		try {
			const geometryUri = joinPath(dirname(dirname(resource)), '02 Geometry', 'geometry.json');
			const content = await this.fileService.readFile(geometryUri);
			const geomData = JSON.parse(content.value.toString()) as IGeometryData;
			if (Array.isArray(geomData?.selectors)) {
				this.selectorNames = geomData.selectors
					.map(s => s?.name)
					.filter((n): n is string => typeof n === 'string');
			} else {
				this.selectorNames = [];
			}
		} catch {
			this.selectorNames = [];
		}
	}

	private render(): void {
		const data = this.currentData ?? {};
		const constraints = data.constraints ?? [];
		const loads = data.loads ?? [];

		// Bottom Hint Strip
		const bcCount = constraints.length;
		const loadCount = loads.length;
		this.frame.setStatus({
			text: localize('physics.status', "{0} {1}, {2} {3} defined",
				bcCount, bcCount === 1 ? 'boundary condition' : 'boundary conditions',
				loadCount, loadCount === 1 ? 'load' : 'loads')
		});

		// Register BC/Load table to bottom Tables panel
		if (this.tableRegistration) {
			this.tableRegistration.dispose();
		}
		this.tableRegistration = MAEngineTables.registerTable({
			id: 'maengine.physics.table',
			label: localize('table.physics', "Boundary Conditions & Loads"),
			getData: () => ({
				columns: [
					{ id: 'id', label: localize('col.id', "ID"), sortable: true, getValue: r => r.id },
					{ id: 'kind', label: localize('col.kind', "Category"), sortable: true, getValue: r => r.kind },
					{ id: 'type', label: localize('col.type', "Type"), sortable: true, getValue: r => r.type },
					{ id: 'selector', label: localize('col.selector', "Target Selector"), sortable: true, getValue: r => r.selector },
					{ id: 'value', label: localize('col.value', "Value"), sortable: true, getValue: r => r.value }
				],
				rows: this.getTableRows(),
				emptyText: localize('table.physicsEmpty', "No boundary conditions or loads configured yet.")
			})
		});
		this.inputDisposables.add(this.tableRegistration);

		clearNode(this.contentContainer);

		// Section 1: Boundary Conditions
		const bcSec = append(this.contentContainer, $('.ma-physics-section'));
		const bcHead = append(bcSec, $('.ma-physics-header-row'));
		append(bcHead, $('.ma-physics-section-title', undefined, localize('physics.bcTitle', "Boundary Conditions")));
		const addBcBtn = append(bcHead, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('physics.addConstraint', "Add constraint")));
		addBcBtn.style.padding = '2px 8px';
		addBcBtn.style.fontSize = 'var(--ma-font-xs, 11px)';

		this.inputDisposables.add(addDisposableListener(addBcBtn, EventType.CLICK, () => this.addConstraint()));

		if (this.selectorNames.length === 0) {
			append(bcSec, $('.ma-physics-no-selectors-notice', undefined, localize('physics.defineSelectorsFirst', "Define face selectors in the Geometry editor first.")));
		}

		const bcList = append(bcSec, $('.ma-physics-list'));
		if (constraints.length === 0) {
			append(bcList, $('.ma-physics-empty-notice', undefined, localize('physics.noBc', "No boundary conditions defined yet.")));
		} else {
			for (const bc of constraints) {
				const row = append(bcList, $('.ma-physics-item-row'));
				if (this.selectedId === bc.id) {
					row.classList.add('selected');
				}

				this.inputDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
					this.clearSelections(this.contentContainer);
					row.classList.add('selected');
					this.selectConstraint(bc);
				}));

				// ID label
				append(row, $('span.ma-physics-row-id', undefined, bc.id));

				// Type <select>
				const typeSelect = append(row, $<HTMLSelectElement>('select.ma-physics-select'));
				append(typeSelect, $<HTMLOptionElement>('option', { value: 'fixed' }, localize('physics.fixedSupport', "Fixed support")));
				append(typeSelect, $<HTMLOptionElement>('option', { value: 'displacement' }, localize('physics.prescribedDisplacement', "Prescribed displacement")));
				typeSelect.value = bc.type === 'displacement' ? 'displacement' : 'fixed';

				// Selector <select>
				const selectorSelect = append(row, this.createSelectorSelect(bc.selector));

				// For displacement, three number inputs ux, uy, uz
				let dispInputs: { inputUx: HTMLInputElement; inputUy: HTMLInputElement; inputUz: HTMLInputElement } | undefined;
				if (bc.type === 'displacement') {
					const group = append(row, $('.ma-physics-inline-group'));
					append(group, $('label.ma-physics-field-label', undefined, 'ux'));
					const inputUx = append(group, $<HTMLInputElement>('input.ma-physics-number-input', {
						type: 'number',
						step: 'any',
						placeholder: localize('physics.free', "free"),
						value: typeof bc.ux === 'number' ? String(bc.ux) : ''
					}));
					append(group, $('label.ma-physics-field-label', undefined, 'uy'));
					const inputUy = append(group, $<HTMLInputElement>('input.ma-physics-number-input', {
						type: 'number',
						step: 'any',
						placeholder: localize('physics.free', "free"),
						value: typeof bc.uy === 'number' ? String(bc.uy) : ''
					}));
					append(group, $('label.ma-physics-field-label', undefined, 'uz'));
					const inputUz = append(group, $<HTMLInputElement>('input.ma-physics-number-input', {
						type: 'number',
						step: 'any',
						placeholder: localize('physics.free', "free"),
						value: typeof bc.uz === 'number' ? String(bc.uz) : ''
					}));
					append(group, $('span.ma-physics-unit', undefined, 'mm'));
					dispInputs = { inputUx, inputUy, inputUz };
				}

				// Status element for warnings / errors
				const statusEl = append(row, $('span.ma-physics-row-status'));

				const updateConstraintRowStatus = (): boolean => {
					if (dispInputs) {
						const resX = this.parseNumberInput(dispInputs.inputUx, true);
						const resY = this.parseNumberInput(dispInputs.inputUy, true);
						const resZ = this.parseNumberInput(dispInputs.inputUz, true);
						dispInputs.inputUx.classList.toggle('error', !resX.valid);
						dispInputs.inputUy.classList.toggle('error', !resY.valid);
						dispInputs.inputUz.classList.toggle('error', !resZ.valid);
						if (!resX.valid || !resY.valid || !resZ.valid) {
							statusEl.textContent = localize('physics.invalidNumber', "Invalid number");
							statusEl.className = 'ma-physics-row-status ma-physics-row-error';
							return false;
						}
					}
					const warn = this.getConstraintWarning(bc);
					if (warn) {
						statusEl.textContent = warn;
						statusEl.className = 'ma-physics-row-status ma-physics-row-warning';
					} else {
						statusEl.textContent = '';
						statusEl.className = 'ma-physics-row-status';
					}
					return true;
				};

				// Trash button
				const delBtn = append(row, $<HTMLButtonElement>('button.ma-physics-remove-btn', { type: 'button', 'aria-label': localize('physics.remove', "Remove") }));
				append(delBtn, $(ThemeIcon.asCSSSelector(Codicon.trash)));

				this.inputDisposables.add(addDisposableListener(delBtn, EventType.CLICK, e => {
					e.stopPropagation();
					this.removeConstraint(bc.id);
				}));

				// Event listeners
				this.inputDisposables.add(addDisposableListener(typeSelect, EventType.CHANGE, async () => {
					const newType = typeSelect.value;
					if (newType !== bc.type) {
						if (newType === 'fixed') {
							bc.type = 'fixed';
							delete bc.ux;
							delete bc.uy;
							delete bc.uz;
						} else {
							bc.type = 'displacement';
							bc.ux = 0;
							bc.uy = 0;
							bc.uz = 0;
						}
						await this.saveData();
						this.render();
					}
				}));

				this.inputDisposables.add(addDisposableListener(selectorSelect, EventType.CHANGE, async () => {
					bc.selector = selectorSelect.value;
					if (updateConstraintRowStatus()) {
						await this.saveData();
						if (this.selectedId === bc.id) {
							this.selectConstraint(bc);
						}
					}
				}));

				if (dispInputs) {
					const handleNumberChange = async () => {
						if (!dispInputs) {
							return;
						}
						const resX = this.parseNumberInput(dispInputs.inputUx, true);
						const resY = this.parseNumberInput(dispInputs.inputUy, true);
						const resZ = this.parseNumberInput(dispInputs.inputUz, true);
						if (!resX.valid || !resY.valid || !resZ.valid) {
							updateConstraintRowStatus();
							return;
						}
						bc.ux = resX.value;
						bc.uy = resY.value;
						bc.uz = resZ.value;
						updateConstraintRowStatus();
						await this.saveData();
						if (this.selectedId === bc.id) {
							this.selectConstraint(bc);
						}
					};
					this.inputDisposables.add(addDisposableListener(dispInputs.inputUx, EventType.CHANGE, handleNumberChange));
					this.inputDisposables.add(addDisposableListener(dispInputs.inputUy, EventType.CHANGE, handleNumberChange));
					this.inputDisposables.add(addDisposableListener(dispInputs.inputUz, EventType.CHANGE, handleNumberChange));
				}

				updateConstraintRowStatus();
			}
		}

		// Section 2: Applied Loads
		const loadSec = append(this.contentContainer, $('.ma-physics-section'));
		const loadHead = append(loadSec, $('.ma-physics-header-row'));
		append(loadHead, $('.ma-physics-section-title', undefined, localize('physics.loadsTitle', "Applied Loads")));
		const addLoadBtn = append(loadHead, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('physics.addLoad', "Add load")));
		addLoadBtn.style.padding = '2px 8px';
		addLoadBtn.style.fontSize = 'var(--ma-font-xs, 11px)';

		this.inputDisposables.add(addDisposableListener(addLoadBtn, EventType.CLICK, () => this.addLoad()));

		if (this.selectorNames.length === 0) {
			append(loadSec, $('.ma-physics-no-selectors-notice', undefined, localize('physics.defineSelectorsFirst', "Define face selectors in the Geometry editor first.")));
		}

		const loadList = append(loadSec, $('.ma-physics-list'));
		if (loads.length === 0) {
			append(loadList, $('.ma-physics-empty-notice', undefined, localize('physics.noLoads', "No mechanical loads applied yet.")));
		} else {
			for (const load of loads) {
				const row = append(loadList, $('.ma-physics-item-row'));
				if (this.selectedId === load.id) {
					row.classList.add('selected');
				}

				this.inputDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
					this.clearSelections(this.contentContainer);
					row.classList.add('selected');
					this.selectLoad(load);
				}));

				// ID label
				append(row, $('span.ma-physics-row-id', undefined, load.id));

				// Type <select>
				const typeSelect = append(row, $<HTMLSelectElement>('select.ma-physics-select'));
				append(typeSelect, $<HTMLOptionElement>('option', { value: 'force' }, localize('physics.force', "Force")));
				append(typeSelect, $<HTMLOptionElement>('option', { value: 'pressure' }, localize('physics.pressure', "Pressure")));
				typeSelect.value = load.type === 'pressure' ? 'pressure' : 'force';

				// Selector <select>
				const selectorSelect = append(row, this.createSelectorSelect(load.selector));

				// Inputs for force / pressure
				let forceInputs: { inputFx: HTMLInputElement; inputFy: HTMLInputElement; inputFz: HTMLInputElement } | undefined;
				let pressureInput: HTMLInputElement | undefined;

				if (load.type === 'pressure') {
					const group = append(row, $('.ma-physics-inline-group'));
					pressureInput = append(group, $<HTMLInputElement>('input.ma-physics-number-input', {
						type: 'number',
						step: 'any',
						value: typeof load.magnitude === 'number' ? String(load.magnitude) : '0'
					}));
					append(group, $('span.ma-physics-unit', undefined, 'MPa'));
					append(group, $('span.ma-physics-hint', undefined, localize('physics.pressureHint', "positive pushes into the face")));
				} else {
					const group = append(row, $('.ma-physics-inline-group'));
					const vec = load.vector ?? [0, 0, 0];
					append(group, $('label.ma-physics-field-label', undefined, 'Fx'));
					const inputFx = append(group, $<HTMLInputElement>('input.ma-physics-number-input', {
						type: 'number',
						step: 'any',
						value: String(vec[0] ?? 0)
					}));
					append(group, $('label.ma-physics-field-label', undefined, 'Fy'));
					const inputFy = append(group, $<HTMLInputElement>('input.ma-physics-number-input', {
						type: 'number',
						step: 'any',
						value: String(vec[1] ?? 0)
					}));
					append(group, $('label.ma-physics-field-label', undefined, 'Fz'));
					const inputFz = append(group, $<HTMLInputElement>('input.ma-physics-number-input', {
						type: 'number',
						step: 'any',
						value: String(vec[2] ?? 0)
					}));
					append(group, $('span.ma-physics-unit', undefined, 'N'));
					forceInputs = { inputFx, inputFy, inputFz };
				}

				// Status element for warnings / errors
				const statusEl = append(row, $('span.ma-physics-row-status'));

				const updateLoadRowStatus = (): boolean => {
					if (forceInputs) {
						const resX = this.parseNumberInput(forceInputs.inputFx, false);
						const resY = this.parseNumberInput(forceInputs.inputFy, false);
						const resZ = this.parseNumberInput(forceInputs.inputFz, false);
						forceInputs.inputFx.classList.toggle('error', !resX.valid);
						forceInputs.inputFy.classList.toggle('error', !resY.valid);
						forceInputs.inputFz.classList.toggle('error', !resZ.valid);
						if (!resX.valid || !resY.valid || !resZ.valid) {
							statusEl.textContent = localize('physics.invalidNumber', "Invalid number");
							statusEl.className = 'ma-physics-row-status ma-physics-row-error';
							return false;
						}
					} else if (pressureInput) {
						const res = this.parseNumberInput(pressureInput, false);
						pressureInput.classList.toggle('error', !res.valid);
						if (!res.valid) {
							statusEl.textContent = localize('physics.invalidNumber', "Invalid number");
							statusEl.className = 'ma-physics-row-status ma-physics-row-error';
							return false;
						}
					}
					const warn = this.getLoadWarning(load);
					if (warn) {
						statusEl.textContent = warn;
						statusEl.className = 'ma-physics-row-status ma-physics-row-warning';
					} else {
						statusEl.textContent = '';
						statusEl.className = 'ma-physics-row-status';
					}
					return true;
				};

				// Trash button
				const delBtn = append(row, $<HTMLButtonElement>('button.ma-physics-remove-btn', { type: 'button', 'aria-label': localize('physics.remove', "Remove") }));
				append(delBtn, $(ThemeIcon.asCSSSelector(Codicon.trash)));

				this.inputDisposables.add(addDisposableListener(delBtn, EventType.CLICK, e => {
					e.stopPropagation();
					this.removeLoad(load.id);
				}));

				// Event listeners
				this.inputDisposables.add(addDisposableListener(typeSelect, EventType.CHANGE, async () => {
					const newType = typeSelect.value;
					if (newType !== load.type) {
						if (newType === 'pressure') {
							load.type = 'pressure';
							delete load.vector;
							load.magnitude = 0;
						} else {
							load.type = 'force';
							delete load.magnitude;
							load.vector = [0, 0, 0];
						}
						await this.saveData();
						this.render();
					}
				}));

				this.inputDisposables.add(addDisposableListener(selectorSelect, EventType.CHANGE, async () => {
					load.selector = selectorSelect.value;
					if (updateLoadRowStatus()) {
						await this.saveData();
						if (this.selectedId === load.id) {
							this.selectLoad(load);
						}
					}
				}));

				if (forceInputs) {
					const handleForceChange = async () => {
						if (!forceInputs) {
							return;
						}
						const resX = this.parseNumberInput(forceInputs.inputFx, false);
						const resY = this.parseNumberInput(forceInputs.inputFy, false);
						const resZ = this.parseNumberInput(forceInputs.inputFz, false);
						if (!resX.valid || !resY.valid || !resZ.valid) {
							updateLoadRowStatus();
							return;
						}
						load.vector = [resX.value!, resY.value!, resZ.value!];
						updateLoadRowStatus();
						await this.saveData();
						if (this.selectedId === load.id) {
							this.selectLoad(load);
						}
					};
					this.inputDisposables.add(addDisposableListener(forceInputs.inputFx, EventType.CHANGE, handleForceChange));
					this.inputDisposables.add(addDisposableListener(forceInputs.inputFy, EventType.CHANGE, handleForceChange));
					this.inputDisposables.add(addDisposableListener(forceInputs.inputFz, EventType.CHANGE, handleForceChange));
				} else if (pressureInput) {
					this.inputDisposables.add(addDisposableListener(pressureInput, EventType.CHANGE, async () => {
						if (!pressureInput) {
							return;
						}
						const res = this.parseNumberInput(pressureInput, false);
						if (!res.valid) {
							updateLoadRowStatus();
							return;
						}
						load.magnitude = res.value!;
						updateLoadRowStatus();
						await this.saveData();
						if (this.selectedId === load.id) {
							this.selectLoad(load);
						}
					}));
				}

				updateLoadRowStatus();
			}
		}

		// Section 3: Gravity
		const gravSec = append(this.contentContainer, $('.ma-physics-section'));
		const gravHead = append(gravSec, $('.ma-physics-header-row'));
		append(gravHead, $('.ma-physics-section-title', undefined, localize('physics.gravityTitle', "Gravitational Acceleration")));

		const gravRow = append(gravSec, $('.ma-physics-item-row'));
		if (this.selectedId === 'gravity') {
			gravRow.classList.add('selected');
		}

		append(gravRow, $('span.ma-physics-row-id', undefined, localize('physics.globalGravity', "Gravity")));

		const gravGroup = append(gravRow, $('.ma-physics-inline-group'));
		append(gravGroup, $('label.ma-physics-field-label', undefined, 'gx'));
		const gVec = Array.isArray(data.gravity) ? data.gravity : undefined;
		const inputGx = append(gravGroup, $<HTMLInputElement>('input.ma-physics-number-input', {
			type: 'number',
			step: 'any',
			placeholder: '0',
			value: gVec && typeof gVec[0] === 'number' ? String(gVec[0]) : ''
		}));
		append(gravGroup, $('label.ma-physics-field-label', undefined, 'gy'));
		const inputGy = append(gravGroup, $<HTMLInputElement>('input.ma-physics-number-input', {
			type: 'number',
			step: 'any',
			placeholder: '0',
			value: gVec && typeof gVec[1] === 'number' ? String(gVec[1]) : ''
		}));
		append(gravGroup, $('label.ma-physics-field-label', undefined, 'gz'));
		const inputGz = append(gravGroup, $<HTMLInputElement>('input.ma-physics-number-input', {
			type: 'number',
			step: 'any',
			placeholder: '0',
			value: gVec && typeof gVec[2] === 'number' ? String(gVec[2]) : ''
		}));
		append(gravGroup, $('span.ma-physics-unit', undefined, 'mm/s²'));

		const btnStd = append(gravRow, $<HTMLButtonElement>('button.monaco-button.ma-physics-btn-secondary', { type: 'button' }, localize('physics.standardGravity', "Standard (-Y)")));
		const btnNone = append(gravRow, $<HTMLButtonElement>('button.monaco-button.ma-physics-btn-secondary', { type: 'button' }, localize('physics.noGravityBtn', "None")));

		const magEl = append(gravRow, $('span.ma-physics-gravity-mag'));
		const gravStatus = append(gravRow, $('span.ma-physics-row-status'));

		const updateGravDisplay = () => {
			const g = this.currentData?.gravity;
			if (Array.isArray(g) && g.some(v => v !== 0)) {
				const mag = Number((Math.hypot(...g) / 1000).toPrecision(4));
				magEl.textContent = `${mag} m/s²`;
			} else {
				magEl.textContent = localize('physics.noGravity', "None");
			}
		};
		updateGravDisplay();

		const updateGravProperties = () => {
			if (this.selectedId === 'gravity') {
				const g = this.currentData?.gravity;
				const isNonZero = Array.isArray(g) && g.some(v => v !== 0);
				const gravText = isNonZero && g ? `[${g.join(', ')}] mm/s²` : localize('physics.noGravity', "None");
				this.propertiesDockService.setProperties({
					title: localize('physics.gravityPropTitle', "Gravitational Acceleration"),
					detail: isNonZero && g ? `${Number((Math.hypot(...g) / 1000).toPrecision(4))} m/s²` : localize('physics.noGravity', "None"),
					rows: [
						{ name: localize('prop.vector', "Vector [gx, gy, gz]"), value: gravText }
					]
				});
			}
		};

		this.inputDisposables.add(addDisposableListener(gravRow, EventType.CLICK, () => {
			this.clearSelections(this.contentContainer);
			gravRow.classList.add('selected');
			this.selectedId = 'gravity';
			updateGravProperties();
		}));

		this.inputDisposables.add(addDisposableListener(btnStd, EventType.CLICK, async e => {
			e.stopPropagation();
			if (!this.currentData) {
				this.currentData = { schema: 1, constraints: [], loads: [], gravity: null };
			}
			this.currentData.gravity = [0, -9810, 0];
			inputGx.value = '0';
			inputGy.value = '-9810';
			inputGz.value = '0';
			inputGx.classList.remove('error');
			inputGy.classList.remove('error');
			inputGz.classList.remove('error');
			gravStatus.textContent = '';
			gravStatus.className = 'ma-physics-row-status';
			updateGravDisplay();
			await this.saveData();
			updateGravProperties();
		}));

		this.inputDisposables.add(addDisposableListener(btnNone, EventType.CLICK, async e => {
			e.stopPropagation();
			if (!this.currentData) {
				this.currentData = { schema: 1, constraints: [], loads: [], gravity: null };
			}
			this.currentData.gravity = null;
			inputGx.value = '';
			inputGy.value = '';
			inputGz.value = '';
			inputGx.classList.remove('error');
			inputGy.classList.remove('error');
			inputGz.classList.remove('error');
			gravStatus.textContent = '';
			gravStatus.className = 'ma-physics-row-status';
			updateGravDisplay();
			await this.saveData();
			updateGravProperties();
		}));

		const handleGravChange = async () => {
			const resX = this.parseNumberInput(inputGx, false);
			const resY = this.parseNumberInput(inputGy, false);
			const resZ = this.parseNumberInput(inputGz, false);
			inputGx.classList.toggle('error', !resX.valid);
			inputGy.classList.toggle('error', !resY.valid);
			inputGz.classList.toggle('error', !resZ.valid);
			if (!resX.valid || !resY.valid || !resZ.valid) {
				gravStatus.textContent = localize('physics.invalidNumber', "Invalid number");
				gravStatus.className = 'ma-physics-row-status ma-physics-row-error';
				return;
			}
			gravStatus.textContent = '';
			gravStatus.className = 'ma-physics-row-status';
			const gx = resX.value!;
			const gy = resY.value!;
			const gz = resZ.value!;
			if (!this.currentData) {
				this.currentData = { schema: 1, constraints: [], loads: [], gravity: null };
			}
			if (gx === 0 && gy === 0 && gz === 0) {
				this.currentData.gravity = null;
			} else {
				this.currentData.gravity = [gx, gy, gz];
			}
			updateGravDisplay();
			await this.saveData();
			updateGravProperties();
		};

		this.inputDisposables.add(addDisposableListener(inputGx, EventType.CHANGE, handleGravChange));
		this.inputDisposables.add(addDisposableListener(inputGy, EventType.CHANGE, handleGravChange));
		this.inputDisposables.add(addDisposableListener(inputGz, EventType.CHANGE, handleGravChange));

		// Initial selection
		if (constraints.length > 0 && !this.selectedId) {
			this.selectConstraint(constraints[0]);
		}
	}

	private getTableRows(): { id: string; kind: string; type: string; selector: string; value: string }[] {
		const constraints = this.currentData?.constraints ?? [];
		const loads = this.currentData?.loads ?? [];
		return [
			...constraints.map(c => ({
				id: c.id,
				kind: 'Boundary condition',
				type: c.type === 'fixed' ? 'Fixed support' : (c.type === 'displacement' ? 'Prescribed displacement' : c.type),
				selector: c.selector,
				value: this.describeConstraintValue(c)
			})),
			...loads.map(l => ({
				id: l.id,
				kind: 'Load',
				type: l.type === 'force' ? 'Force' : (l.type === 'pressure' ? 'Pressure' : l.type),
				selector: l.selector,
				value: this.describeLoad(l).value
			}))
		];
	}

	private clearSelections(container: HTMLElement): void {
		for (const el of Array.from(container.querySelectorAll('.ma-physics-item-row'))) {
			el.classList.remove('selected');
		}
	}

	private selectConstraint(bc: IConstraint): void {
		this.selectedId = bc.id;
		this.propertiesDockService.setProperties({
			title: bc.id,
			detail: bc.type === 'fixed' ? localize('physics.fixedSupport', "Fixed Support") : localize('physics.prescribedDisplacement', "Prescribed Displacement"),
			rows: [
				{ name: localize('prop.id', "ID"), value: bc.id },
				{ name: localize('prop.type', "Type"), value: bc.type === 'fixed' ? 'Fixed support' : (bc.type === 'displacement' ? 'Prescribed displacement' : bc.type) },
				{ name: localize('prop.selector', "Target Selector"), value: bc.selector },
				{ name: localize('prop.dofs', "Constrained DOFs"), value: bc.type === 'fixed' ? "UX=0, UY=0, UZ=0" : this.describeConstraintValue(bc) }
			]
		});
	}

	private describeConstraintValue(c: IConstraint): string {
		if (c.type === 'fixed') {
			return 'All DOFs fixed';
		}
		const parts: string[] = [];
		if (typeof c.ux === 'number') {
			parts.push(`ux=${c.ux}`);
		}
		if (typeof c.uy === 'number') {
			parts.push(`uy=${c.uy}`);
		}
		if (typeof c.uz === 'number') {
			parts.push(`uz=${c.uz}`);
		}
		if (parts.length === 0) {
			return 'free';
		}
		return `${parts.join(', ')} mm`;
	}

	private describeLoad(load: ILoad): { value: string; short: string } {
		if (load.type === 'pressure' && typeof load.magnitude === 'number') {
			return {
				value: `${load.magnitude} MPa (normal)`,
				short: `${load.magnitude} MPa on ${load.selector}`
			};
		}
		if (load.vector && load.vector.length > 0) {
			const isZero = load.vector.every(v => v === 0);
			if (isZero) {
				return {
					value: '0 N',
					short: `0 N on ${load.selector}`
				};
			}
			return {
				value: `[${load.vector.join(', ')}] N`,
				short: `${Math.round(Math.hypot(...load.vector)).toLocaleString()} N on ${load.selector}`
			};
		}
		return {
			value: 'not set',
			short: `not set on ${load.selector}`
		};
	}

	private selectLoad(load: ILoad): void {
		this.selectedId = load.id;
		const desc = this.describeLoad(load);
		const rows = [
			{ name: localize('prop.id', "ID"), value: load.id },
			{ name: localize('prop.type', "Type"), value: load.type === 'force' ? 'Force' : (load.type === 'pressure' ? 'Pressure' : load.type) },
			{ name: localize('prop.selector', "Target Selector"), value: load.selector }
		];
		if (load.type === 'pressure') {
			rows.push({ name: localize('prop.pressure', "Pressure"), value: desc.value });
		} else {
			const isZero = !load.vector || load.vector.every(v => v === 0);
			const mag = !load.vector || load.vector.length === 0 ? 'not set' : (isZero ? '0 N' : `${Math.round(Math.hypot(...load.vector)).toLocaleString()} N`);
			rows.push(
				{ name: localize('prop.vector', "Force Vector"), value: desc.value },
				{ name: localize('prop.magnitude', "Magnitude"), value: mag }
			);
		}
		this.propertiesDockService.setProperties({
			title: load.id,
			detail: localize('physics.mechLoad', "Mechanical Load"),
			rows
		});
	}

	private createSelectorSelect(currentValue: string): HTMLSelectElement {
		const select = $<HTMLSelectElement>('select.ma-physics-select');
		const inList = this.selectorNames.includes(currentValue);
		if (!currentValue) {
			const opt = append(select, $<HTMLOptionElement>('option', { value: '' }, localize('physics.choose', "(choose)")));
			opt.selected = true;
		} else if (!inList) {
			const opt = append(select, $<HTMLOptionElement>('option', { value: currentValue }, `${currentValue} (missing)`));
			opt.selected = true;
		}
		for (const name of this.selectorNames) {
			const opt = append(select, $<HTMLOptionElement>('option', { value: name }, name));
			if (name === currentValue) {
				opt.selected = true;
			}
		}
		return select;
	}

	private parseNumberInput(input: HTMLInputElement, allowNull: boolean): { valid: boolean; value: number | null } {
		if (input.validity?.badInput) {
			return { valid: false, value: null };
		}
		const raw = input.value.trim();
		if (raw === '') {
			return { valid: true, value: allowNull ? null : 0 };
		}
		const num = Number(raw);
		if (!Number.isFinite(num)) {
			return { valid: false, value: null };
		}
		return { valid: true, value: num };
	}

	private getConstraintWarning(bc: IConstraint): string | undefined {
		const warnings: string[] = [];
		if (!bc.selector || !this.selectorNames.includes(bc.selector)) {
			warnings.push(localize('physics.warnMissingSelector', "selector not defined in Geometry"));
		}
		if (bc.type === 'displacement') {
			const hasNum = typeof bc.ux === 'number' || typeof bc.uy === 'number' || typeof bc.uz === 'number';
			if (!hasNum) {
				warnings.push(localize('physics.warnDisplacementBlank', "set at least one component"));
			}
		}
		return warnings.length > 0 ? warnings.join('; ') : undefined;
	}

	private getLoadWarning(load: ILoad): string | undefined {
		const warnings: string[] = [];
		if (!load.selector || !this.selectorNames.includes(load.selector)) {
			warnings.push(localize('physics.warnMissingSelector', "selector not defined in Geometry"));
		}
		if (load.type === 'force') {
			const vec = load.vector;
			if (!vec || vec.length === 0 || vec.every(v => v === 0)) {
				warnings.push(localize('physics.warnZeroForce', "zero force"));
			}
		} else if (load.type === 'pressure') {
			if (typeof load.magnitude !== 'number' || load.magnitude === 0) {
				warnings.push(localize('physics.warnZeroPressure', "zero pressure"));
			}
		}
		return warnings.length > 0 ? warnings.join('; ') : undefined;
	}

	private async addConstraint(): Promise<void> {
		if (!this.currentResource) {
			return;
		}
		if (!this.currentData) {
			this.currentData = { schema: 1, constraints: [], loads: [], gravity: null };
		}
		const constraints = this.currentData.constraints ?? (this.currentData.constraints = []);
		const existingIds = new Set(constraints.map(c => c.id));
		let i = 1;
		while (existingIds.has(`bc_${i}`)) {
			i++;
		}
		const nextId = `bc_${i}`;
		const defaultSelector = this.selectorNames.length > 0 ? this.selectorNames[0] : '';
		constraints.push({ id: nextId, type: 'fixed', selector: defaultSelector });
		await this.saveData();
		this.notificationService.info(localize('physics.constraintAdded', "Added constraint {0}", nextId));
		this.render();
	}

	private async removeConstraint(id: string): Promise<void> {
		if (!this.currentData || !this.currentResource || !this.currentData.constraints) {
			return;
		}
		this.currentData.constraints = this.currentData.constraints.filter(c => c.id !== id);
		if (this.selectedId === id) {
			this.selectedId = undefined;
			this.propertiesDockService.clearProperties();
		}
		await this.saveData();
		this.render();
	}

	private async addLoad(): Promise<void> {
		if (!this.currentResource) {
			return;
		}
		if (!this.currentData) {
			this.currentData = { schema: 1, constraints: [], loads: [], gravity: null };
		}
		const loads = this.currentData.loads ?? (this.currentData.loads = []);
		const existingIds = new Set(loads.map(l => l.id));
		let i = 1;
		while (existingIds.has(`load_${i}`)) {
			i++;
		}
		const nextId = `load_${i}`;
		const defaultSelector = this.selectorNames.length > 0 ? this.selectorNames[0] : '';
		loads.push({ id: nextId, type: 'force', selector: defaultSelector, vector: [0, 0, 0] });
		await this.saveData();
		this.notificationService.info(localize('physics.loadAdded', "Added load {0}", nextId));
		this.render();
	}

	private async removeLoad(id: string): Promise<void> {
		if (!this.currentData || !this.currentResource || !this.currentData.loads) {
			return;
		}
		this.currentData.loads = this.currentData.loads.filter(l => l.id !== id);
		if (this.selectedId === id) {
			this.selectedId = undefined;
			this.propertiesDockService.clearProperties();
		}
		await this.saveData();
		this.render();
	}

	private async saveData(): Promise<void> {
		if (!this.currentData || !this.currentResource) {
			return;
		}
		if (this.currentData.schema === undefined) {
			this.currentData.schema = 1;
		}
		const text = JSON.stringify(this.currentData, null, '\t') + '\n';
		this.lastWritten = text;
		await this.fileService.writeFile(this.currentResource, VSBuffer.fromString(text));
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
