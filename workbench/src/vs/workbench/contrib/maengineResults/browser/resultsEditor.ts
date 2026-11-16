/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/resultsEditor.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
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

interface IResultsSummary {
	readonly maxVonMises_MPa?: number | null;
	readonly maxDisplacement_mm?: number | null;
	readonly minSafetyFactor?: number | null;
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
	readonly summary?: IResultsSummary;
}

export class ResultsEditor extends EditorPane {

	private frame!: EditorFrame;
	private currentData: IResultsData | undefined;
	private viewportArea!: HTMLElement;
	private segmentControl: ISegmentedControl<'stress' | 'deformation'> | undefined;
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
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();

		const resource = (input as ResultsEditorInput).resource;
		if (resource) {
			const folder = dirname(resource);
			const solverFolder = joinPath(dirname(folder), '06 Solver');
			this.inputDisposables.add(this.fileService.onDidFilesChange(e => {
				if (e.contains(resource) || e.affects(folder) || e.affects(solverFolder)) {
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
			this.currentData = JSON.parse(content.value.toString()) as IResultsData;
		} catch {
			this.currentData = undefined;
		}
		this.currentStatus = await resolvePartStatus('results', this.fileService, this.projectService, this.currentData, resource);
		this.render();
	}

	private render(): void {
		const data = this.currentData;
		const hasResults = this.currentStatus?.state === 'done';

		if (!hasResults) {
			if (this.segmentControl) {
				this.segmentControl.dispose();
				this.segmentControl = undefined;
			}
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

			clearNode(this.viewportArea);
			return;
		}

		// When results are present
		this.frame.setEmpty(undefined);
		this.frame.setStatus({
			text: localize('results.statusDone', "Solution available: von Mises stress and deformation fields computed")
		});

		const summary = data?.summary;
		const vonMises = summary?.maxVonMises_MPa ? `${summary.maxVonMises_MPa} MPa` : localize('val.na', "n/a");
		const disp = summary?.maxDisplacement_mm ? `${summary.maxDisplacement_mm} mm` : localize('val.na', "n/a");
		const fos = summary?.minSafetyFactor ? String(summary.minSafetyFactor) : localize('val.na', "n/a");

		// Publish summary to Properties dock
		this.propertiesDockService.setProperties({
			title: localize('results.summaryTitle', "Results Summary"),
			rows: [
				{ name: localize('prop.vonMises', "Max von Mises Stress"), value: vonMises },
				{ name: localize('prop.disp', "Max Displacement"), value: disp },
				{ name: localize('prop.fos', "Min Factor of Safety"), value: fos }
			]
		});

		// Register Results Table
		const resultRows = [
			{ field: 'Von Mises Stress', max: vonMises, min: '0.0 MPa', unit: 'MPa' },
			{ field: 'Displacement Magnitude', max: disp, min: '0.0 mm', unit: 'mm' }
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

		// Render viewport
		clearNode(this.viewportArea);
		const box = append(this.viewportArea, $('.ma-results-canvas-box'));
		append(box, $('span', undefined, localize('results.previewNote', "3D FEA Results Contour Field")));

		if (!this.segmentControl) {
			this.segmentControl = this._register(this.frame.createSegmented(
				this.frame.titleSlot,
				[
					{ id: 'stress', label: localize('results.stress', "Stress"), icon: Codicon.graph },
					{ id: 'deformation', label: localize('results.deformation', "Deformation"), icon: Codicon.symbolRuler }
				],
				'stress',
				() => {}
			));
		}
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
