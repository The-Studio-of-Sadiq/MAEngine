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
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
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
import { IPartStatus, IRunTarget, resolvePartStatus, resolveRunTarget } from '../../maengineProject/browser/projectParts.js';
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
	private runTarget: IRunTarget | undefined;
	private runAction!: Action;

	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly statusPill = this._register(new MutableDisposable());

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
				// Readiness depends on the other parts too (CAD import, supports, selectors).
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

		// The engine's run log (run.log: what the study run did, or why it could not start)
		// followed by CalculiX's own output (calculix.log). The terminal is hidden outside
		// developer mode, so this is where a run's outcome is shown.
		const logs: string[] = [];
		for (const name of ['run.log', 'calculix.log']) {
			try {
				const logUri = joinPath(dirname(resource), name);
				if (await this.fileService.exists(logUri)) {
					logs.push((await this.fileService.readFile(logUri)).value.toString());
				}
			} catch {
				// unreadable log: skip it
			}
		}
		this.logContent = logs.length ? logs.join('\n') : undefined;

		this.currentStatus = await resolvePartStatus('solver', this.fileService, this.projectService, this.currentData, resource);
		this.runTarget = await resolveRunTarget('solve', this.fileService, this.contextService, this.projectService);
		this.render();
	}

	private render(): void {
		const data = this.currentData ?? {};
		const isStale = this.currentStatus?.state === 'stale';
		const isConverged = this.currentStatus?.state === 'done' || isStale;
		const isRunning = this.currentStatus?.state === 'inProgress';
		const isFailed = this.currentStatus?.state === 'failed';

		// Keep button enabled only when running is possible
		// Left enabled while a run is marked running, so a killed run can be restarted.
		const canRun = !!this.runTarget?.canRun;
		this.runAction.enabled = canRun;

		// Bottom Hint Strip
		if (isConverged && !canRun && this.runTarget?.kind === 'study') {
			// The last run converged, but the study has changed since and cannot run as it stands.
			this.frame.setStatus({
				text: localize('solver.convergedCannotRerun', "Last run converged. Can't run again yet: {0}", this.runTarget.reason ?? ''),
				severity: 'warning',
				link: { label: localize('solver.openResults', "Open Results"), run: () => void this.commandService.executeCommand('maengine.project.openPart7') }
			});
		} else if (isStale) {
			this.frame.setStatus({
				text: localize('solver.staleHint', "Last run converged, but its results are out of date: {0}", this.currentStatus?.hint ?? ''),
				severity: 'warning',
				link: canRun ? { label: localize('solver.runAgain', "Run again"), run: () => this.runSolver() } : undefined
			});
		} else if (isConverged) {
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
				link: canRun ? { label: localize('solver.retry', "Retry"), run: () => this.runSolver() } : undefined
			});
		} else {
			if (!canRun) {
				this.frame.setStatus({
					text: localize('solver.cannotRunHint', "Can't run yet: {0}", this.runTarget?.reason ?? localize('solver.noRunTarget', "no study is open"))
				});
			} else {
				this.frame.setStatus({
					text: localize('solver.notRunHint', "Solver status: not run"),
					link: { label: localize('solver.runAction', "Run Solver"), run: () => this.runSolver() }
				});
			}
		}

		// Status pill in toolbar endSlot
		// One pill at most: render() runs on every file change.
		this.statusPill.value = isStale
			? this.frame.createPill(localize('status.outOfDate', "Out of date"), { icon: Codicon.history, severity: 'warn', title: this.currentStatus?.hint })
			: isConverged
				? this.frame.createPill(localize('status.converged', "Converged"), { icon: Codicon.passFilled })
				: undefined;

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
			const logBox = append(right, $('pre.ma-solver-log-box'));
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
		const isStale = this.currentStatus?.state === 'stale';
		const isConverged = this.currentStatus?.state === 'done';
		const isRunning = this.currentStatus?.state === 'inProgress';
		const isFailed = this.currentStatus?.state === 'failed';
		const statusText = isStale ? 'converged (out of date)' : isConverged ? 'converged' : isRunning ? 'running' : isFailed ? 'failed' : 'not run';

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
