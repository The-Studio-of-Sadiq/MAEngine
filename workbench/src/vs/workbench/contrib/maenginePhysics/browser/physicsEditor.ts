/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/physicsEditor.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
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
import { MAEngineTables } from '../../maengineProject/browser/tablesView.js';
import { PhysicsEditorInput } from './physicsEditorInput.js';

interface IConstraint {
	id: string;
	type: string;
	selector: string;
}

interface ILoad {
	id: string;
	type: string;
	selector: string;
	vector: number[];
}

interface IPhysicsData {
	schema?: number;
	constraints?: IConstraint[];
	loads?: ILoad[];
	gravity?: number[];
}

export class PhysicsEditor extends EditorPane {

	private frame!: EditorFrame;
	private contentContainer!: HTMLElement;
	private currentData: IPhysicsData | undefined;
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
			this.currentData = JSON.parse(content.value.toString()) as IPhysicsData;
		} catch {
			this.currentData = undefined;
		}
		this.render();
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
		const tableRows = [
			...constraints.map(c => ({ id: c.id, kind: 'Boundary condition', type: c.type === 'fixed' ? 'Fixed support' : c.type, selector: c.selector, value: 'All DOFs fixed' })),
			...loads.map(l => ({ id: l.id, kind: 'Load', type: l.type, selector: l.selector, value: `[${l.vector.join(', ')}] N` }))
		];

		this.inputDisposables.add(MAEngineTables.registerTable({
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
				rows: tableRows,
				emptyText: localize('table.physicsEmpty', "No boundary conditions or loads configured yet.")
			})
		}));

		clearNode(this.contentContainer);

		// Section 1: Boundary Conditions
		const bcSec = append(this.contentContainer, $('.ma-physics-section'));
		const bcHead = append(bcSec, $('.ma-physics-header-row'));
		append(bcHead, $('.ma-physics-section-title', undefined, localize('physics.bcTitle', "Boundary Conditions")));
		const addBcBtn = append(bcHead, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('physics.addBc', "Add Constraint...")));
		addBcBtn.style.padding = '2px 8px';
		addBcBtn.style.fontSize = 'var(--ma-font-xs, 11px)';

		this.inputDisposables.add(addDisposableListener(addBcBtn, EventType.CLICK, () => this.addConstraint()));

		const bcList = append(bcSec, $('.ma-physics-list'));
		if (constraints.length === 0) {
			append(bcList, $('.ma-physics-empty-notice', undefined, localize('physics.noBc', "No boundary conditions defined yet.")));
		} else {
			for (const bc of constraints) {
				const row = append(bcList, $('.ma-physics-item-row'));
				if (this.selectedId === bc.id) {
					row.classList.add('selected');
				}
				append(row, $('span', undefined, bc.id));

				const meta = append(row, $('.ma-physics-item-meta'));
				append(meta, $('span', undefined, `${bc.type} on ${bc.selector}`));

				const delBtn = append(meta, $<HTMLButtonElement>('button.ma-physics-remove-btn', { type: 'button', 'aria-label': localize('physics.remove', "Remove") }));
				append(delBtn, $(ThemeIcon.asCSSSelector(Codicon.trash)));

				this.inputDisposables.add(addDisposableListener(delBtn, EventType.CLICK, e => {
					e.stopPropagation();
					this.removeConstraint(bc.id);
				}));

				this.inputDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
					this.clearSelections(this.contentContainer);
					row.classList.add('selected');
					this.selectConstraint(bc);
				}));
			}
		}

		// Section 2: Applied Loads
		const loadSec = append(this.contentContainer, $('.ma-physics-section'));
		const loadHead = append(loadSec, $('.ma-physics-header-row'));
		append(loadHead, $('.ma-physics-section-title', undefined, localize('physics.loadsTitle', "Applied Loads")));
		const addLoadBtn = append(loadHead, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('physics.addLoad', "Add Load...")));
		addLoadBtn.style.padding = '2px 8px';
		addLoadBtn.style.fontSize = 'var(--ma-font-xs, 11px)';

		this.inputDisposables.add(addDisposableListener(addLoadBtn, EventType.CLICK, () => this.addLoad()));

		const loadList = append(loadSec, $('.ma-physics-list'));
		if (loads.length === 0) {
			append(loadList, $('.ma-physics-empty-notice', undefined, localize('physics.noLoads', "No mechanical loads applied yet.")));
		} else {
			for (const load of loads) {
				const row = append(loadList, $('.ma-physics-item-row'));
				if (this.selectedId === load.id) {
					row.classList.add('selected');
				}
				append(row, $('span', undefined, load.id));

				const meta = append(row, $('.ma-physics-item-meta'));
				const mag = Math.round(Math.hypot(...load.vector));
				append(meta, $('span', undefined, `${mag.toLocaleString()} N on ${load.selector}`));

				const delBtn = append(meta, $<HTMLButtonElement>('button.ma-physics-remove-btn', { type: 'button', 'aria-label': localize('physics.remove', "Remove") }));
				append(delBtn, $(ThemeIcon.asCSSSelector(Codicon.trash)));

				this.inputDisposables.add(addDisposableListener(delBtn, EventType.CLICK, e => {
					e.stopPropagation();
					this.removeLoad(load.id);
				}));

				this.inputDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
					this.clearSelections(this.contentContainer);
					row.classList.add('selected');
					this.selectLoad(load);
				}));
			}
		}

		// Section 3: Gravity
		const gravSec = append(this.contentContainer, $('.ma-physics-section'));
		const gravHead = append(gravSec, $('.ma-physics-header-row'));
		append(gravHead, $('.ma-physics-section-title', undefined, localize('physics.gravityTitle', "Gravitational Acceleration")));

		const gravRow = append(gravSec, $('.ma-physics-item-row'));
		const gravVector = data.gravity ?? [0, 0, -9810];
		append(gravRow, $('span', undefined, localize('physics.globalGravity', "Standard Gravity (Z negative)")));
		const gravMeta = append(gravRow, $('.ma-physics-item-meta'));
		append(gravMeta, $('span', undefined, `[${gravVector.join(', ')}] mm/s²`));

		this.inputDisposables.add(addDisposableListener(gravRow, EventType.CLICK, () => {
			this.clearSelections(this.contentContainer);
			gravRow.classList.add('selected');
			this.selectedId = 'gravity';
			this.propertiesDockService.setProperties({
				title: localize('physics.gravityPropTitle', "Gravitational Acceleration"),
				detail: "-9.81 m/s²",
				rows: [
					{ name: localize('prop.vector', "Vector [gx, gy, gz]"), value: `[${gravVector.join(', ')}] mm/s²` },
					{ name: localize('prop.standardG', "Standard Magnitude"), value: "9.81 m/s² (1 g)" }
				]
			});
		}));

		// Initial selection
		if (constraints.length > 0 && !this.selectedId) {
			this.selectConstraint(constraints[0]);
		}
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
			detail: bc.type === 'fixed' ? localize('physics.fixedSupport', "Fixed Support") : bc.type,
			rows: [
				{ name: localize('prop.id', "ID"), value: bc.id },
				{ name: localize('prop.type', "Type"), value: bc.type },
				{ name: localize('prop.selector', "Target Selector"), value: bc.selector },
				{ name: localize('prop.dofs', "Constrained DOFs"), value: bc.type === 'fixed' ? "UX=0, UY=0, UZ=0" : "Custom" }
			]
		});
	}

	private selectLoad(load: ILoad): void {
		this.selectedId = load.id;
		const mag = Math.round(Math.hypot(...load.vector));
		this.propertiesDockService.setProperties({
			title: load.id,
			detail: localize('physics.mechLoad', "Mechanical Load"),
			rows: [
				{ name: localize('prop.id', "ID"), value: load.id },
				{ name: localize('prop.type', "Type"), value: load.type },
				{ name: localize('prop.selector', "Target Selector"), value: load.selector },
				{ name: localize('prop.vector', "Force Vector"), value: `[${load.vector.join(', ')}] N` },
				{ name: localize('prop.magnitude', "Magnitude"), value: `${mag.toLocaleString()} N` }
			]
		});
	}

	private async addConstraint(): Promise<void> {
		if (!this.currentData || !this.currentResource) {
			return;
		}
		const constraints = this.currentData.constraints ?? (this.currentData.constraints = []);
		const nextId = `bc_${constraints.length + 1}`;
		constraints.push({ id: nextId, type: 'fixed', selector: 'fixed_face' });
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
		if (!this.currentData || !this.currentResource) {
			return;
		}
		const loads = this.currentData.loads ?? (this.currentData.loads = []);
		const nextId = `load_${loads.length + 1}`;
		loads.push({ id: nextId, type: 'force', selector: 'loaded_face', vector: [0, -5000, 0] });
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
		await this.fileService.writeFile(this.currentResource, VSBuffer.fromString(JSON.stringify(this.currentData, null, '\t')));
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
