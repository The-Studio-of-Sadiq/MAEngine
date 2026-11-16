/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, h } from '../../../../base/browser/dom.js';
import { KeybindingLabel } from '../../../../base/browser/ui/keybindingLabel/keybindingLabel.js';
import { coalesce, shuffle } from '../../../../base/common/arrays.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWeb, OS } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, ContextKeyExpression, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { defaultKeybindingLabelStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMAEngineProjectService, PROJECT_PARTS } from '../../../services/maengineProject/common/maengineProject.js';
import { nextStep, openPart, PartStatusProvider } from '../../../contrib/maengineProject/browser/projectParts.js';

interface WatermarkEntry {
	readonly id: string;
	readonly text: string;
	readonly when?: {
		native?: ContextKeyExpression;
		web?: ContextKeyExpression;
	};
}

const showChatContextKey = ContextKeyExpr.and(ContextKeyExpr.equals('chatSetupHidden', false), ContextKeyExpr.equals('chatSetupDisabledInWorkspace', false));

const openChat: WatermarkEntry = { text: localize('watermark.openChat', "Open Chat"), id: 'workbench.action.chat.open', when: { native: showChatContextKey, web: showChatContextKey } };
const showCommands: WatermarkEntry = { text: localize('watermark.showCommands', "Show All Commands"), id: 'workbench.action.showCommands' };
const gotoFile: WatermarkEntry = { text: localize('watermark.quickAccess', "Go to File"), id: 'workbench.action.quickOpen' };
const openFile: WatermarkEntry = { text: localize('watermark.openFile', "Open File"), id: 'workbench.action.files.openFile' };
const openFolder: WatermarkEntry = { text: localize('watermark.openFolder', "Open Folder"), id: 'workbench.action.files.openFolder' };
const openFileOrFolder: WatermarkEntry = { text: localize('watermark.openFileFolder', "Open File or Folder"), id: 'workbench.action.files.openFileFolder' };
const openRecent: WatermarkEntry = { text: localize('watermark.openRecent', "Open Recent"), id: 'workbench.action.openRecent' };
const newUntitledFile: WatermarkEntry = { text: localize('watermark.newUntitledFile', "New Untitled Text File"), id: 'workbench.action.files.newUntitledFile' };
const findInFiles: WatermarkEntry = { text: localize('watermark.findInFiles', "Find in Files"), id: 'workbench.action.findInFiles' };
const toggleTerminal: WatermarkEntry = { text: localize({ key: 'watermark.toggleTerminal', comment: ['toggle is a verb here'] }, "Toggle Terminal"), id: 'workbench.action.terminal.toggleTerminal', when: { web: ContextKeyExpr.equals('terminalProcessSupported', true) } };
const startDebugging: WatermarkEntry = { text: localize('watermark.startDebugging', "Start Debugging"), id: 'workbench.action.debug.start', when: { web: ContextKeyExpr.equals('terminalProcessSupported', true) } };
const openSettings: WatermarkEntry = { text: localize('watermark.openSettings', "Open Settings"), id: 'workbench.action.openSettings' };

const baseEntries: WatermarkEntry[] = [
	openChat,
	showCommands,
];

const emptyWindowEntries: WatermarkEntry[] = coalesce([
	...baseEntries,
	openRecent,
	...(isMacintosh && !isWeb ? [openFileOrFolder] : [openFile, openFolder]),
	isMacintosh && !isWeb ? newUntitledFile : undefined,
]);

const workspaceEntries: WatermarkEntry[] = [
	...baseEntries,
];

const otherEntries: WatermarkEntry[] = [
	gotoFile,
	findInFiles,
	startDebugging,
	toggleTerminal,
	openSettings,
];

