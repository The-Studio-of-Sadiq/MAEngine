/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/maengineShell.css';
import { $, append } from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationDefaults, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isAccountsActionVisible, setAccountsActionVisible } from '../../../browser/parts/globalCompositeBar.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ActiveViewletContext } from '../../../common/contextkeys.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IMAEngineProjectService, PROJECT_PARTS } from '../../../services/maengineProject/common/maengineProject.js';
import { SolverEditorInput } from '../../maengineSolver/browser/solverEditorInput.js';
import {
	applyDeveloperItems,
	ConfigurationDefaultsSwitch,
	gateCommandPalette,
	gateKeybindings,
	gateMenuItems,
	gateSubmenus,
	parseDeveloperItemsSnapshot,
	partEditorLabels,
	ViewsGate,
} from './maengineShell.js';

/*
 * The MAEngine window: an engineering app first. The code-editor half of Code-OSS (source control,
 * debugging, extensions, terminal, outline, timeline, editor status) stays installed and comes back
 * with the `maengine.developerMode` setting; without it the window shows only what an engineer uses.
 */

export const DEVELOPER_MODE_SETTING = 'maengine.developerMode';
export const DEVELOPER_MODE_CONTEXT = 'maengineDeveloperMode';
export const DeveloperModeContext = new RawContextKey<boolean>(DEVELOPER_MODE_CONTEXT, false, localize('maengineDeveloperMode', "Whether MAEngine shows its code-editor features (developer mode)"));

const RUN_ALL_COMMAND = 'maengine.solver.runAll';
const STOP_RUN_ALL_COMMAND = 'maengine.solver.runAll.cancel';
const RunAllRunning = ContextKeyExpr.has('maengineRunAllRunning');
const ProjectOpenContext = ContextKeyExpr.has('maengineProjectOpen');
const MAENGINE_VIEW_CONTAINER_ID = 'workbench.view.maengine.project';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'maengineShell',
	title: localize('maengine.configurationTitle', "MAEngine"),
	type: 'object',
	properties: {
		[DEVELOPER_MODE_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('maengine.developerMode', "Shows the developer code-editor features of the workbench: file explorer, search, source control, run and debug, extensions, terminal, problem lists and editor status. When off, MAEngine presents a focused mechanical engineering desktop interface."),
		},
	},
});

//#region Configuration defaults

/** Window chrome of the engineering app, in both modes. */
const SHELL_DEFAULTS: IConfigurationDefaults = {
	overrides: {
		// One ≡ button in the title bar instead of a menu bar.
		'window.menuBarVisibility': 'compact',
		'window.commandCenter': true,
		// The command center stays a search field ("Search or run a command"); chat toggle sits beside it.
		'chat.agentsControl.enabled': 'badge',
		// The view switcher sits on top of the side bar.
		'workbench.activityBar.location': 'top',
		'workbench.layoutControl.enabled': false,
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'workbench.welcomePage.walkthroughs.openOnInstall': false,
		'workbench.welcomePage.experimentalOnboarding': false,
		'workbench.startupEditor': 'none',
		'workbench.editor.tabSizing': 'shrink',
	},
	source: { id: 'maengine.shell', displayName: 'MAEngine' },
};

/** Code-editor presentation that developer mode brings back. */
const SIMPLE_DEFAULTS: IConfigurationDefaults = {
	overrides: {
		'breadcrumbs.enabled': false,
		'breadcrumbs.showEditorType': false,
		'workbench.editor.decorations.badges': false,
		'workbench.editor.customLabels.patterns': partEditorLabels(PROJECT_PARTS),
		'workbench.editor.empty.hint': 'hidden',
		'workbench.tips.enabled': false,
		'chat.titleBar.openInAgentsWindow.enabled': false,
		'extensions.ignoreRecommendations': true,
		'git.enabled': false,
		'scm.diffDecorations': 'none',
	},
	source: { id: 'maengine.simpleMode', displayName: 'MAEngine' },
};

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerDefaultConfigurations([SHELL_DEFAULTS]);
const simpleDefaults = new ConfigurationDefaultsSwitch(configurationRegistry, SIMPLE_DEFAULTS);
simpleDefaults.set(true);

//#endregion

//#region Views and menus

const EXTENSIONS_VIEW_CONTAINER = 'workbench.view.extensions';
const SEARCH_VIEW_CONTAINER = 'workbench.view.search';

