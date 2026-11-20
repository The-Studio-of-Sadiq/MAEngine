/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/resultsEditor.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { EditorFrame, ISegmentedControl } from '../../maengineProject/browser/editorFrame.js';
import { IMAEnginePropertiesDockService } from '../../maengineProject/browser/propertiesDock.js';
import { MAEngineTables } from '../../maengineProject/browser/tablesView.js';
import { IPartStatus, resolvePartStatus } from '../../maengineProject/browser/projectParts.js';
import { IMAEngineProjectService } from '../../../services/maengineProject/common/maengineProject.js';
import { ResultsEditorInput } from './resultsEditorInput.js';
import {
	DeformationScaleMode,
	formatResultNumber,
	formatScaleFactor,
	IResultViewData,
	IResultViewerState,
	parseResultViewData,
	ResultViewer
} from './resultViewer.js';

interface IResultsSummary {
	readonly maxVonMises_MPa?: number | null;
	readonly maxDisplacement_mm?: number | null;
	readonly minSafetyFactor?: number | null;
	readonly minVonMises_MPa?: number | null;
	readonly minDisplacement_mm?: number | null;
	/** Summed nodal reaction force per support selector, [Fx, Fy, Fz] in N (read from the .frd). */
	readonly reactionForces_N?: { readonly [selector: string]: readonly number[] } | null;
}

function formatValue(value: number | null | undefined, unit: string): string | undefined {
	return typeof value === 'number' && isFinite(value) ? `${Number(value.toPrecision(5))} ${unit}`.trim() : undefined;
}

interface IResultRow {
	readonly field: string;
	readonly max: string;
	readonly min: string;
	readonly unit: string;
}

interface IResultsData {
	readonly schema?: number;
	readonly hasResults?: boolean;
	readonly resultFile?: string;
	readonly viewFile?: string;
	readonly gltfFile?: string;
	readonly imageFile?: string;
	readonly summary?: IResultsSummary;
}

function imageMimeType(fileName: string): string {
	const lower = fileName.toLowerCase();
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
		return 'image/jpeg';
	}
	if (lower.endsWith('.webp')) {
		return 'image/webp';
	}
	return 'image/png';
}

function toDeformationScaleMode(value: string): DeformationScaleMode {
	switch (value) {
		case 'auto':
		case 'undeformed':
		case 'true':
		case 'custom':
			return value;
		default:
			return 'auto';
	}
}

export class ResultsEditor extends EditorPane {

