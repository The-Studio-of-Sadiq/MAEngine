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
import { SolverEditorInput } from './solverEditorInput.js';

interface ISolverLastRun {
	job?: string;
	frdFile?: string;
}

interface ISolverData {
	schema?: number;
	solver?: string;
	executable?: string;
	analysisType?: string;
	threads?: number;
	status?: 'idle' | 'running' | 'converged' | 'failed' | string;
	lastRun?: ISolverLastRun;
	convergenceResidual?: number;
	maxIterations?: number;
}

interface ISolverConvergenceRow {
	readonly step: number;
	readonly increment: number;
	readonly attempt: number;
	readonly iterations: number;
	readonly totalTime: number;
	readonly stepTime: number;
	readonly incrementTime: number;
}

export class SolverEditor extends EditorPane {

	private frame!: EditorFrame;
	private contentContainer!: HTMLElement;
	private currentData: ISolverData | undefined;
	private currentResource: URI | undefined;
	private logContent: string | undefined;
	private convergenceRows: ISolverConvergenceRow[] = [];
	private currentStatus: IPartStatus | undefined;
	private runTarget: IRunTarget | undefined;
	private runAction!: Action;

	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly statusPill = this._register(new MutableDisposable());
	private readonly convergenceTable = this._register(new MutableDisposable());

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
		this.statusPill.clear();
		this.convergenceTable.clear();
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
		this.convergenceRows = await this.loadConvergenceRows(resource, this.currentData);

		this.currentStatus = await resolvePartStatus('solver', this.fileService, this.projectService, this.currentData, resource);
		this.runTarget = await resolveRunTarget('solve', this.fileService, this.contextService, this.projectService);
		this.render();
	}

	private async loadConvergenceRows(resource: URI, data: ISolverData | undefined): Promise<ISolverConvergenceRow[]> {
		const lastRun = data?.lastRun;
		let job = typeof lastRun?.job === 'string' ? lastRun.job.trim() : '';
		if (!job && typeof lastRun?.frdFile === 'string') {
			const frd = lastRun.frdFile.trim();
			if (frd) {
				job = frd.replace(/\.[^/.\\]+$/, '');
			}
		}
		if (!job) {
			return [];
		}

		try {
			const staUri = joinPath(dirname(resource), `${job}.sta`);
			if (!await this.fileService.exists(staUri)) {
				return [];
			}
			const content = (await this.fileService.readFile(staUri)).value.toString();
			return this.parseStaFile(content);
		} catch {
			return [];
		}
	}

	private parseStaFile(content: string): ISolverConvergenceRow[] {
		const rows: ISolverConvergenceRow[] = [];
		for (const line of content.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			const parts = trimmed.split(/\s+/);
			if (parts.length < 7) {
				continue;
			}
			const step = Number(parts[0]);
			const increment = Number(parts[1]);
			const attempt = Number(parts[2]);
			const iterations = Number(parts[3]);
			const totalTime = Number(parts[4]);
			const stepTime = Number(parts[5]);
			const incrementTime = Number(parts[6]);
			if (
				Number.isFinite(step) &&
				Number.isFinite(increment) &&
				Number.isFinite(attempt) &&
				Number.isFinite(iterations) &&
				Number.isFinite(totalTime) &&
				Number.isFinite(stepTime) &&
				Number.isFinite(incrementTime)
			) {
				rows.push({ step, increment, attempt, iterations, totalTime, stepTime, incrementTime });
			}
		}
		return rows;
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
		this.convergenceTable.value = MAEngineTables.registerTable<ISolverConvergenceRow>({
			id: 'maengine.solver.convergence',
			label: localize('table.solverConvergence', "Solver Convergence"),
			getData: () => ({
				columns: [
					{ id: 'step', label: localize('col.step', "Step"), align: 'right', sortable: true, getValue: (r: ISolverConvergenceRow) => r.step },
					{ id: 'increment', label: localize('col.increment', "Increment"), align: 'right', sortable: true, getValue: (r: ISolverConvergenceRow) => r.increment },
					{ id: 'attempt', label: localize('col.attempt', "Attempt"), align: 'right', sortable: true, getValue: (r: ISolverConvergenceRow) => r.attempt },
					{ id: 'iterations', label: localize('col.iterations', "Iterations"), align: 'right', sortable: true, getValue: (r: ISolverConvergenceRow) => r.iterations },
					{ id: 'totalTime', label: localize('col.totalTime', "Total time"), align: 'right', sortable: true, getValue: (r: ISolverConvergenceRow) => r.totalTime },
					{ id: 'stepTime', label: localize('col.stepTime', "Step time"), align: 'right', sortable: true, getValue: (r: ISolverConvergenceRow) => r.stepTime },
					{ id: 'incrementTime', label: localize('col.incrementTime', "Increment time"), align: 'right', sortable: true, getValue: (r: ISolverConvergenceRow) => r.incrementTime }
				],
				rows: this.convergenceRows,
				emptyText: localize('table.solverEmpty', "No solver run yet.")
			})
		});

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
		const analysisType = data.analysisType || 'static_linear';
		if (analysisType !== 'static_linear') {
			append(selType, $<HTMLOptionElement>('option', { value: analysisType }, localize('solver.unsupportedAnalysisType', "{0} (not supported yet)", analysisType)));
		}
		selType.value = analysisType;

		// Solver Executable
		const fExe = append(left, $('.ma-solver-field'));
		append(fExe, $('label', undefined, localize('solver.solverBinary', "Solver Engine")));
		const inpExe = append(fExe, $<HTMLInputElement>('input', { type: 'text', disabled: 'true' }));
		inpExe.value = `${data.solver ?? 'calculix'} (${data.executable ?? 'ccx'})`;

		// Parallel Threads
		const fThreads = append(left, $('.ma-solver-field'));
		append(fThreads, $('label', undefined, localize('solver.threads', "Parallel threads (blank = all cores)")));
		const inpThreads = append(fThreads, $<HTMLInputElement>('input', {
			type: 'number',
			min: '1',
			max: '256',
			step: '1',
			placeholder: localize('solver.allCores', "all cores")
		}));
		inpThreads.value = typeof data.threads === 'number' ? String(data.threads) : '';

		// Save Button
		const saveBtn = append(left, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('solver.saveSettings', "Apply Configuration")));
		saveBtn.style.padding = '4px 12px';
		saveBtn.style.marginTop = 'var(--ma-space-2, 8px)';

		this.inputDisposables.add(addDisposableListener(saveBtn, EventType.CLICK, async () => {
			if (!this.currentResource || !this.currentData) {
				return;
			}
			const rawThreads = inpThreads.value.trim();
			if (rawThreads === '') {
				delete this.currentData.threads;
			} else {
				const parsedThreads = Number(rawThreads);
				if (!Number.isInteger(parsedThreads) || parsedThreads < 1 || parsedThreads > 256) {
					this.notificationService.error(localize('solver.invalidThreads', "Parallel threads must be an integer between 1 and 256, or blank for all cores."));
					return;
				}
				this.currentData.threads = parsedThreads;
			}
			this.currentData.analysisType = selType.value;

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
				{ name: localize('prop.threads', "Parallel Threads"), value: typeof data.threads === 'number' ? String(data.threads) : localize('solver.allCores', "all cores") },
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
