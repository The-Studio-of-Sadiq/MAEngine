/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/projectNavigator.css';
import { $, addDisposableListener, append, EventType, isHTMLElement } from '../../../../base/browser/dom.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer, ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isEqual, isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { EditorResourceAccessor } from '../../../common/editor.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMAEngineProjectService, IProjectPart, PROJECT_PARTS } from '../../../services/maengineProject/common/maengineProject.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import {
	IPartEntry,
	IPartSection,
	IPartStatus,
	isPartEditor,
	nextStep,
	openPart,
	partGroups,
	partResource,
	partSections,
	PartStatusProvider,
	stateClass,
	stateLabel,
	stateText
} from './projectParts.js';

const VERSIONS_LINE_HEIGHT = 28;
const FILE_DEPTH = 3;
const DEVELOPER_MODE_SETTING = 'maengine.developerMode';

interface IGroupNode {
	readonly kind: 'group';
	readonly id: string;
	readonly label: string;
}

interface IPartNode {
	readonly kind: 'part';
	readonly id: string;
	readonly entry: IPartEntry;
	readonly status: IPartStatus | undefined;
}

interface ISectionNode {
	readonly kind: 'section';
	readonly id: string;
	readonly entry: IPartEntry;
	readonly section: IPartSection;
}

interface IFileNode {
	readonly kind: 'file';
	readonly id: string;
	readonly resource: URI;
	readonly name: string;
	readonly isDirectory: boolean;
}

interface IOverviewNode {
	readonly kind: 'overview';
	readonly id: string;
	readonly next: string | undefined;
}

type NavigatorNode = IOverviewNode | IGroupNode | IPartNode | ISectionNode | IFileNode;

class Delegate implements IListVirtualDelegate<NavigatorNode> {
	getHeight(node: NavigatorNode): number {
		switch (node.kind) {
			case 'group': return 30;
			case 'part':
			case 'overview': return 28;
			case 'section': return 24;
			default: return 22;
		}
	}
	getTemplateId(node: NavigatorNode): string {
		return node.kind;
	}
}

class GroupRenderer implements ITreeRenderer<NavigatorNode, void, HTMLElement> {
	readonly templateId = 'group';
	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.sa-nav-group'));
	}
	renderElement(node: ITreeNode<NavigatorNode, void>, _index: number, label: HTMLElement): void {
		label.textContent = node.element.kind === 'group' ? node.element.label : '';
	}
	disposeTemplate(): void { }
}

interface IPartTemplate {
	readonly row: HTMLElement;
	readonly number: HTMLElement;
	readonly name: HTMLElement;
	readonly dot: HTMLElement;
	readonly text: HTMLElement;
}

class OverviewRenderer implements ITreeRenderer<NavigatorNode, void, IPartTemplate> {
	readonly templateId = 'overview';
	renderTemplate(container: HTMLElement): IPartTemplate {
		const row = append(container, $('.sa-nav-part.sa-nav-overview'));
		return {
			row,
			number: append(row, $(`span.sa-nav-number${ThemeIcon.asCSSSelector(Codicon.dashboard)}`)),
			name: append(row, $('span.sa-nav-name')),
			dot: append(row, $('span.sa-state-dot.hidden')),
			text: append(row, $('span.sa-nav-state')),
		};
	}
	renderElement(node: ITreeNode<NavigatorNode, void>, _index: number, template: IPartTemplate): void {
		if (node.element.kind !== 'overview') {
			return;
		}
		template.name.textContent = localize('projectNavigator.overview', "Overview");
		template.text.textContent = node.element.next ?? '';
		template.text.title = node.element.next ?? '';
	}
	disposeTemplate(): void { }
}

