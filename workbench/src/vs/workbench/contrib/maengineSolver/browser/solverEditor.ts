/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/solverEditor.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
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
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { EditorFrame } from '../../maengineProject/browser/editorFrame.js';
import { IMAEnginePropertiesDockService } from '../../maengineProject/browser/propertiesDock.js';
import { MAEngineTables } from '../../maengineProject/browser/tablesView.js';
import { IPartStatus, resolvePartStatus, workspaceHasSimulationYaml } from '../../maengineProject/browser/projectParts.js';
import { IMAEngineProjectService } from '../../../services/maengineProject/common/maengineProject.js';
import { SolverEditorInput } from './solverEditorInput.js';

interface ISolverData {
	schema?: number;
	solver?: string;
	executable?: string;
	analysisType?: string;
	threads?: number;
	status?: 'idle' | 'running' | 'converged' | 'failed' | string;
	convergenceResidual?: number;
	maxIterations?: number;
}

interface ISolverConvergenceRow {
	readonly iteration: number;
	readonly residual: string;
	readonly dispCorrection: string;
	readonly status: string;
}

export class SolverEditor extends EditorPane {

	private frame!: EditorFrame;
	private contentContainer!: HTMLElement;
	private currentData: ISolverData | undefined;
	private currentResource: any;
	private logContent: string | undefined;
	private currentStatus: IPartStatus | undefined;
	private hasSimulationYaml = false;
	private runAction!: Action;

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
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super(SolverEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.frame = this._register(this.instantiationService.createInstance(EditorFrame, parent, {
			id: 'maengine.solverEditor',
			ariaLabel: localize('solverEditor.aria', "Solver"),
			properties: { title: localize('properties', "Properties") }
		}));
		this.frame.element.classList.add('maengine-solver-editor');
		this.frame.setTitle(localize('solver.title', "Solver"));

		this.runAction = this._register(new Action(
			'maengine.solver.run',
			localize('solver.runAction', "Run Solver"),
			ThemeIcon.asClassName(Codicon.play),
			true,
			async () => this.runSolver()
		));

		this.frame.setActions([this.runAction, this.frame.togglePropertiesAction]);

		this.contentContainer = append(this.frame.main, $('.ma-solver-content'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();

		const resource = (input as SolverEditorInput).resource;
		this.currentResource = resource;
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
			this.currentData = JSON.parse(content.value.toString()) as ISolverData;
		} catch {
			this.currentData = undefined;
		}

		// Try to read log file if present
		try {
			const dir = dirname(resource);
			const logUri = joinPath(dir, 'calculix.log');
			if (await this.fileService.exists(logUri)) {
				const log = await this.fileService.readFile(logUri);
				this.logContent = log.value.toString();
			} else {
				this.logContent = undefined;
			}
		} catch {
			this.logContent = undefined;
		}

		this.currentStatus = await resolvePartStatus('solver', this.fileService, this.projectService, this.currentData, resource);
		this.hasSimulationYaml = await workspaceHasSimulationYaml(this.fileService, this.contextService, this.projectService);
		this.render();
	}

	private render(): void {
		const data = this.currentData ?? {};
		const isConverged = this.currentStatus?.state === 'done';
		const isRunning = this.currentStatus?.state === 'inProgress';
		const isFailed = this.currentStatus?.state === 'failed';

		// Keep button enabled only when running is possible
		this.runAction.enabled = this.hasSimulationYaml;

		// Bottom Hint Strip
		if (isConverged) {
			this.frame.setStatus({
				text: localize('solver.convergedHint', "Solver completed: solution converged"),
				severity: 'info',
				link: { label: localize('solver.openResults', "Open Results"), run: () => void this.commandService.executeCommand('maengine.project.openPart7') }
			});
		} else if (isRunning) {
			this.frame.setStatus({
				text: localize('solver.runningHint', "Solver execution in progress..."),
				severity: 'info',
				busy: true
			});
		} else if (isFailed) {
			this.frame.setStatus({
				text: localize('solver.failedHint', "Solver run failed: check log output for details"),
				severity: 'error',
				link: this.hasSimulationYaml ? { label: localize('solver.retry', "Retry"), run: () => this.runSolver() } : undefined
			});
		} else {
			if (!this.hasSimulationYaml) {
				this.frame.setStatus({
					text: localize('solver.notConnectedHint', "Run isn't connected for this study yet")
				});
			} else {
				this.frame.setStatus({
					text: localize('solver.notRunHint', "Solver status: not run"),
					link: { label: localize('solver.runAction', "Run Solver"), run: () => this.runSolver() }
				});
			}
		}

		// Status pill in toolbar endSlot
		if (isConverged) {
			this.inputDisposables.add(this.frame.createPill(localize('status.converged', "Converged"), { severity: 'warn', icon: Codicon.passFilled }));
		}

		// Register Convergence table to bottom Tables panel
		this.inputDisposables.add(MAEngineTables.registerTable<ISolverConvergenceRow>({
			id: 'maengine.solver.convergence',
			label: localize('table.solverConvergence', "Solver Convergence"),
			getData: () => ({
				columns: [
					{ id: 'iteration', label: localize('col.iter', "Iteration"), sortable: true, getValue: (r: ISolverConvergenceRow) => r.iteration },
					{ id: 'residual', label: localize('col.residual', "Force Residual"), align: 'right', sortable: true, getValue: (r: ISolverConvergenceRow) => r.residual },
					{ id: 'dispCorrection', label: localize('col.dispCorr', "Disp. Correction"), align: 'right', sortable: true, getValue: (r: ISolverConvergenceRow) => r.dispCorrection },
					{ id: 'status', label: localize('col.iterStatus', "Status"), sortable: true, getValue: (r: ISolverConvergenceRow) => r.status }
				],
				rows: [],
				emptyText: localize('table.solverEmpty', "No convergence data available yet. Run the solver first.")
			})
		}));

		// Render Content Layout
		clearNode(this.contentContainer);

		const layout = append(this.contentContainer, $('.ma-solver-layout'));

		// Left: Configuration Pane
		const left = append(layout, $('.ma-solver-pane'));
		append(left, $('.ma-solver-pane-title', undefined, localize('solver.configTitle', "Run Configuration")));

		// Analysis Type
		const fType = append(left, $('.ma-solver-field'));
		append(fType, $('label', undefined, localize('solver.analysisType', "Analysis Step Type")));
		const selType = append(fType, $<HTMLSelectElement>('select'));
		append(selType, $<HTMLOptionElement>('option', { value: 'static_linear' }, localize('solver.staticLinear', "Static Linear Stress (*STATIC)")));
		append(selType, $<HTMLOptionElement>('option', { value: 'frequency_modal' }, localize('solver.frequencyModal', "Modal Extraction (*FREQUENCY)")));
		append(selType, $<HTMLOptionElement>('option', { value: 'heat_transfer' }, localize('solver.heatTransfer', "Steady Heat Transfer (*HEAT TRANSFER)")));
		selType.value = data.analysisType ?? 'static_linear';

		// Solver Executable
		const fExe = append(left, $('.ma-solver-field'));
		append(fExe, $('label', undefined, localize('solver.solverBinary', "Solver Engine")));
		const inpExe = append(fExe, $<HTMLInputElement>('input', { type: 'text', disabled: 'true' }));
		inpExe.value = `${data.solver ?? 'calculix'} (${data.executable ?? 'ccx'})`;

		// Parallel Threads
		const fThreads = append(left, $('.ma-solver-field'));
		append(fThreads, $('label', undefined, localize('solver.threads', "Parallel Threads")));
		const inpThreads = append(fThreads, $<HTMLInputElement>('input', { type: 'number', min: '1', max: '64' }));
		inpThreads.value = String(data.threads ?? 4);

		// Convergence Residual
		const fRes = append(left, $('.ma-solver-field'));
		append(fRes, $('label', undefined, localize('solver.residual', "Convergence Residual (Relative)")));
		const inpRes = append(fRes, $<HTMLInputElement>('input', { type: 'number', step: '0.0001' }));
		inpRes.value = String(data.convergenceResidual ?? 0.0001);

		// Max Iterations
		const fIter = append(left, $('.ma-solver-field'));
		append(fIter, $('label', undefined, localize('solver.maxIter', "Max Equilibrium Iterations")));
		const inpIter = append(fIter, $<HTMLInputElement>('input', { type: 'number', min: '10' }));
		inpIter.value = String(data.maxIterations ?? 100);

		// Save Button
		const saveBtn = append(left, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('solver.saveSettings', "Apply Configuration")));
		saveBtn.style.padding = '4px 12px';
		saveBtn.style.marginTop = 'var(--ma-space-2, 8px)';

		this.inputDisposables.add(addDisposableListener(saveBtn, EventType.CLICK, async () => {
			if (!this.currentResource || !this.currentData) {
				return;
			}
			this.currentData.analysisType = selType.value;
			this.currentData.threads = Number(inpThreads.value);
			this.currentData.convergenceResidual = Number(inpRes.value);
			this.currentData.maxIterations = Number(inpIter.value);

			await this.fileService.writeFile(this.currentResource, VSBuffer.fromString(JSON.stringify(this.currentData, null, '\t')));
			this.notificationService.info(localize('solver.configSaved', "Solver configuration saved."));
			this.updateProperties();
		}));

		// Right: Log Area
		const right = append(layout, $('.ma-solver-log-container'));
		const logHeader = append(right, $('.ma-solver-log-header'));
		append(logHeader, $('span', undefined, localize('solver.logHeader', "Solver Run Log")));

		if (this.logContent) {
			const logBox = append(right, $('<pre>.ma-solver-log-box'));
			logBox.textContent = this.logContent;
		} else {
			const emptyBox = append(right, $('.ma-solver-empty-log'));
			append(emptyBox, $(ThemeIcon.asCSSSelector(Codicon.terminal)));
			append(emptyBox, $('span', undefined, localize('solver.emptyLogText', "No solver run log yet. Click 'Run Solver' to execute the analysis deck.")));
		}

		this.updateProperties();
	}