	private frame!: EditorFrame;
	private currentData: IResultsData | undefined;
	private viewportArea!: HTMLElement;
	private currentStatus: IPartStatus | undefined;
	private currentResource: URI | undefined;
	private loadGeneration = 0;
	private loadedViewSignature: string | undefined;
	private isDisposed = false;

	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly viewportDisposables = this._register(new DisposableStore());
	private readonly viewer = this._register(new MutableDisposable<ResultViewer>());
	private readonly segmentControl = this._register(new MutableDisposable<ISegmentedControl<'stress' | 'deformation' | 'other'>>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IMAEnginePropertiesDockService private readonly propertiesDockService: IMAEnginePropertiesDockService,
		@ICommandService private readonly commandService: ICommandService,
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
	) {
		super(ResultsEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.frame = this._register(this.instantiationService.createInstance(EditorFrame, parent, {
			id: 'maengine.resultsEditor',
			ariaLabel: localize('resultsEditor.aria', "Results"),
			properties: { title: localize('properties', "Properties") }
		}));
		this.frame.element.classList.add('maengine-results-editor');
		this.frame.setTitle(localize('results.title', "Results"));
		this.frame.setActions([this.frame.togglePropertiesAction]);

		this.viewportArea = append(this.frame.main, $('.ma-results-viewport'));

		this._register(this.frame.onDidLayoutMain(() => {
			this.viewer.value?.layout();
		}));
		this._register(this.themeService.onDidColorThemeChange(() => {
			this.viewer.value?.refreshTheme();
		}));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();
		this.clearViewport();

		const resource = input instanceof ResultsEditorInput ? input.resource : undefined;
		this.currentResource = resource;
		if (resource) {
			const folder = dirname(resource);
			const solverFolder = joinPath(dirname(folder), '06 Solver');
			this.inputDisposables.add(this.fileService.onDidFilesChange(e => {
				// Staleness depends on every input part, so any change in the study can matter.
				const root = this.projectService.project?.root;
				const resultsChanged = e.contains(resource) || e.affects(folder);
				if (resultsChanged || e.affects(solverFolder) || (root && e.affects(root))) {
					void this.load(resource, resultsChanged);
				}
			}));
			this.inputDisposables.add(this.projectService.onDidChangeProject(() => {
				void this.load(resource, true);
			}));
			await this.load(resource, true);
		}
	}

	override clearInput(): void {
		this.loadGeneration++;
		this.currentResource = undefined;
		this.currentData = undefined;
		this.currentStatus = undefined;
		this.inputDisposables.clear();
		this.clearViewport();
		this.segmentControl.clear();
		this.propertiesDockService.clearProperties();
		super.clearInput();
	}

	override dispose(): void {
		this.isDisposed = true;
		this.loadGeneration++;
		this.clearViewport();
		this.propertiesDockService.clearProperties();
		super.dispose();
	}

	private clearViewport(): void {
		this.loadedViewSignature = undefined;
		this.viewer.clear();
		this.viewportDisposables.clear();
		clearNode(this.viewportArea);
	}

	private async load(resource: URI, forceReloadView = false): Promise<void> {
		const generation = ++this.loadGeneration;
		try {
			const content = await this.fileService.readFile(resource);
			this.currentData = JSON.parse(content.value.toString()) as IResultsData;
		} catch {
			this.currentData = undefined;
		}
		if (generation !== this.loadGeneration || this.isDisposed) {
			return;
		}

		this.currentStatus = await resolvePartStatus('results', this.fileService, this.projectService, this.currentData, resource);
		if (generation !== this.loadGeneration || this.isDisposed) {
			return;
		}

		const hasResults = this.renderMetadata();
		if (!hasResults) {
			this.clearViewport();
			this.segmentControl.clear();
			return;
		}

		const data = this.currentData;
		const folder = dirname(resource);
		const viewFile = typeof data?.viewFile === 'string' && data.viewFile.trim().length > 0 ? data.viewFile.trim() : undefined;
		const imageFile = typeof data?.imageFile === 'string' && data.imageFile.trim().length > 0 ? data.imageFile.trim() : undefined;
		const nextSignature = `${folder.toString()}|${viewFile ?? ''}|${imageFile ?? ''}`;

		if (!forceReloadView && this.loadedViewSignature === nextSignature && this.viewportArea.childElementCount > 0) {
			return;
		}

		let viewData: IResultViewData | undefined;
		if (viewFile) {
			try {
				const viewContent = await this.fileService.readFile(joinPath(folder, viewFile));
				if (generation !== this.loadGeneration || this.isDisposed) {
					return;
				}
				const parsed: unknown = JSON.parse(viewContent.value.toString());
				viewData = parseResultViewData(parsed);
			} catch {
				viewData = undefined;
			}
		}

		if (generation !== this.loadGeneration || this.isDisposed || this.currentResource?.toString() !== resource.toString()) {
			return;
		}

		if (viewData) {
			const mounted = this.mountViewer(viewData);
			if (mounted) {
				this.loadedViewSignature = nextSignature;
				return;
			}
		}

		// Fallback to static PNG image and/or message when viewFile is missing/invalid or WebGL is unavailable
		let imageDataUri: string | undefined;
		if (imageFile) {
			try {
				const imgContent = await this.fileService.readFile(joinPath(folder, imageFile));
				if (generation !== this.loadGeneration || this.isDisposed) {
					return;
				}
				const base64 = encodeBase64(imgContent.value);
				imageDataUri = `data:${imageMimeType(imageFile)};base64,${base64}`;
			} catch {
				imageDataUri = undefined;
			}
		}

		if (generation !== this.loadGeneration || this.isDisposed || this.currentResource?.toString() !== resource.toString()) {
			return;
		}

		const noteText = viewData
			? localize('results.webglUnavailable', "WebGL is unavailable; interactive 3D view cannot be displayed.")
			: localize('results.rerunForInteractiveView', "Run the solver again to get the interactive 3D view.");
		this.mountFallback(imageDataUri, noteText);
		this.loadedViewSignature = nextSignature;
	}

	private ensureSegmentControl(): ISegmentedControl<'stress' | 'deformation' | 'other'> {
		if (!this.segmentControl.value) {
			this.segmentControl.value = this.frame.createSegmented<'stress' | 'deformation' | 'other'>(
				this.frame.titleSlot,
				[
					{ id: 'stress', label: localize('results.stress', "Stress"), icon: Codicon.graph },
					{ id: 'deformation', label: localize('results.deformation', "Deformation"), icon: Codicon.symbolRuler }
				],
				'stress',
				mode => {
					const activeViewer = this.viewer.value;
					if (!activeViewer) {
						return;
					}
					if (mode === 'stress') {
						activeViewer.setField('von_mises');
					} else if (mode === 'deformation') {
						activeViewer.setField('disp_mag');
					}
				}
			);
		}
		return this.segmentControl.value;
	}

	private renderMetadata(): boolean {
		const data = this.currentData;
		// Out-of-date results are still shown, with a warning that the inputs changed.
		const isStale = this.currentStatus?.state === 'stale';
		const hasResults = this.currentStatus?.state === 'done' || isStale;

		if (!hasResults) {
			this.frame.setEmpty({
				icon: Codicon.graph,
				title: localize('results.emptyTitle', "No results yet"),
				text: localize('results.emptyText', "No results yet. Run the solver first."),
				actions: [{
					label: localize('results.openSolver', "Open Solver"),
					primary: true,
					run: () => void this.commandService.executeCommand('maengine.project.openPart6')
				}]
			});

			this.frame.setStatus({
				text: localize('results.statusEmpty', "No results yet: run the solver first."),
				link: { label: localize('results.openSolver', "Open Solver"), run: () => void this.commandService.executeCommand('maengine.project.openPart6') }
			});

			this.propertiesDockService.clearProperties();

			// Register empty Results table
			this.inputDisposables.add(MAEngineTables.registerTable<IResultRow>({
				id: 'maengine.results.table',
				label: localize('table.results', "Results"),
				getData: () => ({
					columns: [
						{ id: 'field', label: localize('col.field', "Field Component"), sortable: true, getValue: (r: IResultRow) => r.field },
						{ id: 'max', label: localize('col.max', "Max Value"), align: 'right', sortable: true, getValue: (r: IResultRow) => r.max },
						{ id: 'min', label: localize('col.min', "Min Value"), align: 'right', sortable: true, getValue: (r: IResultRow) => r.min },
						{ id: 'unit', label: localize('col.unit', "Unit"), sortable: true, getValue: (r: IResultRow) => r.unit }
					],
					rows: [],
					emptyText: localize('table.resultsEmpty', "No simulation results available yet. Run the solver first.")
				})
			}));

			return false;
		}

		// When results are present
		this.frame.setEmpty(undefined);
		if (isStale) {
			this.frame.setStatus({
				text: localize('results.statusStale', "Out of date: {0}. Run the solver again to update these results.", this.currentStatus?.hint ?? ''),
				severity: 'warning',
				link: { label: localize('results.openSolver', "Open Solver"), run: () => void this.commandService.executeCommand('maengine.project.openPart6') }
			});
		} else {
			this.frame.setStatus({
				text: localize('results.statusDone', "Solution available: von Mises stress and deformation fields computed")
			});
		}

		const summary = data?.summary;
		const na = localize('val.na', "n/a");
		const vonMises = formatValue(summary?.maxVonMises_MPa, 'MPa') ?? na;
		const disp = formatValue(summary?.maxDisplacement_mm, 'mm') ?? na;
		const fos = formatValue(summary?.minSafetyFactor, '') ?? na;
		const reactionRows = Object.entries(summary?.reactionForces_N ?? {}).map(([selector, f]) => ({
			name: localize('prop.reaction', "Reaction on {0}", selector),
			value: `[${f.map(v => Number(v.toPrecision(5))).join(', ')}] N`
		}));

		// Publish summary to Properties dock
		this.propertiesDockService.setProperties({
			title: localize('results.summaryTitle', "Results Summary"),
			rows: [
				{ name: localize('prop.vonMises', "Max von Mises Stress"), value: vonMises },
				{ name: localize('prop.disp', "Max Displacement"), value: disp },
				{ name: localize('prop.fos', "Min Factor of Safety"), value: fos },
				...reactionRows
			]
		});

		// Register Results Table
		const resultRows = [
			{ field: 'Von Mises Stress', max: vonMises, min: formatValue(summary?.minVonMises_MPa, 'MPa') ?? na, unit: 'MPa' },
			{ field: 'Displacement Magnitude', max: disp, min: formatValue(summary?.minDisplacement_mm, 'mm') ?? na, unit: 'mm' }
		];

		this.inputDisposables.add(MAEngineTables.registerTable<IResultRow>({
			id: 'maengine.results.table',
			label: localize('table.results', "Results"),
			getData: () => ({
				columns: [
					{ id: 'field', label: localize('col.field', "Field Component"), sortable: true, getValue: (r: IResultRow) => r.field },
					{ id: 'max', label: localize('col.max', "Max Value"), align: 'right', sortable: true, getValue: (r: IResultRow) => r.max },
					{ id: 'min', label: localize('col.min', "Min Value"), align: 'right', sortable: true, getValue: (r: IResultRow) => r.min },
					{ id: 'unit', label: localize('col.unit', "Unit"), sortable: true, getValue: (r: IResultRow) => r.unit }
				],
				rows: resultRows
			})
		}));

		return true;
	}

	private mountViewer(viewData: IResultViewData): boolean {
		// Release any previous WebGL viewer before creating a new one
		this.clearViewport();

		const controlsBar = append(this.viewportArea, $('.ma-results-controls'));
		const stage = append(this.viewportArea, $('.ma-results-stage'));

		let updateUI: ((state: IResultViewerState) => void) | undefined;
		const viewerInstance = ResultViewer.tryCreate(stage, viewData, state => updateUI?.(state));
		if (!viewerInstance) {
			clearNode(this.viewportArea);
			return false;
		}
		this.viewer.value = viewerInstance;

		const segments = this.ensureSegmentControl();
		const fields = viewerInstance.getFields();
		const hasVonMises = fields.some(f => f.id === 'von_mises');
		const hasDispMag = fields.some(f => f.id === 'disp_mag');
		segments.setEnabled('stress', hasVonMises);
		segments.setEnabled('deformation', hasDispMag);

		// Field selector
		const fieldGroup = append(controlsBar, $('.ma-results-control-group'));
		append(fieldGroup, $('label.ma-results-control-label', undefined, localize('results.fieldLabel', "Field")));
		const fieldSelect = append(fieldGroup, $<HTMLSelectElement>('select.ma-results-select', {
			'aria-label': localize('results.fieldAria', "Contour field")
		}));
		for (const f of fields) {
			const optText = f.unit ? `${f.label} (${f.unit})` : f.label;
			append(fieldSelect, $<HTMLOptionElement>('option', { value: f.id }, optText));
		}

		// Deformation scale selector + custom number input
		const scaleGroup = append(controlsBar, $('.ma-results-control-group'));
		append(scaleGroup, $('label.ma-results-control-label', undefined, localize('results.scaleLabel', "Deformation")));
		const scaleSelect = append(scaleGroup, $<HTMLSelectElement>('select.ma-results-select', {
			'aria-label': localize('results.scaleAria', "Deformation scale")
		}));
		const initialState = viewerInstance.getState();
		const autoOption = append(scaleSelect, $<HTMLOptionElement>('option', { value: 'auto' },
			localize('results.scaleAuto', "Auto (×{0})", formatScaleFactor(initialState.autoScale))));
		append(scaleSelect, $<HTMLOptionElement>('option', { value: 'undeformed' }, localize('results.scaleUndeformed', "Undeformed (0)")));
		append(scaleSelect, $<HTMLOptionElement>('option', { value: 'true' }, localize('results.scaleTrue', "True scale (1)")));
		append(scaleSelect, $<HTMLOptionElement>('option', { value: 'custom' }, localize('results.scaleCustom', "Custom...")));

		const customScaleInput = append(scaleGroup, $<HTMLInputElement>('input.ma-results-scale-input', {
			type: 'number',
			step: 'any',
			placeholder: localize('results.scalePlaceholder', "Scale"),
			'aria-label': localize('results.customScaleAria', "Custom deformation scale factor")
		}));
		customScaleInput.style.display = 'none';

		if (!initialState.hasDisplacement) {
			scaleSelect.disabled = true;
			autoOption.disabled = true;
		}

		// Spacer + action buttons
		append(controlsBar, $('.ma-results-controls-spacer'));

		const edgesButton = append(controlsBar, $<HTMLButtonElement>('button.ma-results-tool-btn', {
			type: 'button',
			'aria-pressed': 'false',
			title: localize('results.edgesTitle', "Toggle triangle mesh edges")
		}));
		append(edgesButton, $(ThemeIcon.asCSSSelector(Codicon.layers)));
		append(edgesButton, $('span', undefined, localize('results.edges', "Edges")));

		const fitButton = append(controlsBar, $<HTMLButtonElement>('button.ma-results-tool-btn', {
			type: 'button',
			title: localize('results.fitTitle', "Fit model to view (or double-click)")
		}));
		append(fitButton, $(ThemeIcon.asCSSSelector(Codicon.screenFull)));
		append(fitButton, $('span', undefined, localize('results.fit', "Fit")));

		// Legend overlay
		const legend = append(stage, $('.ma-results-legend'));
		const legendHeader = append(legend, $('.ma-results-legend-header'));
		const legendTitle = append(legendHeader, $('.ma-results-legend-title'));
		const legendUnit = append(legendHeader, $('.ma-results-legend-unit'));
		const legendBody = append(legend, $('.ma-results-legend-body'));
		const legendBar = append(legendBody, $('.ma-results-legend-bar'));
		const legendTicks = append(legendBody, $('.ma-results-legend-ticks'));
		const legendNote = append(legend, $('.ma-results-legend-note'));

		const applyCustomScale = () => {
			const val = Number(customScaleInput.value);
			if (customScaleInput.value.trim() !== '' && Number.isFinite(val)) {
				viewerInstance.setDeformationScale('custom', val);
			}
		};

		this.viewportDisposables.add(addDisposableListener(fieldSelect, EventType.CHANGE, () => {
			viewerInstance.setField(fieldSelect.value);
		}));

		this.viewportDisposables.add(addDisposableListener(scaleSelect, EventType.CHANGE, () => {
			const mode = toDeformationScaleMode(scaleSelect.value);
			if (mode === 'custom') {
				customScaleInput.style.display = '';
				if (customScaleInput.value.trim() === '') {
					customScaleInput.value = formatScaleFactor(viewerInstance.getState().activeScale);
				}
				applyCustomScale();
				customScaleInput.focus();
				customScaleInput.select();
			} else {
				customScaleInput.style.display = 'none';
				viewerInstance.setDeformationScale(mode);
			}
		}));

		this.viewportDisposables.add(addDisposableListener(customScaleInput, EventType.INPUT, () => {
			if (scaleSelect.value === 'custom') {
				applyCustomScale();
			}
		}));
		this.viewportDisposables.add(addDisposableListener(customScaleInput, EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				applyCustomScale();
			}
		}));
		this.viewportDisposables.add(addDisposableListener(customScaleInput, EventType.BLUR, () => {
			if (scaleSelect.value === 'custom') {
				applyCustomScale();
			}
		}));

