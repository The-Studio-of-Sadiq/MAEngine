/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import '../../maengineShell/browser/media/maengineTokens.css';
import './media/startEditor.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IMAEngineProjectService } from '../../../services/maengineProject/common/maengineProject.js';
import { resolveBenchmarkUri } from './projectParts.js';
import { StartEditorInput } from './startEditorInput.js';

const OPENED_STORAGE_KEY = 'maengine.project.lastOpened';

interface IRecentProjectEntry {
	readonly path: string;
	readonly name: string;
	readonly opened: number;
}

function formatOpenedDate(time: number): string {
	const date = new Date(time);
	const today = new Date();
	if (date.toDateString() === today.toDateString()) {
		return localize('start.openedToday', "Today");
	}
	return date.toLocaleDateString(undefined, {
		day: 'numeric',
		month: 'short',
		year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
	});
}

function renderBrandMarkSvg(parent: HTMLElement): SVGSVGElement {
	const svg = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 64 44');
	svg.setAttribute('class', 'ma-brand-art mark');
	svg.setAttribute('aria-hidden', 'true');

	const defs = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'defs');
	const grad = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
	grad.setAttribute('id', 'ma-brand-grad');
	grad.setAttribute('x1', '0');
	grad.setAttribute('y1', '0');
	grad.setAttribute('x2', '0');
	grad.setAttribute('y2', '1');

	const stop1 = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'stop');
	stop1.setAttribute('offset', '0%');
	stop1.setAttribute('stop-color', 'var(--ma-brand-top, #1C6EC1)');
	const stop2 = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'stop');
	stop2.setAttribute('offset', '100%');
	stop2.setAttribute('stop-color', 'var(--ma-brand-bottom, #0B3C84)');
	grad.appendChild(stop1);
	grad.appendChild(stop2);
	defs.appendChild(grad);
	svg.appendChild(defs);

	// Hexahedral finite element isometric projection
	const topFace = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	topFace.setAttribute('d', 'M32 4 L58 15 L32 26 L6 15 Z');
	topFace.setAttribute('fill', 'url(#ma-brand-grad)');
	topFace.setAttribute('opacity', '0.9');
	topFace.setAttribute('stroke', 'var(--ma-brand-ink, #0A1F3D)');
	topFace.setAttribute('stroke-width', '1.5');
	topFace.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(topFace);

	const leftFace = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	leftFace.setAttribute('d', 'M6 15 L32 26 L32 40 L6 29 Z');
	leftFace.setAttribute('fill', 'url(#ma-brand-grad)');
	leftFace.setAttribute('opacity', '0.75');
	leftFace.setAttribute('stroke', 'var(--ma-brand-ink, #0A1F3D)');
	leftFace.setAttribute('stroke-width', '1.5');
	leftFace.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(leftFace);

	const rightFace = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	rightFace.setAttribute('d', 'M32 26 L58 15 L58 29 L32 40 Z');
	rightFace.setAttribute('fill', 'url(#ma-brand-grad)');
	rightFace.setAttribute('opacity', '0.6');
	rightFace.setAttribute('stroke', 'var(--ma-brand-ink, #0A1F3D)');
	rightFace.setAttribute('stroke-width', '1.5');
	rightFace.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(rightFace);

	// Subdivided mesh line markers
	const meshLines = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	meshLines.setAttribute('d', 'M19 9.5 L45 20.5 M45 9.5 L19 20.5 M19 20.5 L19 34.5 M45 20.5 L45 34.5');
	meshLines.setAttribute('stroke', 'var(--ma-brand-ink, #0A1F3D)');
	meshLines.setAttribute('stroke-width', '0.8');
	meshLines.setAttribute('opacity', '0.35');
	svg.appendChild(meshLines);

	parent.appendChild(svg);
	return svg;
}

export class StartEditor extends EditorPane {