function renderCalmBrandMark(parent: HTMLElement): SVGSVGElement {
	const svg = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 64 44');
	svg.setAttribute('class', 'maengine-watermark-mark');
	svg.setAttribute('aria-hidden', 'true');

	const topFace = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	topFace.setAttribute('d', 'M32 4 L58 15 L32 26 L6 15 Z');
	topFace.setAttribute('fill', 'var(--ma-border, currentColor)');
	topFace.setAttribute('opacity', '0.6');
	svg.appendChild(topFace);

	const leftFace = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	leftFace.setAttribute('d', 'M6 15 L32 26 L32 40 L6 29 Z');
	leftFace.setAttribute('fill', 'var(--ma-border, currentColor)');
	leftFace.setAttribute('opacity', '0.45');
	svg.appendChild(leftFace);

	const rightFace = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	rightFace.setAttribute('d', 'M32 26 L58 15 L58 29 L32 40 Z');
	rightFace.setAttribute('fill', 'var(--ma-border, currentColor)');
	rightFace.setAttribute('opacity', '0.3');
	svg.appendChild(rightFace);

	const meshLines = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	meshLines.setAttribute('d', 'M19 9.5 L45 20.5 M45 9.5 L19 20.5 M19 20.5 L19 34.5 M45 20.5 L45 34.5');
	meshLines.setAttribute('stroke', 'var(--vscode-editor-background, #fff)');
	meshLines.setAttribute('stroke-width', '1');
	meshLines.setAttribute('opacity', '0.8');
	svg.appendChild(meshLines);

	parent.appendChild(svg);
	return svg;
}

export class EditorGroupWatermark extends Disposable {

	private static readonly CACHED_WHEN = 'editorGroupWatermark.whenConditions';
	private static readonly SETTINGS_KEY = 'workbench.tips.enabled';
	private static readonly MINIMUM_ENTRIES = 3;

	private readonly cachedWhen: { [when: string]: boolean };

	private readonly shortcuts: HTMLElement;
	private readonly calmWatermark: HTMLElement;
	private readonly toolbarContainer: HTMLElement;
	private readonly transientDisposables = this._register(new DisposableStore());
	private readonly calmDisposables = this._register(new DisposableStore());
	private readonly keybindingLabels = this._register(new DisposableStore());

	private enabled = false;
	private workbenchState: WorkbenchState;
	private readonly statusProvider: PartStatusProvider;