		this.viewportDisposables.add(addDisposableListener(edgesButton, EventType.CLICK, () => {
			viewerInstance.setEdgesVisible(!viewerInstance.getState().edgesVisible);
		}));
		this.viewportDisposables.add(addDisposableListener(fitButton, EventType.CLICK, () => {
			viewerInstance.fitToModel();
		}));

		updateUI = (state: IResultViewerState) => {
			fieldSelect.value = state.fieldId;
			if (state.fieldId === 'von_mises') {
				segments.setValue('stress');
			} else if (state.fieldId === 'disp_mag') {
				segments.setValue('deformation');
			} else {
				segments.setValue('other');
			}

			scaleSelect.value = state.scaleMode;
			customScaleInput.style.display = state.scaleMode === 'custom' ? '' : 'none';

			edgesButton.classList.toggle('active', state.edgesVisible);
			edgesButton.setAttribute('aria-pressed', String(state.edgesVisible));

			legendTitle.textContent = state.fieldLabel;
			legendUnit.textContent = state.unit ? `(${state.unit})` : '';
			legendUnit.style.display = state.unit ? '' : 'none';

			const isFlat = Math.abs(state.max - state.min) <= 0;
			legendBar.classList.toggle('flat', isFlat);
			legendTicks.classList.toggle('flat', isFlat);
			clearNode(legendTicks);

			if (isFlat) {
				append(legendTicks, $('span.ma-results-legend-tick', undefined, formatResultNumber(state.min)));
			} else {
				const tickCount = 6;
				const span = state.max - state.min;
				for (let i = 0; i < tickCount; i++) {
					const frac = 1 - i / (tickCount - 1);
					let tickVal = state.min + frac * span;
					if (Math.abs(tickVal) < span * 1e-12) {
						tickVal = 0;
					}
					append(legendTicks, $('span.ma-results-legend-tick', undefined, formatResultNumber(tickVal)));
				}
			}

			legendNote.textContent = localize('results.legendNote', "Surface nodes; deformation ×{0}", formatScaleFactor(state.activeScale));
		};

		updateUI(initialState);
		viewerInstance.layout();
		return true;
	}

	private mountFallback(imageDataUri: string | undefined, noteText: string): void {
		this.clearViewport();

		const segments = this.ensureSegmentControl();
		segments.setEnabled('stress', false);
		segments.setEnabled('deformation', false);
		segments.setValue('other');

		const fallback = append(this.viewportArea, $('.ma-results-fallback'));
		if (imageDataUri) {
			append(fallback, $<HTMLImageElement>('img.ma-results-fallback-image', {
				src: imageDataUri,
				alt: localize('results.fallbackAlt', "Solver contour snapshot")
			}));
		}
		append(fallback, $('.ma-results-fallback-note', undefined, noteText));
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
		this.viewer.value?.layout();
	}
}
