/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import '../../maengineShell/browser/media/maengineTokens.css';
import './media/projectNavigator.css';
import './projectStageBar.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMAEngineProjectService, PROJECT_PARTS } from '../../../services/maengineProject/common/maengineProject.js';
import { ProjectNavigatorView } from './projectNavigatorView.js';
import { openPart } from './projectParts.js';

export const MAENGINE_VIEW_CONTAINER_ID = 'workbench.view.maengine.project';
const projectOpen = ContextKeyExpr.has('maengineProjectOpen');
const category = localize2('maengine.category', "MAEngine");
const REVEAL_IN_OS_COMMAND_ID = 'revealFileInOS';

const projectViewIcon = registerIcon('maengine-project-view-icon', Codicon.project, localize('projectViewIcon', "View icon of the MAEngine project sidebar."));

const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: MAENGINE_VIEW_CONTAINER_ID,
	title: localize2('project', "Project"),
	icon: projectViewIcon,
	order: 0,
	hideIfEmpty: false,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [MAENGINE_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'workbench.view.maengine.project.state',
	openCommandActionDescriptor: {
		id: MAENGINE_VIEW_CONTAINER_ID,
		title: localize2('showProject', "Project"),
		order: 0,
	},
}, ViewContainerLocation.Sidebar, { isDefault: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: ProjectNavigatorView.ID,
	name: localize2('projectParts', "Project"),
	containerIcon: projectViewIcon,
	ctorDescriptor: new SyncDescriptor(ProjectNavigatorView),
	canToggleVisibility: false,
	canMoveView: true,
	order: 0,
}], container);

// Project Context Key Contribution
class ProjectContextContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.maengine.projectContext';

	constructor(
		@IMAEngineProjectService projectService: IMAEngineProjectService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const key = new RawContextKey<boolean>('maengineProjectOpen', false).bindTo(contextKeyService);
		const update = () => key.set(!!projectService.project);
		this._register(projectService.onDidChangeProject(update));
		update();
	}
}

registerWorkbenchContribution2(ProjectContextContribution.ID, ProjectContextContribution, WorkbenchPhase.BlockStartup);

// Ctrl+K Ctrl+1..8 to open workflow parts
for (let number = 1; number <= 8; number++) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `maengine.project.openPart${number}`,
				title: localize2('maengine.openPartN', "Open Part {0}", number),
				category,
				f1: true,
				precondition: projectOpen,
				keybinding: {
					primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | (KeyCode.Digit0 + number)),
					when: projectOpen,
					weight: KeybindingWeight.WorkbenchContrib + 10,
				},
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const projectService = accessor.get(IMAEngineProjectService);
			const project = projectService.project;
			const part = PROJECT_PARTS[number - 1];
			if (project && part) {
				await openPart(project, part, {
					editorService: accessor.get(IEditorService),
					commandService: accessor.get(ICommandService),
				});
			}
		}
	});
}

// Reveal in OS command
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'maengine.project.revealInOS',
			title: localize2('maengine.revealProject', "Open Folder in File Explorer"),
			category,
			f1: true,
			precondition: projectOpen,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const project = accessor.get(IMAEngineProjectService).project;
		if (project) {
			try {
				const nativeHostService = accessor.get(INativeHostService);
				if (nativeHostService) {
					await nativeHostService.showItemInFolder(project.root.fsPath);
					return;
				}
			} catch {
				// Fallback to revealFileInOS command
			}
			await accessor.get(ICommandService).executeCommand(REVEAL_IN_OS_COMMAND_ID, project.root);
		}
	}
});