	constructor(
		container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		this.statusProvider = this._register(this.instantiationService.createInstance(PartStatusProvider));
		this.cachedWhen = this.storageService.getObject(EditorGroupWatermark.CACHED_WHEN, StorageScope.PROFILE, Object.create(null));
		this.workbenchState = this.contextService.getWorkbenchState();

		const elements = h('.editor-group-watermark-wrapper', [
			h('.editor-group-watermark-toolbar-container@toolbarContainer'),
			h('.editor-group-watermark', [
				h('.watermark-container', [
					h('.maengine-watermark@calmWatermark'),
					h('.letterpress'),
					h('.shortcuts@shortcuts'),
				])
			])
		]);

		append(container, elements.root);
		this.shortcuts = elements.shortcuts;
		this.calmWatermark = elements.calmWatermark;
		this.toolbarContainer = elements.toolbarContainer;

		const letterpress = elements.root.querySelector('.letterpress') as HTMLElement | null;
		if (letterpress) {
			letterpress.style.display = 'none';
		}

		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, this.toolbarContainer, MenuId.EditorGroupWatermarkToolbar, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			highlightToggledItems: true,
			menuOptions: { shouldForwardArgs: true }
		}));

		this.registerListeners();
		this.render();
	}

	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(EditorGroupWatermark.SETTINGS_KEY) ||
				e.affectsConfiguration('maengine.developerMode')
			) {
				this.render();
			}
		}));

		this._register(this.contextService.onDidChangeWorkbenchState(workbenchState => {
			if (this.workbenchState !== workbenchState) {
				this.workbenchState = workbenchState;
				this.render();
			}
		}));

		this._register(this.projectService.onDidChangeProject(() => this.render()));
		this._register(this.statusProvider.onDidChange(() => this.render()));

		this._register(this.storageService.onWillSaveState(e => {
			if (e.reason === WillSaveStateReason.SHUTDOWN) {
				const entries = [...emptyWindowEntries, ...workspaceEntries, ...otherEntries];
				for (const entry of entries) {
					const when = isWeb ? entry.when?.web : entry.when?.native;
					if (when) {
						this.cachedWhen[entry.id] = this.contextKeyService.contextMatchesRules(when);
					}
				}

				this.storageService.store(EditorGroupWatermark.CACHED_WHEN, JSON.stringify(this.cachedWhen), StorageScope.PROFILE, StorageTarget.MACHINE);
			}
		}));
	}

	private render(): void {
		const isDeveloperMode = this.configurationService.getValue<boolean>('maengine.developerMode') === true;

		if (isDeveloperMode) {
			this.calmWatermark.style.display = 'none';
			this.shortcuts.style.display = '';
			this.renderDeveloperWatermark();
		} else {
			this.shortcuts.style.display = 'none';
			this.calmWatermark.style.display = 'flex';
			this.renderCalmWatermark();
		}
	}

	private renderCalmWatermark(): void {
		this.calmDisposables.clear();
		clearNode(this.calmWatermark);

		renderCalmBrandMark(this.calmWatermark);

		const project = this.projectService.project;
		const text = append(this.calmWatermark, $('p.maengine-watermark-text'));

		const actionRow = append(this.calmWatermark, $('.maengine-watermark-actions'));

		if (!project) {
			text.textContent = localize('watermark.noProject', "Open or create a project to start.");

			const newBtn = append(actionRow, $<HTMLButtonElement>('button.maengine-watermark-btn.primary', { type: 'button' }, localize('watermark.newProject', "New project")));
			newBtn.onclick = () => {
				void this.commandService.executeCommand('maengine.project.showStart');
			};

			const openBtn = append(actionRow, $<HTMLButtonElement>('button.maengine-watermark-btn', { type: 'button' }, localize('watermark.openProject', "Open project")));
			openBtn.onclick = () => {
				void this.commandService.executeCommand('workbench.action.files.openFolder');
			};
		} else {
			text.textContent = localize('watermark.projectOpen', "Pick a part in the Project panel, or press Ctrl+K Ctrl+1");

			const next = nextStep(this.statusProvider.getAllStatuses());
			if (next) {
				const nextPart = PROJECT_PARTS.find(p => p.id === next.part);
				const nextBtn = append(actionRow, $<HTMLButtonElement>('button.maengine-watermark-btn.primary', { type: 'button' }, localize('watermark.openNextStep', "Open next step: {0}", next.label)));
				nextBtn.onclick = () => {
					if (nextPart) {
						void openPart(project, nextPart, { editorService: this.editorService, commandService: this.commandService });
					}
				};
			}

			const settingsPart = PROJECT_PARTS.find(p => p.id === 'settings');
			if (settingsPart) {
				const settingsBtn = append(actionRow, $<HTMLButtonElement>('button.maengine-watermark-btn', { type: 'button' }, localize('watermark.openSettingsPart', "Open study settings")));
				settingsBtn.onclick = () => {
					void openPart(project, settingsPart, { editorService: this.editorService, commandService: this.commandService });
				};
			}
		}
	}

	private renderDeveloperWatermark(): void {
		this.enabled = this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY);

		clearNode(this.shortcuts);
		this.transientDisposables.clear();

		if (!this.enabled) {
			return;
		}

		const entries = this.filterEntries(this.workbenchState !== WorkbenchState.EMPTY ? workspaceEntries : emptyWindowEntries);
		if (entries.length < EditorGroupWatermark.MINIMUM_ENTRIES) {
			const additionalEntries = this.filterEntries(otherEntries);
			shuffle(additionalEntries);
			entries.push(...additionalEntries.slice(0, EditorGroupWatermark.MINIMUM_ENTRIES - entries.length));
		}

		const box = append(this.shortcuts, $('.watermark-box'));

		const update = () => {
			clearNode(box);
			this.keybindingLabels.clear();

			for (const entry of entries) {
				const keys = this.keybindingService.lookupKeybinding(entry.id);
				if (!keys) {
					continue;
				}

				const dl = append(box, $('dl'));
				const dt = append(dl, $('dt'));
				dt.textContent = entry.text;

				const dd = append(dl, $('dd'));

				const label = this.keybindingLabels.add(new KeybindingLabel(dd, OS, { renderUnboundKeybindings: true, ...defaultKeybindingLabelStyles }));
				label.set(keys);
			}
		};

		update();
		this.transientDisposables.add(this.keybindingService.onDidUpdateKeybindings(update));
	}

	private filterEntries(entries: WatermarkEntry[]): WatermarkEntry[] {
		const filteredEntries = entries
			.filter(entry => {
				if (this.cachedWhen[entry.id]) {
					return true;
				}

				const contextKey = isWeb ? entry.when?.web : entry.when?.native;
				return !contextKey || this.contextKeyService.contextMatchesRules(contextKey);
			})
			.filter(entry => !!CommandsRegistry.getCommand(entry.id))
			.filter(entry => !!this.keybindingService.lookupKeybinding(entry.id));

		return filteredEntries;
	}
}