class PartRenderer implements ITreeRenderer<NavigatorNode, void, IPartTemplate> {
	readonly templateId = 'part';
	constructor(
		private readonly isActive: (part: IProjectPart) => boolean,
		private readonly keybindingService: IKeybindingService,
	) { }
	renderTemplate(container: HTMLElement): IPartTemplate {
		const row = append(container, $('.sa-nav-part'));
		return {
			row,
			number: append(row, $('span.sa-nav-number')),
			name: append(row, $('span.sa-nav-name')),
			dot: append(row, $('span.sa-state-dot')),
			text: append(row, $('span.sa-nav-state')),
		};
	}
	renderElement(node: ITreeNode<NavigatorNode, void>, _index: number, template: IPartTemplate): void {
		if (node.element.kind !== 'part') {
			return;
		}
		const { entry, status } = node.element;
		template.number.textContent = entry.isUnnumbered ? '' : (entry.number !== undefined ? String(entry.number) : '');
		template.name.textContent = entry.name;
		template.dot.className = `sa-state-dot ${stateClass(status?.state)}`;
		template.dot.title = status?.hint || stateLabel(status);
		template.text.textContent = stateText(status);

		const shortcut = entry.number !== undefined ? (this.keybindingService.lookupKeybinding(`maengine.project.openPart${entry.number}`)?.getLabel() ?? `Ctrl+K Ctrl+${entry.number}`) : undefined;
		const tooltipParts: string[] = [entry.name];
		if (shortcut) {
			tooltipParts[0] = `${entry.name} (${shortcut})`;
		}
		if (status?.hint) {
			tooltipParts.push(status.hint);
		} else {
			const label = stateLabel(status);
			const text = stateText(status);
			if (text && text !== label) {
				tooltipParts.push(`${label}: ${text}`);
			} else {
				tooltipParts.push(label);
			}
		}
		template.row.title = tooltipParts.join(' \u2013 ');
		template.row.classList.toggle('active', this.isActive(entry.part));
	}
	disposeTemplate(): void { }
}

class SectionRenderer implements ITreeRenderer<NavigatorNode, void, HTMLElement> {
	readonly templateId = 'section';
	constructor(private readonly isActive: (node: ISectionNode) => boolean) { }
	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.sa-nav-section'));
	}
	renderElement(node: ITreeNode<NavigatorNode, void>, _index: number, row: HTMLElement): void {
		if (node.element.kind !== 'section') {
			return;
		}
		row.textContent = node.element.section.label;
		row.classList.toggle('active', this.isActive(node.element));
	}
	disposeTemplate(): void { }
}

interface IFileTemplate {
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
}

class FileRenderer implements ITreeRenderer<NavigatorNode, void, IFileTemplate> {
	readonly templateId = 'file';
	renderTemplate(container: HTMLElement): IFileTemplate {
		const row = append(container, $('.sa-nav-file'));
		return { icon: append(row, $('span.sa-nav-file-icon')), name: append(row, $('span.sa-nav-file-name')) };
	}
	renderElement(node: ITreeNode<NavigatorNode, void>, _index: number, template: IFileTemplate): void {
		if (node.element.kind !== 'file') {
			return;
		}
		template.icon.className = `sa-nav-file-icon ${ThemeIcon.asClassName(node.element.isDirectory ? Codicon.folder : Codicon.file)}`;
		template.name.textContent = node.element.name;
	}
	disposeTemplate(): void { }
}

export class ProjectNavigatorView extends ViewPane {

	static readonly ID = 'workbench.view.maengine.navigator';

	private treeContainer: HTMLElement | undefined;
	private emptyContainer: HTMLElement | undefined;
	private versionsLine: HTMLElement | undefined;
	private tree: WorkbenchObjectTree<NavigatorNode, void> | undefined;

	private activeResource: URI | undefined;
	private partNodes: IPartNode[] = [];
	private overviewNode: IOverviewNode | undefined;
	private sectionNodes: ISectionNode[] = [];
	private readonly autoExpanded = new Set<string>();

