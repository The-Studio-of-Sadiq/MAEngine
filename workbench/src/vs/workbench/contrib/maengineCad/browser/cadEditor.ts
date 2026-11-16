/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/cadEditor.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/resources.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
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
import { IPartStatus, resolvePartStatus } from '../../maengineProject/browser/projectParts.js';
import { IMAEngineProjectService } from '../../../services/maengineProject/common/maengineProject.js';
import { CadEditorInput } from './cadEditorInput.js';

interface ICadBody {
	readonly id: string;
	readonly name: string;
	readonly material?: string;
	readonly volume_mm3?: number;
}

interface ICadSelector {
	readonly name: string;
	readonly type: string;
	readonly rule?: string;
	readonly bounds?: readonly number[];
}

interface ICadData {
	readonly schema?: number;
	readonly cadFile?: string;
	readonly bodies?: readonly ICadBody[];
	readonly selectors?: readonly ICadSelector[];
}

export class CadEditor extends EditorPane {

	private frame!: EditorFrame;
	private viewport3d!: HTMLElement;
	private bodiesContainer!: HTMLElement;
	private selectedBodyId: string | undefined;
	private currentStatus: IPartStatus | undefined;

	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IMAEnginePropertiesDockService private readonly propertiesDockService: IMAEnginePropertiesDockService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
	) {
		super(CadEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.frame = this._register(this.instantiationService.createInstance(EditorFrame, parent, {
			id: 'maengine.cadEditor',
			ariaLabel: localize('cadEditor.aria', "CAD Geometry"),
			properties: { title: localize('properties', "Properties") }
		}));
		this.frame.element.classList.add('maengine-cad-editor');
		this.frame.setActions([this.frame.togglePropertiesAction]);

		this._register(this.frame.createSegmented(
			this.frame.titleSlot,
			[
				{ id: '3d', label: localize('cad.view3d', "3D"), icon: Codicon.symbolStructure },
				{ id: 'bodies', label: localize('cad.bodies', "Bodies"), icon: Codicon.layers }
			],
			'3d',
			mode => this.switchView(mode)
		));

		this.viewport3d = append(this.frame.main, $('.ma-cad-viewport'));
		this.bodiesContainer = append(this.frame.main, $('.ma-cad-bodies-view'));

		this.render3dViewport();
		this.switchView('3d');
	}

	private render3dViewport(): void {
		clearNode(this.viewport3d);

		const box = append(this.viewport3d, $('.ma-cad-canvas-box'));
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '180');
		svg.setAttribute('height', '120');
		svg.setAttribute('viewBox', '0 0 180 120');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '1.5');

		const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		p1.setAttribute('points', '30,85 110,40 155,65 75,110');
		p1.setAttribute('fill', 'var(--ma-surface, #ffffff)');
		p1.setAttribute('opacity', '0.6');
		svg.appendChild(p1);

		const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		p2.setAttribute('points', '30,55 110,10 155,35 75,80');
		p2.setAttribute('fill', 'var(--ma-surface, #ffffff)');
		p2.setAttribute('opacity', '0.8');
		svg.appendChild(p2);

		const addLine = (x1: string, y1: string, x2: string, y2: string) => {
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', x1);
			line.setAttribute('y1', y1);
			line.setAttribute('x2', x2);
			line.setAttribute('y2', y2);
			svg.appendChild(line);
		};

		addLine('30', '85', '30', '55');
		addLine('110', '40', '110', '10');
		addLine('155', '65', '155', '35');
		addLine('75', '110', '75', '80');

		box.appendChild(svg);
		append(box, $('span', undefined, localize('cad.viewportNote', "3D CAD geometry preview")));

		const triad = append(this.viewport3d, $('.ma-cad-triad'));
		append(triad, $('span.axis-x', undefined, "X"));
		append(triad, $('span.axis-y', undefined, "Y"));
		append(triad, $('span.axis-z', undefined, "Z"));

		this._register(addDisposableListener(this.viewport3d, EventType.CLICK, () => {
			if (this.selectedBodyId) {
				const data = this.currentData;
				const body = data?.bodies?.find(b => b.id === this.selectedBodyId);
				if (body) {
					this.selectBody(body);
				}
			}
		}));
	}

	private switchView(mode: '3d' | 'bodies'): void {
		this.viewport3d.classList.toggle('hidden', mode !== '3d');
		this.bodiesContainer.classList.toggle('hidden', mode !== 'bodies');
	}

	private currentData: ICadData | undefined;

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();

		const resource = (input as CadEditorInput).resource;
		if (resource) {
			const folder = dirname(resource);
			this.inputDisposables.add(this.fileService.onDidFilesChange(e => {
				if (e.contains(resource) || e.affects(folder)) {
					void this.load(resource);
				}
			}));
			this.inputDisposables.add(this.projectService.onDidChangeProject(() => {
				void this.load(resource);
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
			this.currentData = JSON.parse(content.value.toString()) as ICadData;
		} catch {
			this.currentData = undefined;
		}
		this.currentStatus = await resolvePartStatus('geometry', this.fileService, this.projectService, this.currentData, resource);
		this.render();
	}

	private render(): void {
		const data = this.currentData;
		const bodies = data?.bodies ?? [];
		const hasGeometry = this.currentStatus?.state === 'done';

		if (!hasGeometry) {
			this.frame.setEmpty({
				icon: Codicon.package,
				title: localize('cad.emptyTitle', "No geometry yet"),
				text: localize('cad.emptyText', "No geometry yet. Import a STEP, IGES or BREP file."),
				actions: [{
					label: localize('cad.importAction', "Import CAD..."),
					primary: true,
					run: () => this.importCad()
				}]
			});
			this.frame.setStatus({
				text: localize('cad.emptyStatus', "No geometry imported"),
				link: { label: localize('cad.importAction', "Import CAD..."), run: () => this.importCad() }
			});
			this.propertiesDockService.clearProperties();
			return;
		}

		this.frame.setEmpty(undefined);
		const count = bodies.length;
		const bodyText = count === 1 ? '1 body' : `${count} bodies`;
		this.frame.setStatus({
			text: localize('cad.status', "Geometry: {0} ({1})", data?.cadFile ?? 'model', this.currentStatus?.text ?? bodyText)
		});

		// Register Bodies Table to bottom Tables Panel
		this.inputDisposables.add(MAEngineTables.registerTable({
			id: 'maengine.cad.bodies',
			label: localize('table.bodies', "Bodies"),
			getData: () => ({
				columns: [
					{ id: 'name', label: localize('col.name', "Name"), sortable: true, getValue: (r: ICadBody) => r.name },
					{ id: 'material', label: localize('col.material', "Material"), sortable: true, getValue: (r: ICadBody) => r.material ?? 'n/a' },
					{ id: 'volume', label: localize('col.volume', "Volume (mm³)"), align: 'right', sortable: true, getValue: (r: ICadBody) => r.volume_mm3 ?? 0 }
				],
				rows: bodies
			})
		}));

		// Render Bodies View
		clearNode(this.bodiesContainer);
		append(this.bodiesContainer, $('.ma-cad-section-title', undefined, localize('cad.bodiesSection', "Bodies in Model")));

		const list = append(this.bodiesContainer, $('.ma-cad-item-list'));
		for (const body of bodies) {
			const row = append(list, $('.ma-cad-body-row'));
			if (this.selectedBodyId === body.id) {
				row.classList.add('selected');
			}
			append(row, $('span.ma-cad-body-name', undefined, body.name));
			const meta = append(row, $('.ma-cad-body-meta'));
			if (body.material) {
				append(meta, $('span.ma-cad-body-mat', undefined, body.material));
			}
			if (typeof body.volume_mm3 === 'number') {
				append(meta, $('span.ma-cad-body-vol', undefined, `${body.volume_mm3.toLocaleString()} mm³`));
			}

			this.inputDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
				for (const child of Array.from(list.children)) {
					child.classList.remove('selected');
				}
				row.classList.add('selected');
				this.selectBody(body);
			}));
		}

		// Topological Selectors if present
		if (data?.selectors?.length) {
			append(this.bodiesContainer, $('.ma-cad-section-title', undefined, localize('cad.selectorsSection', "Topological Selectors")));
			const selList = append(this.bodiesContainer, $('.ma-cad-item-list'));
			for (const sel of data.selectors) {
				const row = append(selList, $('.ma-cad-body-row'));
				append(row, $('span', undefined, sel.name));
				const meta = append(row, $('.ma-cad-body-meta'));
				append(meta, $('span', undefined, sel.type));
				this.inputDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
					this.propertiesDockService.setProperties({
						title: sel.name,
						detail: sel.type,
						rows: [
							{ name: localize('prop.selectorName', "Selector Name"), value: sel.name },
							{ name: localize('prop.selectorType', "Entity Type"), value: sel.type },
							{ name: localize('prop.rule', "Selection Rule"), value: sel.rule ?? 'n/a' },
							{ name: localize('prop.bounds', "Bounding Box"), value: sel.bounds ? `[${sel.bounds.join(', ')}]` : 'n/a' }
						]
					});
				}));
			}
		}

		// Initial selection
		if (bodies.length > 0 && !this.selectedBodyId) {
			this.selectBody(bodies[0]);
		}
	}

	private selectBody(body: ICadBody): void {
		this.selectedBodyId = body.id;
		this.propertiesDockService.setProperties({
			title: body.name,
			detail: body.id,
			rows: [
				{ name: localize('prop.bodyId', "Body ID"), value: body.id },
				{ name: localize('prop.bodyName', "Name"), value: body.name },
				{ name: localize('prop.material', "Material"), value: body.material ?? localize('prop.na', "n/a") },
				{ name: localize('prop.volume', "Volume"), value: typeof body.volume_mm3 === 'number' ? `${body.volume_mm3.toLocaleString()} mm³` : localize('prop.na', "n/a") }
			]
		});
	}

	private importCad(): void {
		this.notificationService.info(localize('cad.importPrompt', "Select a STEP, IGES or BREP file to import."));
		void this.commandService.executeCommand('workbench.action.files.openFile');
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
