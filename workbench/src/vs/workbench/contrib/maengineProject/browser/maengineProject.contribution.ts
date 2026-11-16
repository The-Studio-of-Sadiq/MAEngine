/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './propertiesDock.js';
import './tablesView.js';
import './progressView.js';
import './editorFrame.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMAEngineProjectService, UnitSystem } from '../../../services/maengineProject/common/maengineProject.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalGroupService, ITerminalService } from '../../terminal/browser/terminal.js';
import { resolveBenchmarkUri, resolvePythonExecutable } from './projectParts.js';
import { StartEditor } from './startEditor.js';
import { StartEditorInput } from './startEditorInput.js';

const category = localize2('maengine.category', "MAEngine");

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(StartEditor, StartEditorInput.EDITOR_ID, localize('maengineStartEditor', "Start")),
	[new SyncDescriptor(StartEditorInput)]
);

export function openStartPage(editorService: IEditorService): Promise<unknown> {
	return editorService.openEditor(StartEditorInput.instance, { pinned: true });
}

class StartWindowContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.maengine.startWindow';

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
	) {
		super();
		const scheduler = this._register(new RunOnceScheduler(() => {
			if (!this.projectService.project && this.editorService.count === 0) {
				void openStartPage(this.editorService);
			}
		}, 300));
		scheduler.schedule();

		this._register(this.editorService.onDidCloseEditor(() => {
			if (!this.projectService.project && this.editorService.count === 0) {
				void openStartPage(this.editorService);
			}
		}));
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
	const environmentService = accessor.get(IEnvironmentService);
	const fileService = accessor.get(IFileService);
	const benchmarkUri = await resolveBenchmarkUri(environmentService, fileService);
	if (!benchmarkUri) {
		notificationService.error(localize('benchmarkNotFound', "Cantilever Beam benchmark project could not be found (expected 'examples/cantilever_beam')."));
		return;
	}
	notificationService.info(`Opening MAEngine benchmark: ${benchmarkName || 'Cantilever Beam'}...`);
	await commandService.executeCommand('vscode.openFolder', benchmarkUri);
});

CommandsRegistry.registerCommand('maengine.project.create', async (accessor: ServicesAccessor, args?: { name: string; units: UnitSystem }) => {
	const projectService = accessor.get(IMAEngineProjectService);
	const commandService = accessor.get(ICommandService);
	const contextService = accessor.get(IWorkspaceContextService);
	const pathService = accessor.get(IPathService);

	const name = args?.name || 'New_Simulation_Project';
	const units = args?.units || 'mm_N_MPa_tonne_s';

	// Default target directory via user home + Documents
	const userHome = await pathService.userHome();
	const defaultProjectsRoot = joinPath(userHome, 'Documents', 'MAEngine Projects');
	const root = contextService.getWorkspace().folders[0]?.uri || defaultProjectsRoot;
	const project = await projectService.createProject(root, name, units);
	await commandService.executeCommand('vscode.openFolder', project.root);
});

async function runMAEngineProcess(
	accessor: ServicesAccessor,
	action: 'mesh' | 'solve' | 'run' | 'post',
	targetYaml?: string
): Promise<void> {
	const terminalService = accessor.get(ITerminalService);
	const terminalGroupService = accessor.get(ITerminalGroupService);
	const contextService = accessor.get(IWorkspaceContextService);
	const notificationService = accessor.get(INotificationService);
	const commandService = accessor.get(ICommandService);
	const fileService = accessor.get(IFileService);
	const environmentService = accessor.get(IEnvironmentService);
	const projectService = accessor.get(IMAEngineProjectService);

	let targetCwd: string | undefined;
	let yamlPath: string | undefined;

	if (targetYaml) {
		const targetUri = URI.file(targetYaml);
		if (await fileService.exists(targetUri)) {
			yamlPath = targetYaml;
			targetCwd = dirname(targetUri).fsPath;
		}
	}

	if (!yamlPath) {
		const folders = contextService.getWorkspace().folders;
		if (folders.length > 0) {
			const candidate = joinPath(folders[0].uri, 'simulation.yaml');
			if (await fileService.exists(candidate)) {
				yamlPath = candidate.fsPath;
				targetCwd = folders[0].uri.fsPath;
			}
		} else if (projectService.project) {
			const candidate = joinPath(projectService.project.root, 'simulation.yaml');
			if (await fileService.exists(candidate)) {
				yamlPath = candidate.fsPath;
				targetCwd = projectService.project.root.fsPath;
			}
		}
	}

	if (!yamlPath || !targetCwd) {
		// MAEngine GUI projects have no simulation.yaml: do NOT send a command
		notificationService.prompt(
			Severity.Info,
			localize('maengine.engineNotConnected', "Running a study from the app isn't connected to the engine yet. MAEngine can run engine specs (simulation.yaml); converting this study's settings into one is not built yet."),
			[
				{
					label: localize('maengine.openBenchmark', "Open benchmark"),
					run: () => void commandService.executeCommand('maengine.project.loadBenchmark')
				}
			]
		);
		return;
	}

	const pythonExe = await resolvePythonExecutable(environmentService, fileService);
	if (!pythonExe) {
		notificationService.error(localize('maengine.pythonNotFound', "Python executable could not be found. Please ensure Python is installed or set up a virtual environment."));
		return;
	}

	notificationService.info(localize('maengine.executingJob', "[MAEngine] Executing {0} job on {1}...", action.toUpperCase(), yamlPath));

	let instance = terminalService.instances.find(t => t.title === 'MAEngine CAE Engine');
	if (!instance) {
		instance = await terminalService.createTerminal({
			config: {
				name: 'MAEngine CAE Engine',
				cwd: targetCwd,
			}
		});
	}

	terminalService.setActiveInstance(instance);
	await terminalGroupService.showPanel(true);
	instance.focus();

	const pyCmd = pythonExe.includes(' ') ? `"${pythonExe}"` : pythonExe;
	const yamlCmd = yamlPath.includes(' ') ? `"${yamlPath}"` : yamlPath;
	instance.sendText(`${pyCmd} -m maengine ${action} ${yamlCmd}`, true);
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

