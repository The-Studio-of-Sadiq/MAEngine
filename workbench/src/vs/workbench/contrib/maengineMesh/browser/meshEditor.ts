/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/meshEditor.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Action } from '../../../../base/common/actions.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/resources.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { EditorFrame } from '../../maengineProject/browser/editorFrame.js';
import { IMAEnginePropertiesDockService } from '../../maengineProject/browser/propertiesDock.js';
import { MAEngineTables } from '../../maengineProject/browser/tablesView.js';
import { IPartStatus, IRunTarget, resolvePartStatus, resolveRunTarget } from '../../maengineProject/browser/projectParts.js';
import { IMAEngineProjectService } from '../../../services/maengineProject/common/maengineProject.js';
import { MeshEditorInput } from './meshEditorInput.js';

interface IMeshStats {
	readonly nodes?: number;
	readonly elements?: number;
}

interface IMeshQuality {
	readonly metric?: string;
	readonly min?: number;
	readonly mean?: number;
	readonly belowPoint1?: number;
	readonly elementCount?: number;
}

interface IMeshQualityRow {
	readonly metric: string;
	readonly value: number;
	readonly target: string;
	readonly status: string;
}

const MESH_ALGORITHMS = ['hxt', 'delaunay', 'frontal'] as const;

function formatSicn(value: number): string {
	if (value !== 0 && Math.abs(value) < 0.001) {
		return value.toExponential(2);
	}
	return value.toFixed(3);
}

interface IMeshData {
	schema?: number;
	mesher?: string;
	algorithm?: string;
	elementType?: string;
	meshOrder?: number;
	globalSize?: number;
	minSize?: number;
	maxSize?: number;
	optimizeHighOrder?: boolean;
	conformalInterface?: boolean;
	status?: string;
	stats?: IMeshStats;
	quality?: IMeshQuality;
	/** Written by the engine after meshing (real Gmsh counts). */
	nodeCount?: number;
	elementCount?: number;
}

export class MeshEditor extends EditorPane {