	private updateProperties(): void {
		const data = this.currentData ?? {};
		const isConverged = this.currentStatus?.state === 'done';
		const isRunning = this.currentStatus?.state === 'inProgress';
		const isFailed = this.currentStatus?.state === 'failed';
		const statusText = isConverged ? 'converged' : isRunning ? 'running' : isFailed ? 'failed' : 'not run';

		this.propertiesDockService.setProperties({
			title: localize('solver.propertiesTitle', "Solver Configuration"),
			detail: data.solver ?? "CalculiX",
			rows: [
				{ name: localize('prop.engine', "Solver Engine"), value: `${data.solver ?? 'calculix'} (${data.executable ?? 'ccx'})` },
				{ name: localize('prop.analysisType', "Analysis Step Type"), value: data.analysisType ?? "static_linear" },
				{ name: localize('prop.threads', "Parallel Threads"), value: String(data.threads ?? 4) },
				{ name: localize('prop.residual', "Convergence Tolerance"), value: String(data.convergenceResidual ?? 0.0001) },
				{ name: localize('prop.maxIter', "Max Iterations"), value: String(data.maxIterations ?? 100) },
				{ name: localize('prop.status', "Execution Status"), value: statusText }
			]
		});
	}

	private runSolver(): void {
		void this.commandService.executeCommand('maengine.solve.run');
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