	private container!: HTMLElement;
	private scrollable!: DomScrollableElement;
	private main!: HTMLElement;
	private readonly pageDisposables = this._register(new DisposableStore());
	private readonly sideDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IPathService private readonly pathService: IPathService,
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IFileService private readonly fileService: IFileService,
	) {
		super(StartEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = $('.maengine-start');
		this.scrollable = this._register(new DomScrollableElement(this.container, {
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
		}));
		append(parent, this.scrollable.getDomNode());
	}

	override async setInput(input: StartEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.renderShell();
		this.renderMainContent();
	}

	override clearInput(): void {
		this.pageDisposables.clear();
		this.sideDisposables.clear();
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		this.container.style.width = `${dimension.width}px`;
		this.container.style.height = `${dimension.height}px`;
		this.scrollable.scanDomNode();
	}

	private renderShell(): void {
		this.sideDisposables.clear();
		clearNode(this.container);

		const shell = append(this.container, $('.shell'));
		const side = append(shell, $('aside.side'));

		// Brand header
		const brand = append(side, $('.brand'));
		renderBrandMarkSvg(brand);
		append(brand, $('span.divider'));
		const brandText = append(brand, $('.brand-text'));
		const h1 = append(brandText, $('h1'));
		append(h1, $('span.brand-prefix', undefined, 'MA'));
		append(h1, $('span.brand-suffix', undefined, 'Engine'));
		append(brandText, $('p.subtitle', undefined, localize('start.subtitle', "Mechanical analysis and simulation")));

		// Start actions
		const actions = append(side, $('nav.actions', { 'aria-label': localize('start.actions', "Start") }));

		const makeAction = (icon: ThemeIcon, label: string, onClick: () => void) => {
			const button = append(actions, $('button.action', { type: 'button' }));
			append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
			append(button, $('span.label', undefined, label));
			this.sideDisposables.add(addDisposableListener(button, EventType.CLICK, onClick));
			return button;
		};

		makeAction(Codicon.newFolder, localize('start.new', "New Project..."), () => this.newProject());
		makeAction(Codicon.folderOpened, localize('start.open', "Open Project..."), () => this.openProject());
		makeAction(Codicon.library, localize('start.benchmark', "Open Benchmark Study..."), () => this.openBenchmark());
		makeAction(Codicon.play, localize('start.solver', "Open Solver Manager..."), () => this.openSolver());

		this.main = append(shell, $('main.main'));

		// Footer
		const credits = append(this.container, $('footer.credits'));
		append(credits, $('p', undefined, localize('start.footerTitle', "MAEngine — Mechanical Analysis Engine")));
		append(credits, $('p', undefined, localize('start.footerLicense', "Open-source finite-element analysis suite.")));
	}

	private renderMainContent(): void {
		this.pageDisposables.clear();
		clearNode(this.main);

		// 1. "How a study works" strip (6 stages)
		const workflowSection = append(this.main, $('.section.workflow'));
		append(workflowSection, $('h2', undefined, localize('start.workflowTitle', "How a study works")));

		const stages = [
			{ num: '01', title: localize('stage.geometry', "Geometry"), desc: localize('stage.geometryDesc', "CAD B-Rep geometry and STEP model.") },
			{ num: '02', title: localize('stage.materials', "Materials"), desc: localize('stage.materialsDesc', "Elasticity, plasticity, and density.") },
			{ num: '03', title: localize('stage.mesh', "Mesh"), desc: localize('stage.meshDesc', "Conformal tetrahedral 3D elements.") },
			{ num: '04', title: localize('stage.physics', "Physics"), desc: localize('stage.physicsDesc', "Boundary constraints and applied loads.") },
			{ num: '05', title: localize('stage.solve', "Solve"), desc: localize('stage.solveDesc', "CalculiX FEA execution and output.") },
			{ num: '06', title: localize('stage.results', "Results"), desc: localize('stage.resultsDesc', "Field contours, deformation, and reports.") },
		];

		const grid = append(workflowSection, $('.workflow-grid'));
		for (const s of stages) {
			const step = append(grid, $('.workflow-step'));
			const header = append(step, $('.workflow-step-header'));
			append(header, $('span.workflow-step-num', undefined, s.num));
			append(header, $('span.workflow-step-title', undefined, s.title));
			append(step, $('p.workflow-step-desc', undefined, s.desc));
		}

		// 2. Recent projects list
		const recentSection = append(this.main, $('.section.recent-projects'));
		append(recentSection, $('h2', undefined, localize('start.recentTitle', "Recent Projects")));

		const list = append(recentSection, $('ul.recent'));
		const recent = this.getRecentProjects();

		if (!recent.length) {
			append(list, $('li.empty', undefined, localize('start.noRecent', "No recent projects. Create a new project or open the benchmark study to begin.")));
		} else {
			for (const item of recent) {
				const li = append(list, $('li'));
				const button = append(li, $('button.recent-project', { type: 'button', title: item.path }));
				const top = append(button, $('span.top'));
				append(top, $('span.name', undefined, item.name));
				const dateStr = formatOpenedDate(item.opened);
				append(top, $('span.date', { 'aria-label': localize('start.lastOpened', "Last opened {0}", dateStr) }, dateStr));
				append(button, $('span.path', undefined, item.path));

				this.pageDisposables.add(addDisposableListener(button, EventType.CLICK, () => {
					this.recordOpened(item.path, item.name);
					void this.commandService.executeCommand('vscode.openFolder', URI.file(item.path));
				}));
			}
		}

		this.scrollable.scanDomNode();
	}

	private getRecentProjects(): IRecentProjectEntry[] {
		let map: Record<string, { name: string; opened: number }> = {};
		try {
			const raw = this.storageService.get(OPENED_STORAGE_KEY, StorageScope.APPLICATION, '{}');
			map = JSON.parse(raw);
		} catch {
			map = {};
		}

		const entries: IRecentProjectEntry[] = Object.entries(map).map(([path, data]) => ({
			path,
			name: data.name || basename(URI.file(path)),
			opened: data.opened || Date.now(),
		}));

		entries.sort((a, b) => b.opened - a.opened);
		return entries.slice(0, 8);
	}

	private recordOpened(path: string, name: string): void {
		let map: Record<string, { name: string; opened: number }> = {};
		try {
			const raw = this.storageService.get(OPENED_STORAGE_KEY, StorageScope.APPLICATION, '{}');
			map = JSON.parse(raw);
		} catch {
			map = {};
		}
		map[path] = { name, opened: Date.now() };
		this.storageService.store(OPENED_STORAGE_KEY, JSON.stringify(map), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private async newProject(): Promise<void> {
		try {
			const defaultHome = await this.pathService.userHome();
			const picked = await this.fileDialogService.showOpenDialog({
				title: localize('start.newProjectLocation', "Select Location for New Project"),
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				defaultUri: defaultHome,
			});
			if (!picked?.[0]) {
				return;
			}
			const targetFolder = picked[0];
			const projectName = 'Simulation_Project';
			const project = await this.projectService.createProject(targetFolder, projectName, 'mm_N_MPa_tonne_s');
			this.recordOpened(project.root.fsPath, projectName);
			await this.commandService.executeCommand('vscode.openFolder', project.root);
		} catch (error) {
			this.notificationService.error(error as Error);
		}
	}

	private async openProject(): Promise<void> {
		try {
			const defaultHome = await this.pathService.userHome();
			const picked = await this.fileDialogService.showOpenDialog({
				title: localize('start.openProject', "Open MAEngine Project"),
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				defaultUri: defaultHome,
			});
			if (!picked?.[0]) {
				return;
			}
			const folder = picked[0];
			this.recordOpened(folder.fsPath, basename(folder));
			await this.commandService.executeCommand('vscode.openFolder', folder);
		} catch (error) {
			this.notificationService.error(error as Error);
		}
	}

	private async openBenchmark(): Promise<void> {
		try {
			const benchmarkUri = await resolveBenchmarkUri(this.environmentService, this.fileService);
			if (!benchmarkUri) {
				this.notificationService.error(localize('benchmarkNotFound', "Cantilever Beam benchmark project could not be found (expected 'examples/cantilever_beam')."));
				return;
			}
			this.recordOpened(benchmarkUri.fsPath, 'Cantilever Beam Benchmark');
			await this.commandService.executeCommand('vscode.openFolder', benchmarkUri);
		} catch (error) {
			this.notificationService.error(error as Error);
		}
	}

	private async openSolver(): Promise<void> {
		try {
			await this.commandService.executeCommand('maengine.solver.runAll');
		} catch (error) {
			this.notificationService.error(error as Error);
		}
	}
}