/** View containers that belong to code editing: shown in developer mode only. */
const DEVELOPER_VIEW_CONTAINERS = new Set([
	'workbench.view.explorer',
	SEARCH_VIEW_CONTAINER,
	'workbench.view.scm',
	'workbench.view.debug',
	EXTENSIONS_VIEW_CONTAINER,
	'workbench.view.extension.test',
	'terminal',
	'workbench.panel.repl',
	'workbench.panel.testResults',
	'~remote.forwardedPortsContainer',
	'workbench.panel.markers',
	'workbench.view.extension.copilot-chat',
	'workbench.view.extension.context-inspector',
]);

const MaengineLogShownContext = new RawContextKey<boolean>('maengineLogShown', false);

/** Single code-editor views in otherwise kept containers. */
const DEVELOPER_VIEWS = new Set(['outline', 'timeline']);

/** Top-level menus of the ≡ menu that only make sense for code: Selection, Go, Run, Terminal. */
const DEVELOPER_MENUS = new Set([MenuId.MenubarSelectionMenu, MenuId.MenubarGoMenu, MenuId.MenubarDebugMenu, MenuId.MenubarTerminalMenu]);

/** What menus keep outside developer mode. */
const SIMPLE_MENU_ITEMS: ReadonlyMap<MenuId, ReadonlySet<string>> = new Map([
	[MenuId.MenubarFileMenu, new Set([
		'workbench.action.files.save', 'workbench.action.files.saveAll', 'workbench.action.files.revert',
		'workbench.action.closeActiveEditor', 'workbench.action.closeWindow', 'workbench.action.newWindow',
		'workbench.action.quit', MenuId.MenubarPreferencesMenu.id,
	])],
	[MenuId.MenubarEditMenu, new Set([
		'undo', 'redo', 'editor.action.clipboardCutAction', 'editor.action.clipboardCopyAction',
		'editor.action.clipboardPasteAction', 'actions.find', 'editor.action.startFindReplaceAction',
	])],
	[MenuId.MenubarHelpMenu, new Set(['workbench.action.showAboutDialog', 'workbench.action.showCommands'])],
	[MenuId.MenubarViewMenu, new Set([MenuId.MenubarAppearanceMenu.id, MenuId.MenubarLayoutMenu.id])],
	[MenuId.MenubarPreferencesMenu, new Set([
		'workbench.action.openGlobalKeybindings', 'ThemesSubMenu',
	])],
	[MenuId.GlobalActivity, new Set([
		'workbench.action.showCommands', 'workbench.action.openGlobalKeybindings',
		'ThemesSubMenu',
	])],
]);

const DEVELOPER_APPEARANCE_ITEMS: ReadonlySet<string> = new Set([
	'editor.action.toggleMinimap', 'breadcrumbs.toggle', 'editor.action.toggleStickyScroll',
	MenuId.EditorRenderWhitespaceSubmenu.id, 'editor.action.toggleRenderControlCharacter',
	'workbench.action.toggleZenMode', 'workbench.action.toggleCenteredLayout',
]);

function keptInSimpleMode(menu: MenuId, id: string): boolean {
	return id.startsWith('maengine.') || !!SIMPLE_MENU_ITEMS.get(menu)?.has(id);
}

/** What the command palette lists outside developer mode. */
const SIMPLE_PALETTE_COMMANDS: ReadonlySet<string> = new Set([
	'workbench.action.files.save', 'workbench.action.files.saveAll', 'workbench.action.files.revert',
	'workbench.action.closeActiveEditor', 'workbench.action.closeAllEditors', 'workbench.action.reopenClosedEditor',
	'workbench.action.newWindow', 'workbench.action.closeWindow', 'workbench.action.reloadWindow', 'workbench.action.quit',
	'workbench.action.openSettings', 'workbench.action.openGlobalKeybindings', 'workbench.action.selectTheme',
	'workbench.action.toggleFullScreen', 'workbench.action.zoomIn', 'workbench.action.zoomOut', 'workbench.action.zoomReset',
	'workbench.action.toggleSidebarVisibility', 'workbench.action.togglePanel', 'workbench.action.showAboutDialog',
	'workbench.action.openRecent', 'workbench.action.showCommands', 'workbench.action.quickOpen',
	'workbench.action.showNotifications', 'workbench.action.clearAllNotifications', 'undo', 'redo',
]);

