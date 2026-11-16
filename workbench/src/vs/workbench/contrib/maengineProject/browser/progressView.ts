/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/progressView.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMAEngineProjectService, PROJECT_PARTS } from '../../../services/maengineProject/common/maengineProject.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { nextStep, openPart, PartStatusProvider, stageIcon, stateText } from './projectParts.js';

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * MAENGINE PROGRESS VIEW
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Sits in the bottom panel tray and provides a clean overview of simulation study
 * stages, honest file-backed statuses, and quick shortcuts to open or advance stages.
 */

export const PROGRESS_VIEW_CONTAINER_ID = 'workbench.panel.maengineProgress';
export const PROGRESS_VIEW_ID = 'maengine.progress';
export const SHOW_PROGRESS_COMMAND = 'maengine.showProgress';

export class ProgressView extends ViewPane {

	static readonly ID = PROGRESS_VIEW_ID;

	private rootContainer: HTMLElement | undefined;
	private stagesList: HTMLElement | undefined;
	private emptyNotice: HTMLElement | undefined;
	private footer: HTMLElement | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly statusProvider: PartStatusProvider;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
		@IEditorService private readonly editorService: IEditorService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.statusProvider = this._register(instantiationService.createInstance(PartStatusProvider));
		this._register(this.statusProvider.onDidChange(() => this.renderStages()));
		this._register(this.projectService.onDidChangeProject(() => this.renderStages()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.rootContainer = append(container, $('.maengine-progress-view'));

		this.emptyNotice = append(this.rootContainer, $('.ma-progress-empty'));
		this.emptyNotice.textContent = localize('progress.empty', "Open or create a project to track study progress.");

		this.stagesList = append(this.rootContainer, $('ol.ma-progress-stages', {
			role: 'list',
			'aria-label': localize('progress.stagesAria', "Simulation study workflow stages"),
		}));

		this.footer = append(this.rootContainer, $('.ma-progress-footer'));

		this.renderStages();
	}

	private renderStages(): void {
		if (!this.rootContainer || !this.stagesList || !this.emptyNotice || !this.footer) {
			return;
		}

		this.renderDisposables.clear();
		clearNode(this.stagesList);
		clearNode(this.footer);

		const project = this.projectService.project;
		if (!project) {
			this.emptyNotice.style.display = 'block';
			this.stagesList.style.display = 'none';
			this.footer.style.display = 'none';
			return;
		}

		this.emptyNotice.style.display = 'none';
		this.stagesList.style.display = 'flex';
		this.footer.style.display = 'flex';

		const statuses = this.statusProvider.getAllStatuses();
		let stageIndex = 1;

		for (const part of PROJECT_PARTS) {
			const status = this.statusProvider.getStatus(part.id);
			const isNumbered = part.id !== 'marketplace';
			const item = append(this.stagesList, $(`li.ma-progress-stage.ma-stage-${status.state}`, {
				role: 'listitem',
				tabIndex: 0,
			}));

			const header = append(item, $('.ma-progress-stage-header'));

			// Stage icon
			const icon = stageIcon(status.state);
			append(header, $(`span.ma-progress-icon${ThemeIcon.asCSSSelector(icon)}`)).setAttribute('aria-hidden', 'true');

			// Number
			if (isNumbered) {
				append(header, $('span.ma-progress-stage-number', undefined, String(stageIndex++)));
			} else {
				append(header, $('span.ma-progress-stage-number', undefined, '•'));
			}

			// Title
			const cleanName = part.folder.replace(/^\d+\s+/, '');
			append(header, $('span.ma-progress-title', undefined, cleanName));

			// Status pill
			const pillClass = status.state === 'done' ? 'done' : (status.state === 'failed' || status.state === 'error' ? 'fail' : (status.state === 'warn' || status.state === 'stale' ? 'warn' : ''));
			const pill = append(header, $(`.ma-progress-pill${pillClass ? ` ${pillClass}` : ''}`));
			pill.textContent = stateText(status);

			// Action: Open part
			const openLink = append(header, $<HTMLAnchorElement>('a.ma-progress-open-btn', {
				role: 'button',
				tabIndex: 0,
			}, localize('progress.openStage', "Open")));
			this.renderDisposables.add(addDisposableListener(openLink, EventType.CLICK, () => {
				void openPart(project, part, { editorService: this.editorService, commandService: this.commandService });
			}));
			this.renderDisposables.add(addDisposableListener(openLink, EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					void openPart(project, part, { editorService: this.editorService, commandService: this.commandService });
				}
			}));

			// Detail / Hint
			if (status.hint) {
				append(item, $('.ma-progress-detail', undefined, status.hint));
			}
		}

		// Footer: next step
		const next = nextStep(statuses);
		if (next) {
			const nextPart = PROJECT_PARTS.find(p => p.id === next.part);
			if (nextPart) {
				const nextLink = append(this.footer, $<HTMLAnchorElement>('a.ma-progress-next-action', {
					role: 'button',
					tabIndex: 0,
				}, localize('progress.nextStepPrompt', "Open next step: {0}", next.label)));
				this.renderDisposables.add(addDisposableListener(nextLink, EventType.CLICK, () => {
					void openPart(project, nextPart, { editorService: this.editorService, commandService: this.commandService });
				}));
				this.renderDisposables.add(addDisposableListener(nextLink, EventType.KEY_DOWN, e => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						void openPart(project, nextPart, { editorService: this.editorService, commandService: this.commandService });
					}
				}));
			}
		}
	}
}

const progressViewIcon = registerIcon('maengine-progress-view-icon', Codicon.pulse, localize('progressViewIcon', "View icon of the MAEngine progress view."));

const progressContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: PROGRESS_VIEW_CONTAINER_ID,
	title: localize2('progress', "Progress"),
	icon: progressViewIcon,
	order: -1,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [PROGRESS_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: PROGRESS_VIEW_CONTAINER_ID,
}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: PROGRESS_VIEW_ID,
	name: localize2('progress', "Progress"),
	containerIcon: progressViewIcon,
	ctorDescriptor: new SyncDescriptor(ProgressView),
	canToggleVisibility: false,
	canMoveView: true,
	order: 0,
}], progressContainer);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SHOW_PROGRESS_COMMAND,
			title: localize2('maengine.showProgress', "Show Progress"),
			category: localize2('maengine.category', "MAEngine"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(PROGRESS_VIEW_ID, true);
	}
});
