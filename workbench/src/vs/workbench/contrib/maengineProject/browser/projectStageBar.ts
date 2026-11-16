/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/projectNavigator.css';
import './media/projectStageBar.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IBannerService } from '../../../services/banner/browser/bannerService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IMAEngineProjectService, IMechastudioProject, PROJECT_PARTS } from '../../../services/maengineProject/common/maengineProject.js';
import { nextStep, openPart, PartState, PartStatusProvider, stageIcon, stateLabel } from './projectParts.js';

const STAGE_BAR_HEIGHT = 28;

interface IWorkflowStage {
	readonly id: string;
	readonly partId: string;
	readonly label: string;
}

const STAGES: readonly IWorkflowStage[] = [
	{ id: 'geometry', partId: 'geometry', label: localize('stage.geometry', "Geometry") },
	{ id: 'materials', partId: 'materials', label: localize('stage.materials', "Materials") },
	{ id: 'mesh', partId: 'mesh', label: localize('stage.mesh', "Mesh") },
	{ id: 'physics', partId: 'physics', label: localize('stage.physics', "Physics") },
	{ id: 'solver', partId: 'solver', label: localize('stage.solve', "Solve") },
	{ id: 'results', partId: 'results', label: localize('stage.results', "Results") },
];

export class ProjectStageBar extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.maengine.projectStageBar';

	private readonly element = $('.sa-stage-bar');
	private readonly strip = this._register(new MutableDisposable<IDisposable>());
	private readonly rendered = this._register(new DisposableStore());
	private readonly scheduler = this._register(new RunOnceScheduler(() => this.render(), 50));
	private buttons: HTMLElement[] = [];
	private focusIndex = 0;
	private readonly statusProvider: PartStatusProvider;

	constructor(
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
		@IBannerService private readonly bannerService: IBannerService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IHoverService private readonly hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.statusProvider = this._register(instantiationService.createInstance(PartStatusProvider));

		this.element.setAttribute('role', 'toolbar');
		this.element.setAttribute('aria-label', localize('stageBar.aria', "Project workflow stages"));
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, e => this.onKeyDown(new StandardKeyboardEvent(e))));
		this._register(this.projectService.onDidChangeProject(() => this.scheduler.schedule()));
		this._register(this.statusProvider.onDidChange(() => this.scheduler.schedule()));

		this.render();
	}

	private render(): void {
		const project = this.projectService.project;
		if (!project) {
			this.strip.clear();
			return;
		}

		const hadFocus = this.element.contains(this.element.ownerDocument.activeElement);
		this.rendered.clear();
		clearNode(this.element);

		const statuses = this.statusProvider.getAllStatuses();
		const next = nextStep(statuses);

		this.buttons = STAGES.map((stage, index) => {
			if (index > 0) {
				append(this.element, $(`span.sa-stage-sep${ThemeIcon.asCSSSelector(Codicon.chevronRight)}`)).setAttribute('aria-hidden', 'true');
			}
			const status = this.statusProvider.getStatus(stage.partId);
			const isNext = next?.part === stage.partId;
			return this.renderStage(project, stage, status.state, status.text, isNext);
		});

		this.focusIndex = Math.min(this.focusIndex, Math.max(0, this.buttons.length - 1));
		this.buttons.forEach((button, index) => button.tabIndex = index === this.focusIndex ? 0 : -1);

		if (hadFocus && this.buttons[this.focusIndex]) {
			this.buttons[this.focusIndex].focus();
		}

		if (!this.strip.value) {
			this.strip.value = this.showStrip(this.element, STAGE_BAR_HEIGHT);
		}
	}

	private renderStage(project: IMechastudioProject, stage: IWorkflowStage, state: PartState, text: string, isNext: boolean): HTMLElement {
		const button = append(this.element, $<HTMLButtonElement>(`button.sa-stage.sa-stage-${state}`));
		button.type = 'button';
		button.classList.toggle('sa-stage-next', isNext);
		append(button, $(`span.sa-stage-icon${ThemeIcon.asCSSSelector(stageIcon(state))}`)).setAttribute('aria-hidden', 'true');
		append(button, $('span.sa-stage-label', undefined, stage.label));

		if (state === 'failed' || state === 'stale') {
			append(button, $('span.sa-stage-text', undefined, text));
		}

		const tooltip = `${stage.label}: ${stateLabel(this.statusProvider.getStatus(stage.partId))}${text ? ` (${text})` : ''}\n${localize('stageBar.clickToOpen', "Click to open {0}.", stage.label)}`;
		button.setAttribute('aria-label', tooltip);
		if (isNext) {
			button.setAttribute('aria-current', 'step');
		}

		this.rendered.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, tooltip));
		this.rendered.add(addDisposableListener(button, EventType.CLICK, () => void this.openStage(project, stage)));
		this.rendered.add(addDisposableListener(button, EventType.FOCUS, () => {
			this.focusIndex = this.buttons.indexOf(button);
			this.buttons.forEach(b => b.tabIndex = b === button ? 0 : -1);
		}));

		return button;
	}

	private async openStage(project: IMechastudioProject, stage: IWorkflowStage): Promise<void> {
		const part = PROJECT_PARTS.find(p => p.id === stage.partId);
		if (!part) {
			return;
		}
		await openPart(project, part, {
			editorService: this.editorService,
			commandService: this.commandService,
		});
	}

	private showStrip(element: HTMLElement, height: number): IDisposable {
		const bannerPart = (this.layoutService as any).getPart?.(Parts.BANNER_PART);
		if (bannerPart) {
			try {
				bannerPart.height = height;
				this.bannerService.show({
					id: 'maengine.stageBar',
					message: '',
					icon: undefined,
					priority: 1000,
				});
				const container = bannerPart.element as HTMLElement | undefined;
				if (container) {
					clearNode(container);
					append(container, element);
				}
				return toDisposable(() => {
					this.bannerService.hide('maengine.stageBar');
					element.remove();
				});
			} catch {
				// Fall through to layout container fallback
			}
		}

		const titleBarContainer = this.layoutService.getContainer(mainWindow, Parts.TITLEBAR_PART);
		if (titleBarContainer && titleBarContainer.parentElement) {
			titleBarContainer.parentElement.insertBefore(element, titleBarContainer.nextSibling);
			element.style.height = `${height}px`;
			return toDisposable(() => element.remove());
		}

		return toDisposable(() => {});
	}

	private onKeyDown(event: StandardKeyboardEvent): void {
		const count = this.buttons.length;
		if (!count) {
			return;
		}
		let index: number | undefined;
		if (event.equals(KeyCode.RightArrow)) {
			index = (this.focusIndex + 1) % count;
		} else if (event.equals(KeyCode.LeftArrow)) {
			index = (this.focusIndex - 1 + count) % count;
		} else if (event.equals(KeyCode.Home)) {
			index = 0;
		} else if (event.equals(KeyCode.End)) {
			index = count - 1;
		}
		if (index !== undefined) {
			event.preventDefault();
			event.stopPropagation();
			this.buttons[index].focus();
		}
	}
}

registerWorkbenchContribution2(ProjectStageBar.ID, ProjectStageBar, WorkbenchPhase.AfterRestored);