const OPEN_MAENGINE_SETTINGS = 'maengine.openSettings';

class DeveloperViewsGate extends ViewsGate {

	constructor() {
		const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		super(DeveloperModeContext, DEVELOPER_VIEW_CONTAINERS, DEVELOPER_VIEWS, viewContainersRegistry, Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry));
		this.anchorExtensions(viewContainersRegistry);
	}

	private anchorExtensions(viewContainersRegistry: IViewContainersRegistry): void {
		const container = viewContainersRegistry.get(EXTENSIONS_VIEW_CONTAINER);
		if (!container) {
			return;
		}
		this.registerGated([{
			id: 'maengine.extensionsAnchor',
			name: localize2('maengine.extensionsAnchor', "Extensions"),
			ctorDescriptor: new SyncDescriptor(AnchorView),
			when: ContextKeyExpr.and(DeveloperModeContext, ActiveViewletContext.notEqualsTo(EXTENSIONS_VIEW_CONTAINER)),
			canToggleVisibility: false,
			canMoveView: false,
			order: Number.MAX_SAFE_INTEGER,
		}], container);
	}
}

class AnchorView extends ViewPane { }

const DEVELOPER_COMMAND_PREFIXES: readonly string[] = [
	'workbench.view.explorer', 'workbench.files.action.focusFilesExplorer', 'workbench.files.action.showActiveFileInExplorer',
	'workbench.view.search', 'workbench.action.findInFiles', 'workbench.action.replaceInFiles', 'workbench.action.findInFolder',
	'workbench.action.search.', 'search.',
	'workbench.view.scm', 'workbench.scm.', 'scm.', 'git.',
	'workbench.view.debug', 'workbench.action.debug.', 'workbench.debug.', 'debug.', 'editor.debug.',
	'workbench.view.extensions', 'workbench.extensions.',
	'workbench.view.testing', 'testing.',
	'workbench.action.terminal.', 'workbench.action.createTerminalEditor', 'workbench.action.tasks.',
	'workbench.actions.view.problems', 'workbench.action.problems.',
	'workbench.action.output.toggleOutput',
	'workbench.panel.repl.',
];

export function isDeveloperCommand(id: string): boolean {
	return DEVELOPER_COMMAND_PREFIXES.some(prefix => id === prefix || (prefix.endsWith('.') && id.startsWith(prefix)));
}

const DEVELOPER_STATUS_ENTRIES = [
	'vscode.vscode-api-tests.myStaticItem',
	'status.editor.selection',
	'status.editor.indentation',
	'status.editor.encoding',
	'status.editor.eol',
	'status.editor.mode',
	'status.editor.info',
	'status.languageStatus',
	'status.problems',
	'status.debug',
	'status.host',
	'status.forwardedPorts',
	'chat.statusBarEntry',
	'codex.statusBarEntry',
];

const DEVELOPER_ITEMS_SNAPSHOT_KEY = 'maengine.shell.developerItemsVisibility';

class DeveloperModeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.maengine.developerMode';

	private readonly context: IContextKey<boolean>;
	private readonly projectOpenKey: IContextKey<boolean>;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IExtensionService extensionService: IExtensionService,
		@IMAEngineProjectService projectService: IMAEngineProjectService,
	) {
		super();
		this.context = DeveloperModeContext.bindTo(contextKeyService);
		this.projectOpenKey = new RawContextKey<boolean>('maengineProjectOpen', false).bindTo(contextKeyService);
		this.projectOpenKey.set(!!projectService.project);
		this._register(projectService.onDidChangeProject(p => this.projectOpenKey.set(!!p)));

		this._register(new DeveloperViewsGate());
		gateSubmenus(MenuId.MenubarMainMenu, DEVELOPER_MENUS, DeveloperModeContext);
		this._register(gateMenuItems(MenuId.MenubarAppearanceMenu, id => !DEVELOPER_APPEARANCE_ITEMS.has(id), DeveloperModeContext));
		for (const menu of SIMPLE_MENU_ITEMS.keys()) {
			this._register(gateMenuItems(menu, id => keptInSimpleMode(menu, id), DeveloperModeContext));
		}
		this._register(gateCommandPalette(id => id.startsWith('maengine.') || SIMPLE_PALETTE_COMMANDS.has(id), DeveloperModeContext));
		gateKeybindings(KeybindingsRegistry, isDeveloperCommand, DeveloperModeContext);

		this.apply();
		void lifecycleService.when(LifecyclePhase.Restored).then(() => this.applyToParts());
		void extensionService.whenInstalledExtensionsRegistered().then(() => this.applyToParts());
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(DEVELOPER_MODE_SETTING)) {
				this.apply();
				this.applyToParts();
			}
		}));
	}

	private get developerMode(): boolean {
		return this.configurationService.getValue<boolean>(DEVELOPER_MODE_SETTING) === true;
	}

	private apply(): void {
		const developerMode = this.developerMode;
		this.context.set(developerMode);
		simpleDefaults.set(!developerMode);
	}

	private applyToParts(): void {
		applyDeveloperItems(this.developerMode, DEVELOPER_STATUS_ENTRIES, {
			isEntryVisible: id => this.statusbarService.isEntryVisible(id),
			updateEntryVisibility: (id, visible) => this.statusbarService.updateEntryVisibility(id, visible),
			isAccountsVisible: () => isAccountsActionVisible(this.storageService),
			setAccountsVisible: visible => setAccountsActionVisible(this.storageService, visible),
			readSnapshot: () => parseDeveloperItemsSnapshot(this.storageService.get(DEVELOPER_ITEMS_SNAPSHOT_KEY, StorageScope.PROFILE)),
			writeSnapshot: snapshot => {
				if (snapshot) {
					this.storageService.store(DEVELOPER_ITEMS_SNAPSHOT_KEY, JSON.stringify(snapshot), StorageScope.PROFILE, StorageTarget.MACHINE);
				} else {
					this.storageService.remove(DEVELOPER_ITEMS_SNAPSHOT_KEY, StorageScope.PROFILE);
				}
			},
		});
	}
}

registerWorkbenchContribution2(DeveloperModeContribution.ID, DeveloperModeContribution, WorkbenchPhase.BlockStartup);

class DeveloperContainersGuard extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.maengine.developerContainersGuard';

	private readonly logShown: IContextKey<boolean>;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOutputService outputService: IOutputService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
	) {
		super();
		this.logShown = MaengineLogShownContext.bindTo(contextKeyService);
		const isMaengineLog = (id: string | undefined) => !!id?.startsWith('maengine.');
		this.logShown.set(isMaengineLog(outputService.getActiveChannel()?.id));
		this._register(outputService.onActiveOutputChannel(id => this.logShown.set(isMaengineLog(id))));

		this._register(paneCompositeService.onDidPaneCompositeOpen(({ composite, viewContainerLocation }) => this.check(composite.getId(), viewContainerLocation)));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(DEVELOPER_MODE_SETTING)) {
				this.checkActive();
			}
		}));
		this._register(projectService.onDidChangeProject(p => {
			if (p) {
				void this.paneCompositeService.openPaneComposite(MAENGINE_VIEW_CONTAINER_ID, ViewContainerLocation.Sidebar, false);
			} else if (this.configurationService.getValue<boolean>(DEVELOPER_MODE_SETTING) !== true) {
				this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			}
		}));

		this.checkActive();
	}

	private outOfSight(id: string): boolean {
		if (this.configurationService.getValue<boolean>(DEVELOPER_MODE_SETTING) === true) {
			return false;
		}
		return DEVELOPER_VIEW_CONTAINERS.has(id);
	}

	private checkActive(): void {
		for (const location of [ViewContainerLocation.Sidebar, ViewContainerLocation.Panel, ViewContainerLocation.AuxiliaryBar]) {
			const active = this.paneCompositeService.getActivePaneComposite(location);
			if (active) {
				this.check(active.getId(), location);
			}
		}
		// On initial load without an open project, keep the sidebar hidden to avoid an empty container
		if (!this.projectService.project && this.configurationService.getValue<boolean>(DEVELOPER_MODE_SETTING) !== true) {
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		}
	}

	private check(id: string, location: ViewContainerLocation): void {
		if (!this.outOfSight(id)) {
			return;
		}
		if (location === ViewContainerLocation.Sidebar && this.projectService.project) {
			void this.paneCompositeService.openPaneComposite(MAENGINE_VIEW_CONTAINER_ID, location, false);
		} else {
			this.layoutService.setPartHidden(true, this.paneCompositeService.getPartId(location));
		}
	}
}

