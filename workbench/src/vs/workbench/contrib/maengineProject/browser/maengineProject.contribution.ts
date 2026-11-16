/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMAEngineProjectService, UnitSystem } from '../../../services/maengineProject/common/maengineProject.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalGroupService, ITerminalService } from '../../terminal/browser/terminal.js';
import { StartEditor } from './startEditor.js';
import { StartEditorInput } from './startEditorInput.js';

const category = localize2('maengine.category', "MAEngine");

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(StartEditor, StartEditorInput.EDITOR_ID, localize('maengineStartEditor', "MAEngine Start")),
	[new SyncDescriptor(StartEditorInput)]
);

export function openStartPage(editorService: IEditorService): Promise<unknown> {
	return editorService.openEditor(StartEditorInput.instance, { pinned: true });
}

class StartWindowContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.maengine.startWindow';

	constructor(
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		void this.showIfNoProject();
		setTimeout(() => {
			void this.showIfNoProject();
		}, 300);

		this._register(this.editorService.onDidCloseEditor(() => {
			if (this.editorService.count === 0) {
				void openStartPage(this.editorService);
			}
		}));
	}

	private async showIfNoProject(): Promise<void> {
		// Always open the start page on fresh launch – MAEngine replaces VS Code's default welcome
		await openStartPage(this.editorService);
	}
}

registerWorkbenchContribution2(StartWindowContribution.ID, StartWindowContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'maengine.project.showStart',
			title: localize2('maengine.showStart', "Show MAEngine Start Window"),
			category,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): unknown {
		return openStartPage(accessor.get(IEditorService));
	}
});

CommandsRegistry.registerCommand('maengine.project.loadBenchmark', async (accessor: ServicesAccessor, benchmarkName?: string) => {
	const notificationService = accessor.get(INotificationService);
	const commandService = accessor.get(ICommandService);
	notificationService.info(`Opening MAEngine benchmark: ${benchmarkName || 'Cantilever Beam'}...`);
	const repoRootUri = URI.file('C:\\Users\\rashe\\Documents\\MAEngine\\examples\\cantilever_beam');
	await commandService.executeCommand('vscode.openFolder', repoRootUri);
});

CommandsRegistry.registerCommand('maengine.project.create', async (accessor: ServicesAccessor, args?: { name: string; units: UnitSystem }) => {
	const projectService = accessor.get(IMAEngineProjectService);
	const commandService = accessor.get(ICommandService);
	const contextService = accessor.get(IWorkspaceContextService);

	const name = args?.name || 'New_Simulation_Project';
	const units = args?.units || 'mm_N_MPa_tonne_s';

	// Default target directory
	const root = contextService.getWorkspace().folders[0]?.uri || URI.file('C:\\Users\\rashe\\Documents\\MAEngine Projects');
	const project = await projectService.createProject(root, name, units);
	await commandService.executeCommand('vscode.openFolder', project.root);
});

function resolveSimulationTarget(contextService: IWorkspaceContextService): { cwd: string; yaml: string } {
	const defaultRepo = 'C:\\Users\\rashe\\Documents\\MAEngine';
	const folders = contextService.getWorkspace().folders;
	if (folders.length > 0) {
		const rootPath = folders[0].uri.fsPath;
		return {
			cwd: rootPath,
			yaml: `${rootPath}\\simulation.yaml`
		};
	}
	return {
		cwd: `${defaultRepo}\\examples\\cantilever_beam`,
		yaml: `${defaultRepo}\\examples\\cantilever_beam\\simulation.yaml`
	};
}

async function runMAEngineProcess(
	accessor: ServicesAccessor,
	action: 'mesh' | 'solve' | 'run' | 'post',
	targetYaml?: string
): Promise<void> {
	const terminalService = accessor.get(ITerminalService);
	const terminalGroupService = accessor.get(ITerminalGroupService);
	const contextService = accessor.get(IWorkspaceContextService);
	const notificationService = accessor.get(INotificationService);

	const target = resolveSimulationTarget(contextService);
	const yamlPath = targetYaml || target.yaml;
	const pythonExe = 'C:\\Users\\rashe\\Documents\\MAEngine\\.venv\\Scripts\\python.exe';

	notificationService.info(`[MAEngine] Executing ${action.toUpperCase()} job on ${yamlPath}...`);

	let instance = terminalService.instances.find(t => t.title === 'MAEngine CAE Engine');
	if (!instance) {
		instance = await terminalService.createTerminal({
			config: {
				name: 'MAEngine CAE Engine',
				cwd: target.cwd,
			}
		});
	}

	terminalService.setActiveInstance(instance);
	await terminalGroupService.showPanel(true);
	instance.focus();

	instance.sendText(`${pythonExe} -m maengine ${action} "${yamlPath}"`, true);
}

CommandsRegistry.registerCommand('maengine.mesh.run', async (accessor: ServicesAccessor, targetYaml?: string) => {
	await runMAEngineProcess(accessor, 'mesh', targetYaml);
});

CommandsRegistry.registerCommand('maengine.solve.run', async (accessor: ServicesAccessor, targetYaml?: string) => {
	await runMAEngineProcess(accessor, 'solve', targetYaml);
});

CommandsRegistry.registerCommand('maengine.runPipeline', async (accessor: ServicesAccessor, targetYaml?: string) => {
	await runMAEngineProcess(accessor, 'run', targetYaml);
});

CommandsRegistry.registerCommand('maengine.post.run', async (accessor: ServicesAccessor, targetYaml?: string) => {
	await runMAEngineProcess(accessor, 'post', targetYaml);
});