	private bodySize: { height: number; width: number } | undefined;
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => void this.refresh(), 100));
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
		@IFileService private readonly fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IPathService private readonly pathService: IPathService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.statusProvider = this._register(instantiationService.createInstance(PartStatusProvider));

		this._register(this.projectService.onDidChangeProject(() => {
			this._onDidChangeTitleArea.fire();
			this.refreshScheduler.schedule();
		}));
		this._register(this.statusProvider.onDidChange(() => this.refreshScheduler.schedule()));
	}

	override get singleViewPaneContainerTitle(): string | undefined {
		return this.projectService.project?.manifest.name ?? super.singleViewPaneContainerTitle;
	}

	private get developerMode(): boolean {
		return this.configurationService.getValue<boolean>(DEVELOPER_MODE_SETTING) === true;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('maengine-project-navigator');

		this.treeContainer = append(container, $('.sa-nav-tree'));
		this.renderVersionsLine(container);
		this.renderEmptyState(container);

		this.tree = this._register(this.instantiationService.createInstance(WorkbenchObjectTree<NavigatorNode, void>, 'MAEngineProjectNavigator', this.treeContainer, new Delegate(), [
			new OverviewRenderer(),
			new GroupRenderer(),
			new PartRenderer(part => this.isActive(part), this.keybindingService),
			new SectionRenderer(node => this.isSectionActive(node)),
			new FileRenderer(),
		], {
			identityProvider: { getId: node => node.id },
			accessibilityProvider: {
				getAriaLabel: node => {
					switch (node.kind) {
						case 'overview': return [localize('projectNavigator.overview', "Overview"), node.next].filter(Boolean).join(', ');
						case 'group': return node.label;
						case 'part': return [`${node.entry.number ? node.entry.number + ' ' : ''}${node.entry.name}`, stateLabel(node.status), node.status?.text].filter(Boolean).join(', ');
						case 'section': return `${node.section.label}, ${node.entry.name}`;
						default: return node.name;
					}
				},
				getWidgetAriaLabel: () => localize('projectNavigator.aria', "Project Parts"),
			},
			keyboardNavigationLabelProvider: {
				getKeyboardNavigationLabel: node => {
					switch (node.kind) {
						case 'part': return node.entry.name;
						case 'section': return node.section.label;
						case 'file': return node.name;
						case 'overview': return localize('projectNavigator.overview', "Overview");
						default: return node.label;
					}
				}
			},
			multipleSelectionSupport: false,
			expandOnlyOnTwistieClick: true,
			indent: 12,
		}));

		this._register(this.tree.onDidOpen(e => void this.open(e.element, !!e.editorOptions.preserveFocus)));
		this._register(this.tree.onDidChangeSelection(e => {
			const selected = e.elements[0];
			const twistie = isHTMLElement(e.browserEvent?.target) && !!e.browserEvent.target.closest('.monaco-tl-twistie');
			if (selected?.kind === 'group' || (selected?.kind === 'part' && twistie && !this.isActive(selected.entry.part))) {
				this.selectActive();
			}
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(DEVELOPER_MODE_SETTING)) {
				this.refreshScheduler.schedule();
			}
		}));

		this._register(this.fileService.onDidFilesChange(e => {
			const root = this.projectService.project?.root;
			if (root && this.developerMode && e.affects(root)) {
				this.refreshScheduler.schedule();
			}
		}));

		this._register(this.editorService.onDidActiveEditorChange(() => this.updateActive()));
		this.updateActive();
		void this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.bodySize = { height, width };
		const hasProject = !!this.projectService.project;
		const line = hasProject && this.versionsLine && !this.versionsLine.classList.contains('hidden') ? VERSIONS_LINE_HEIGHT : 0;
		this.tree?.layout(Math.max(0, height - line), width);
	}

	private renderVersionsLine(container: HTMLElement): void {
		const line = this.versionsLine = append(container, $('.sa-nav-versions.hidden'));
		append(line, $(`span.sa-nav-versions-icon${ThemeIcon.asCSSSelector(Codicon.history)}`));
		append(line, $('span.sa-nav-versions-text', undefined, localize('projectNavigator.noVersions', "No version saved yet")));
		line.title = localize('projectNavigator.noVersions', "No version saved yet");
		line.setAttribute('aria-label', localize('projectNavigator.noVersions', "No version saved yet"));
	}

	private renderEmptyState(container: HTMLElement): void {
		const empty = this.emptyContainer = append(container, $('.sa-nav-empty.hidden'));
		const body = append(empty, $('.sa-nav-empty-body'));
		append(body, $(`div.sa-nav-empty-icon${ThemeIcon.asCSSSelector(Codicon.project)}`));
		append(body, $('div.sa-nav-empty-title', undefined, localize('navigator.noProjectOpen', "No project open")));
		append(body, $('div.sa-nav-empty-desc', undefined, localize('navigator.noProjectDesc', "Open an existing simulation project or create a new mechanical FEA study to begin.")));

		const actions = append(body, $('.sa-nav-empty-actions'));

		const btnNew = append(actions, $<HTMLButtonElement>('button.sa-btn.sa-btn-primary', { type: 'button' }));
		btnNew.textContent = localize('navigator.newProject', "New project");
		this._register(addDisposableListener(btnNew, EventType.CLICK, () => void this.newProject()));

		const btnOpen = append(actions, $<HTMLButtonElement>('button.sa-btn.sa-btn-secondary', { type: 'button' }));
		btnOpen.textContent = localize('navigator.openProject', "Open project");
		this._register(addDisposableListener(btnOpen, EventType.CLICK, () => void this.openProject()));
	}

	private async newProject(): Promise<void> {
		try {
			const defaultHome = await this.pathService.userHome();
			const picked = await this.fileDialogService.showOpenDialog({
				title: localize('navigator.newProjectLocation', "Select Location for New Project"),
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
			await this.commandService.executeCommand('vscode.openFolder', project.root);
		} catch (error) {
			this.notificationService.error(error as Error);
		}
	}

	private async openProject(): Promise<void> {
		try {
			const defaultHome = await this.pathService.userHome();
			const picked = await this.fileDialogService.showOpenDialog({
				title: localize('navigator.openProjectDialog', "Open MAEngine Project"),
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				defaultUri: defaultHome,
			});
			if (!picked?.[0]) {
				return;
			}
			const folder = picked[0];
			await this.commandService.executeCommand('vscode.openFolder', folder);
		} catch (error) {
			this.notificationService.error(error as Error);
		}
	}

	override focus(): void {
		super.focus();
		this.tree?.domFocus();
	}

	private isActive(part: IProjectPart): boolean {
		const project = this.projectService.project;
		const active = this.activeResource;
		const editor = this.editorService.activeEditor;
		if (editor && isPartEditor(part.id, editor)) {
			return true;
		}
		if (!project || !active) {
			return false;
		}
		const resource = partResource(project, part);
		return resource ? isEqual(resource, active) : isEqualOrParent(active, joinPath(project.root, part.folder));
	}

	private isSectionActive(node: ISectionNode): boolean {
		return this.isActive(node.entry.part);
	}

	private updateActive(): void {
		this.activeResource = EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor);
		this.rerenderActive();
	}

	private rerenderActive(): void {
		if (!this.tree) {
			return;
		}
		const active = this.partNodes.find(node => this.isActive(node.entry.part));
		for (const id of [...this.autoExpanded]) {
			if (id === active?.id) {
				continue;
			}
			this.autoExpanded.delete(id);
			const node = this.partNodes.find(n => n.id === id);
			if (node && this.tree.hasElement(node)) {
				this.tree.collapse(node);
			}
		}
		if (active && this.tree.hasElement(active) && this.tree.isCollapsible(active) && this.tree.isCollapsed(active)) {
			this.tree.expand(active);
			this.autoExpanded.add(active.id);
		}
		this.selectActive();
		for (const node of [...(this.overviewNode && this.tree.hasElement(this.overviewNode) ? [this.overviewNode] : []), ...this.partNodes, ...this.sectionNodes]) {
			this.tree.rerender(node);
		}
	}

	private selectActive(): void {
		if (!this.tree) {
			return;
		}
		const part = this.partNodes.find(node => this.isActive(node.entry.part));
		const active = this.sectionNodes.find(node => this.isSectionActive(node)) ?? part;
		const selected = this.tree.getSelection()[0];
		if (active) {
			if (selected !== active) {
				this.tree.setSelection([active]);
				this.tree.setFocus([active]);
			}
		} else if (selected && selected.kind !== 'file') {
			this.tree.setSelection([]);
		}
	}

	private async refresh(): Promise<void> {
		const project = this.projectService.project;
		if (!this.tree) {
			return;
		}

		if (!project) {
			this.treeContainer?.classList.add('hidden');
			this.versionsLine?.classList.add('hidden');
			this.emptyContainer?.classList.remove('hidden');
			this.tree.setChildren(null, []);
			return;
		}

		this.emptyContainer?.classList.add('hidden');
		this.treeContainer?.classList.remove('hidden');
		this.versionsLine?.classList.remove('hidden');

		const developerMode = this.developerMode;
		const elements: IObjectTreeElement<NavigatorNode>[] = [];

		const next = nextStep(this.statusProvider.getAllStatuses());
		const nextText = next ? localize('projectNavigator.next', "Next: {0}", next.label) : undefined;
		const overview: IOverviewNode = { kind: 'overview', id: 'overview', next: nextText };

		elements.push({
			element: { kind: 'group', id: 'group:study', label: localize('partGroup.study', "Study") },
			collapsible: false,
		});
		elements.push({ element: overview, collapsible: false });

		const partNodes: IPartNode[] = [];
		const sectionNodes: ISectionNode[] = [];

		for (const group of partGroups(PROJECT_PARTS)) {
			elements.push({ element: { kind: 'group', id: `group:${group.id}`, label: group.label }, collapsible: false });
			for (const entry of group.parts) {
				const sections: ISectionNode[] = partSections(entry.part.id).map(section => ({
					kind: 'section',
					id: `section:${entry.part.id}:${section.id}`,
					entry,
					section,
				}));
				sectionNodes.push(...sections);

				const files = developerMode ? await this.files(joinPath(project.root, entry.part.folder), FILE_DEPTH) : [];
				const children: IObjectTreeElement<NavigatorNode>[] = [...sections.map(element => ({ element })), ...files];
				const status = this.statusProvider.getStatus(entry.part.id);
				const node: IPartNode = { kind: 'part', id: `part:${entry.part.id}`, entry, status };
				partNodes.push(node);
				elements.push({
					element: node,
					children,
					collapsible: children.length > 0,
					collapsed: ObjectTreeElementCollapseState.PreserveOrCollapsed,
				});
			}
		}

		if (project !== this.projectService.project) {
			return;
		}

		this.tree.setChildren(null, elements);
		this.partNodes = partNodes;
		this.sectionNodes = sectionNodes;
		this.overviewNode = overview;
		this.updateActive();

		if (this.bodySize) {
			this.layoutBody(this.bodySize.height, this.bodySize.width);
		}
	}

	private async files(folder: URI, depth: number): Promise<IObjectTreeElement<NavigatorNode>[]> {
		let stat: IFileStat;
		try {
			stat = await this.fileService.resolve(folder);
		} catch {
			return [];
		}
		const children = [...stat.children ?? []].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
		return Promise.all(children.map(async child => {
			const grandChildren = child.isDirectory && depth > 1 ? await this.files(child.resource, depth - 1) : [];
			return {
				element: { kind: 'file' as const, id: `file:${child.resource.toString()}`, resource: child.resource, name: child.name, isDirectory: child.isDirectory },
				children: grandChildren,
				collapsible: child.isDirectory,
				collapsed: ObjectTreeElementCollapseState.PreserveOrCollapsed,
			};
		}));
	}

	private async open(node: NavigatorNode | undefined, preserveFocus: boolean): Promise<void> {
		const project = this.projectService.project;
		if (!node || !project) {
			return;
		}
		if (node.kind === 'overview') {
			const next = nextStep(this.statusProvider.getAllStatuses());
			const targetPart = (next && PROJECT_PARTS.find(p => p.id === next.part)) ?? PROJECT_PARTS.find(p => p.id === 'geometry');
			if (targetPart) {
				await openPart(project, targetPart, { editorService: this.editorService, commandService: this.commandService }, { preserveFocus });
			}
		} else if (node.kind === 'part') {
			await openPart(project, node.entry.part, { editorService: this.editorService, commandService: this.commandService }, { preserveFocus });
		} else if (node.kind === 'section') {
			await openPart(project, node.entry.part, { editorService: this.editorService, commandService: this.commandService }, { preserveFocus });
		} else if (node.kind === 'file' && !node.isDirectory) {
			await this.editorService.openEditor({ resource: node.resource, options: { preserveFocus } });
		}
	}
}