registerWorkbenchContribution2(DeveloperContainersGuard.ID, DeveloperContainersGuard, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_MAENGINE_SETTINGS,
			title: localize2('maengine.openSettings', "Settings"),
			category: localize2('maengine.category', "MAEngine"),
			f1: true,
			menu: [
				{ id: MenuId.GlobalActivity, group: '2_configuration', order: 1, when: DeveloperModeContext.negate() },
				{ id: MenuId.MenubarPreferencesMenu, group: '1_settings', order: 1, when: DeveloperModeContext.negate() },
			],
		});
	}

	override run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('workbench.action.openSettings', 'maengine.');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'maengine.toggleDeveloperMode',
			title: localize2('maengine.toggleDeveloperMode', "Toggle Developer Mode"),
			category: localize2('maengine.category', "MAEngine"),
			toggled: DeveloperModeContext,
			f1: true,
			menu: [
				{ id: MenuId.MenubarViewMenu, group: '2_appearance', order: 50 },
				{ id: MenuId.GlobalActivity, group: '2_configuration', order: 2 },
				{ id: MenuId.MenubarPreferencesMenu, group: '1_settings', order: 2 },
				{ id: MenuId.MenubarHelpMenu, group: '5_tools', order: 0 },
			],
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		return configurationService.updateValue(DEVELOPER_MODE_SETTING, configurationService.getValue<boolean>(DEVELOPER_MODE_SETTING) !== true, ConfigurationTarget.USER);
	}
});

//#endregion

//#region Run All

// Register command maengine.solver.runAll. For now it opens the Solver editor.
CommandsRegistry.registerCommand(RUN_ALL_COMMAND, async (accessor: ServicesAccessor) => {
	const editorService = accessor.get(IEditorService);
	const projectService = accessor.get(IMAEngineProjectService);
	const root = projectService.project?.root;
	const resource = root ? joinPath(root, '06 Solver', 'solver.json') : URI.from({ scheme: 'maengine', path: '/solver' });
	await editorService.openEditor(new SolverEditorInput(resource), { pinned: true });
});

// F5 runs solver when project is open and developer mode is off.
KeybindingsRegistry.registerKeybindingRule({
	id: RUN_ALL_COMMAND,
	primary: KeyCode.F5,
	when: ContextKeyExpr.and(ProjectOpenContext, DeveloperModeContext.negate()),
	weight: KeybindingWeight.WorkbenchContrib + 10,
});

MenuRegistry.appendMenuItem(MenuId.TitleBar, {
	command: {
		id: RUN_ALL_COMMAND,
		title: localize2('maengine.solver.runAll', "Run All"),
		tooltip: localize('maengine.solver.runAll.tooltip', "Run the analysis and solver for this project"),
		icon: Codicon.play,
	},
	when: ContextKeyExpr.and(ProjectOpenContext, RunAllRunning.negate()),
	group: 'navigation',
	order: -1,
});

/** The primary action of the window: an icon and a label in button colours. */
class RunAllTitleBarItem extends BaseActionViewItem {

	private label: HTMLElement | undefined;

	constructor(action: IAction, options: IBaseActionViewItemOptions, private readonly icon: ThemeIcon = Codicon.play) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('maengine-run-all');
		container.setAttribute('role', 'button');
		const content = append(container, $('.maengine-run-all-content'));
		append(content, $(ThemeIcon.asCSSSelector(this.icon)));
		this.label = append(content, $('span.maengine-run-all-label'));
		this.updateLabel();
		this.updateEnabled();
	}

	protected override updateLabel(): void {
		if (this.label) {
			this.label.textContent = this.action.label;
		}
		this.element?.setAttribute('aria-label', this.action.label);
	}

	protected override updateEnabled(): void {
		this.element?.classList.toggle('disabled', !this.action.enabled);
	}
}

class RunAllTitleBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.maengine.runAllTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.TitleBar, RUN_ALL_COMMAND, (action, options) => instantiationService.createInstance(RunAllTitleBarItem, action, options, Codicon.play)));
		this._register(actionViewItemService.register(MenuId.TitleBar, STOP_RUN_ALL_COMMAND, (action, options) => instantiationService.createInstance(RunAllTitleBarItem, action, options, Codicon.debugStop)));
	}
}

registerWorkbenchContribution2(RunAllTitleBarContribution.ID, RunAllTitleBarContribution, WorkbenchPhase.BlockStartup);

//#endregion