	private frame!: EditorFrame;
	private contentContainer!: HTMLElement;
	private currentData: IMeshData | undefined;
	private currentResource: URI | undefined;
	private currentStatus: IPartStatus | undefined;
	private runTarget: IRunTarget | undefined;
	private generateAction!: Action;

	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly qualityTable = this._register(new MutableDisposable());

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
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super(MeshEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.frame = this._register(this.instantiationService.createInstance(EditorFrame, parent, {
			id: 'maengine.meshEditor',
			ariaLabel: localize('meshEditor.aria', "Mesh"),
			properties: { title: localize('properties', "Properties") }
		}));
		this.frame.element.classList.add('maengine-mesh-editor');
		this.frame.setTitle(localize('mesh.title', "Mesh"));

		this.generateAction = this._register(new Action(
			'maengine.mesh.generate',
			localize('mesh.generateAction', "Generate Mesh"),
			ThemeIcon.asClassName(Codicon.play),
			true,
			async () => this.runMesh()
		));

		this.frame.setActions([this.generateAction, this.frame.togglePropertiesAction]);

		this.contentContainer = append(this.frame.main, $('.ma-mesh-content'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();

		const resource = (input as MeshEditorInput).resource;
		this.currentResource = resource;
		if (resource) {
			const folder = dirname(resource);
			this.inputDisposables.add(this.fileService.onDidFilesChange(e => {
				// Readiness depends on the other parts too (CAD import, materials).
				const root = this.projectService.project?.root;
				if (e.contains(resource) || e.affects(folder) || (root && e.affects(root))) {
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
		this.qualityTable.clear();
		this.propertiesDockService.clearProperties();
		super.clearInput();
	}

	override dispose(): void {
		this.propertiesDockService.clearProperties();
		super.dispose();
	}

	private async load(resource: URI): Promise<void> {
		try {
			const content = await this.fileService.readFile(resource);
			this.currentData = JSON.parse(content.value.toString()) as IMeshData;
		} catch {
			this.currentData = undefined;
		}
		this.currentStatus = await resolvePartStatus('mesh', this.fileService, this.projectService, this.currentData, resource);
		this.runTarget = await resolveRunTarget('mesh', this.fileService, this.contextService, this.projectService);
		this.render();
	}

	private render(): void {
		const data = this.currentData ?? {};
		// An out-of-date mesh still exists: show it, with a warning that its inputs changed.
		const isStale = this.currentStatus?.state === 'stale';
		const hasMesh = this.currentStatus?.state === 'done' || isStale;

		// Keep button enabled only when running is possible
		const canRun = !!this.runTarget?.canRun;
		this.generateAction.enabled = canRun;
		const nodes = data.nodeCount ?? data.stats?.nodes;
		const elements = data.elementCount ?? data.stats?.elements;

		// Bottom Hint Strip
		if (!hasMesh) {
			if (!canRun) {
				this.frame.setStatus({
					text: localize('mesh.cannotRunHint', "Can't mesh yet: {0}", this.runTarget?.reason ?? localize('mesh.noRunTarget', "no study is open"))
				});
			} else {
				this.frame.setStatus({
					text: localize('mesh.notMeshedHint', "Not meshed yet: configure element sizing and generate mesh"),
					link: { label: localize('mesh.generateLink', "Generate Mesh"), run: () => this.runMesh() }
				});
			}
		} else if (isStale) {
			this.frame.setStatus({
				text: localize('mesh.staleHint', "Mesh is out of date: {0}. Generate it again (a solver run also re-meshes).", this.currentStatus?.hint ?? ''),
				severity: 'warning',
				link: canRun ? { label: localize('mesh.regenerateLink', "Generate Mesh"), run: () => this.runMesh() } : undefined
			});
		} else {
			this.frame.setStatus({
				text: typeof nodes === 'number' && typeof elements === 'number'
					? localize('mesh.doneHint', "Mesh generated: {0} nodes, {1} elements", nodes.toLocaleString(), elements.toLocaleString())
					: localize('mesh.doneHintNoCounts', "Mesh generated")
			});
		}

		// Register Mesh quality table to Tables panel
		// Only quality values the mesher actually reported; nothing is shown otherwise.
		const qualityRows: IMeshQualityRow[] = [];
		const quality = data.quality;
		if (hasMesh && quality) {
			if (typeof quality.min === 'number' && Number.isFinite(quality.min)) {
				qualityRows.push({
					metric: localize('mesh.qualityMinSicn', "Min SICN"),
					value: quality.min,
					target: '> 0.1',
					status: quality.min > 0.1 ? localize('status.passed', "Passed") : localize('status.warning', "Warning")
				});
			}
			if (typeof quality.mean === 'number' && Number.isFinite(quality.mean)) {
				qualityRows.push({
					metric: localize('mesh.qualityMeanSicn', "Mean SICN"),
					value: quality.mean,
					target: '> 0.5',
					status: quality.mean > 0.5 ? localize('status.passed', "Passed") : localize('status.warning', "Warning")
				});
			}
			if (typeof quality.belowPoint1 === 'number' && Number.isFinite(quality.belowPoint1)) {
				qualityRows.push({
					metric: localize('mesh.qualityBelowPoint1', "Elements with SICN < 0.1"),
					value: quality.belowPoint1,
					target: '0',
					status: quality.belowPoint1 === 0 ? localize('status.passed', "Passed") : localize('status.warning', "Warning")
				});
			}
		}

		this.qualityTable.value = MAEngineTables.registerTable<IMeshQualityRow>({
			id: 'maengine.mesh.quality',
			label: localize('table.meshQuality', "Mesh Quality"),
			getData: () => ({
				columns: [
					{ id: 'metric', label: localize('col.metric', "Metric"), sortable: true, getValue: r => r.metric },
					{ id: 'value', label: localize('col.value', "Value"), align: 'right', sortable: true, getValue: r => r.value },
					{ id: 'target', label: localize('col.target', "Target"), align: 'right', sortable: true, getValue: r => r.target },
					{ id: 'status', label: localize('col.status', "Status"), sortable: true, getValue: r => r.status }
				],
				rows: qualityRows,
				emptyText: localize('table.meshEmpty', "No mesh quality data available yet. Generate mesh first.")
			})
		});

		// Render Content Area
		clearNode(this.contentContainer);

		// Mesh Statistics Section
		const statsSec = append(this.contentContainer, $('.ma-mesh-section'));
		append(statsSec, $('.ma-mesh-section-title', undefined, localize('mesh.statsTitle', "Mesh Statistics")));
		const statsBox = append(statsSec, $('.ma-mesh-stats-box'));

		const addStat = (label: string, val: string) => {
			const c = append(statsBox, $('.ma-mesh-stat-card'));
			append(c, $('span.label', undefined, label));
			append(c, $('span.val', undefined, val));
		};

		const naText = localize('val.na', "n/a");
		const meshOrder = data.meshOrder ?? 2;
		const elementType = data.elementType ?? (meshOrder === 1 ? 'TET4' : 'TET10');
		addStat(localize('mesh.statNodes', "Nodes"), hasMesh && typeof nodes === 'number' ? nodes.toLocaleString() : naText);
		addStat(localize('mesh.statElements', "Elements"), hasMesh && typeof elements === 'number' ? elements.toLocaleString() : naText);
		addStat(localize('mesh.statElementType', "Element Type"), elementType);
		addStat(localize('mesh.statMinSicn', "Min SICN"), hasMesh && typeof quality?.min === 'number' && Number.isFinite(quality.min) ? formatSicn(quality.min) : naText);
		addStat(localize('mesh.statMeanSicn', "Mean SICN"), hasMesh && typeof quality?.mean === 'number' && Number.isFinite(quality.mean) ? formatSicn(quality.mean) : naText);

		// Sizing & Formulation Form Section
		const formSec = append(this.contentContainer, $('.ma-mesh-section'));
		append(formSec, $('.ma-mesh-section-title', undefined, localize('mesh.configTitle', "Mesh Configuration")));

		// Element Order
		const fOrder = append(formSec, $('.ma-mesh-field'));
		append(fOrder, $('label', undefined, localize('mesh.elementOrder', "Element Order")));
		const selOrder = append(fOrder, $<HTMLSelectElement>('select'));
		append(selOrder, $<HTMLOptionElement>('option', { value: '2' }, localize('mesh.quadOrder', "Quadratic (TET10, 10-node)")));
		append(selOrder, $<HTMLOptionElement>('option', { value: '1' }, localize('mesh.linearOrder', "Linear (TET4, 4-node)")));
		selOrder.value = String(meshOrder);

		// Algorithm
		const fAlgo = append(formSec, $('.ma-mesh-field'));
		append(fAlgo, $('label', undefined, localize('mesh.algorithm', "Mesher Algorithm")));
		const selAlgo = append(fAlgo, $<HTMLSelectElement>('select'));
		append(selAlgo, $<HTMLOptionElement>('option', { value: 'hxt' }, localize('mesh.algoHxt', "HXT (parallel Delaunay, default)")));
		append(selAlgo, $<HTMLOptionElement>('option', { value: 'delaunay' }, localize('mesh.algoDelaunay', "Delaunay")));
		append(selAlgo, $<HTMLOptionElement>('option', { value: 'frontal' }, localize('mesh.algoFrontal', "Frontal")));
		const algorithm = data.algorithm && (MESH_ALGORITHMS as readonly string[]).includes(data.algorithm) ? data.algorithm : 'hxt';
		selAlgo.value = algorithm;

		// Sizing Inputs
		const fSizes = append(formSec, $('.ma-mesh-field-row'));
		const fGlobal = append(fSizes, $('.ma-mesh-field'));
		append(fGlobal, $('label', undefined, localize('mesh.globalSize', "Global Size (mm)")));
		const inpGlobal = append(fGlobal, $<HTMLInputElement>('input', { type: 'number', step: '0.5' }));
		inpGlobal.value = String(data.globalSize ?? 10);

		const fMin = append(fSizes, $('.ma-mesh-field'));
		append(fMin, $('label', undefined, localize('mesh.minSize', "Min Size (mm)")));
		const inpMin = append(fMin, $<HTMLInputElement>('input', { type: 'number', step: '0.5' }));
		inpMin.value = String(data.minSize ?? 1);

		const fMaxRow = append(formSec, $('.ma-mesh-field-row'));
		const fMax = append(fMaxRow, $('.ma-mesh-field'));
		append(fMax, $('label', undefined, localize('mesh.maxSize', "Max Size (mm)")));
		const inpMax = append(fMax, $<HTMLInputElement>('input', { type: 'number', step: '0.5' }));
		inpMax.value = String(data.maxSize ?? 10);

		// Optimization flags
		const optSec = append(formSec, $('.ma-mesh-field'));
		append(optSec, $('label', undefined, localize('mesh.optimizations', "Optimizations")));

		const chkHighOrderRow = append(optSec, $<HTMLLabelElement>('label.ma-mesh-checkbox-row'));
		const chkHighOrder = append(chkHighOrderRow, $<HTMLInputElement>('input', { type: 'checkbox' }));
		chkHighOrder.checked = data.optimizeHighOrder ?? true;
		append(chkHighOrderRow, $('span', undefined, localize('mesh.optHighOrder', "High-order elastic optimization")));

		const conformalNote = append(optSec, $('span', undefined, localize('mesh.conformalNote', "Touching bodies are always meshed with shared (conformal) nodes.")));
		conformalNote.style.fontSize = 'var(--ma-font-xs, 11px)';
		conformalNote.style.color = 'var(--ma-muted, var(--vscode-descriptionForeground))';
		conformalNote.style.marginTop = '4px';

		// Actions bar
		const actBar = append(formSec, $('.ma-mesh-actions-bar'));
		const saveBtn = append(actBar, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('mesh.saveSettings', "Apply Sizing")));
		saveBtn.style.padding = '4px 12px';

		this.inputDisposables.add(addDisposableListener(saveBtn, EventType.CLICK, async () => {
			if (!this.currentResource || !this.currentData) {
				return;
			}
			this.currentData.meshOrder = Number(selOrder.value);
			this.currentData.elementType = selOrder.value === '2' ? 'TET10' : 'TET4';
			this.currentData.algorithm = selAlgo.value;
			this.currentData.globalSize = Number(inpGlobal.value);
			this.currentData.minSize = Number(inpMin.value);
			this.currentData.maxSize = Number(inpMax.value);
			this.currentData.optimizeHighOrder = chkHighOrder.checked;

			await this.fileService.writeFile(this.currentResource, VSBuffer.fromString(JSON.stringify(this.currentData, null, '\t')));
			this.notificationService.info(localize('mesh.saved', "Mesh sizing applied."));
			this.updateProperties();
		}));

		this.updateProperties();
	}

	private updateProperties(): void {
		const data = this.currentData ?? {};
		const isStale = this.currentStatus?.state === 'stale';
		const hasMesh = this.currentStatus?.state === 'done' || isStale;
		const statusText = isStale ? 'out of date' : hasMesh ? (data.status ?? "meshed") : "not meshed";
		const meshOrder = data.meshOrder ?? 2;
		const elementType = data.elementType ?? (meshOrder === 1 ? 'TET4' : 'TET10');
		this.propertiesDockService.setProperties({
			title: localize('mesh.propertiesTitle', "Mesh Configuration"),
			detail: elementType,
			rows: [
				{ name: localize('prop.mesher', "Mesher Engine"), value: data.mesher ?? "gmsh" },
				{ name: localize('prop.algorithm', "Mesher Algorithm"), value: data.algorithm ?? "hxt" },
				{ name: localize('prop.elementType', "Element Formulation"), value: elementType },
				{ name: localize('prop.meshOrder', "Polynomial Order"), value: String(meshOrder) },
				{ name: localize('prop.globalSize', "Global Size"), value: `${data.globalSize ?? 10} mm` },
				{ name: localize('prop.minSize', "Min Element Size"), value: `${data.minSize ?? 1} mm` },
				{ name: localize('prop.maxSize', "Max Element Size"), value: `${data.maxSize ?? 10} mm` },
				{ name: localize('prop.status', "Mesh Status"), value: statusText }
			]
		});
	}

	private runMesh(): void {
		void this.commandService.executeCommand('maengine.mesh.run');
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
