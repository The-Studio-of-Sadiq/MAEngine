/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/cadEditor.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, dirname, isEqual, joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { EditorFrame } from '../../maengineProject/browser/editorFrame.js';
import { IMAEnginePropertiesDockService } from '../../maengineProject/browser/propertiesDock.js';
import { MAEngineTables } from '../../maengineProject/browser/tablesView.js';
import { IPartStatus, resolvePartStatus } from '../../maengineProject/browser/projectParts.js';
import { IMAEngineProjectService } from '../../../services/maengineProject/common/maengineProject.js';
import { CadEditorInput } from './cadEditorInput.js';

interface ICadFace {
	readonly tag: number;
	readonly bounds: readonly number[];
}

interface ICadBody {
	readonly id: string;
	readonly name: string;
	readonly material?: string;
	readonly volume_mm3?: number;
}

interface ICadSelector {
	readonly name: string;
	readonly type: string;
	readonly rule?: string;
	readonly bounds?: readonly number[];
}

interface ICadData {
	readonly schema?: number;
	readonly cadFile?: string;
	readonly bodies?: readonly ICadBody[];
	readonly modelBounds?: readonly number[];
	readonly faces?: readonly ICadFace[];
	readonly selectors?: readonly ICadSelector[];
}

function fmt(n: number): string {
	return Number.isFinite(n) ? String(Number(n.toPrecision(6))) : '0';
}

function fmtBox(bounds: readonly number[]): string {
	return `[${bounds.map(fmt).join(', ')}]`;
}

function faceInsideBox(faceBounds: readonly number[], box: readonly number[]): boolean {
	if (faceBounds.length < 6 || box.length < 6) {
		return false;
	}
	const tol = 1e-6;
	for (let i = 0; i < 3; i++) {
		if (faceBounds[i] < box[i] - tol) {
			return false;
		}
	}
	for (let i = 3; i < 6; i++) {
		if (faceBounds[i] > box[i] + tol) {
			return false;
		}
	}
	return true;
}

export class CadEditor extends EditorPane {

	private frame!: EditorFrame;
	private viewport3d!: HTMLElement;
	private bodiesContainer!: HTMLElement;
	private selectedBodyId: string | undefined;
	private currentStatus: IPartStatus | undefined;

	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IMAEnginePropertiesDockService private readonly propertiesDockService: IMAEnginePropertiesDockService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
		@ICommandService private readonly commandService: ICommandService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super(CadEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.frame = this._register(this.instantiationService.createInstance(EditorFrame, parent, {
			id: 'maengine.cadEditor',
			ariaLabel: localize('cadEditor.aria', "CAD Geometry"),
			properties: { title: localize('properties', "Properties") }
		}));
		this.frame.element.classList.add('maengine-cad-editor');
		this.frame.setActions([this.frame.togglePropertiesAction]);

		this._register(this.frame.createSegmented(
			this.frame.titleSlot,
			[
				{ id: '3d', label: localize('cad.view3d', "3D"), icon: Codicon.symbolStructure },
				{ id: 'bodies', label: localize('cad.bodies', "Bodies"), icon: Codicon.layers }
			],
			'3d',
			mode => this.switchView(mode)
		));

		this.viewport3d = append(this.frame.main, $('.ma-cad-viewport'));
		this.bodiesContainer = append(this.frame.main, $('.ma-cad-bodies-view'));

		this.render3dViewport();
		this.switchView('3d');
	}

	private render3dViewport(): void {
		clearNode(this.viewport3d);

		const box = append(this.viewport3d, $('.ma-cad-canvas-box'));
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('width', '180');
		svg.setAttribute('height', '120');
		svg.setAttribute('viewBox', '0 0 180 120');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '1.5');

		const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		p1.setAttribute('points', '30,85 110,40 155,65 75,110');
		p1.setAttribute('fill', 'var(--ma-surface, #ffffff)');
		p1.setAttribute('opacity', '0.6');
		svg.appendChild(p1);

		const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		p2.setAttribute('points', '30,55 110,10 155,35 75,80');
		p2.setAttribute('fill', 'var(--ma-surface, #ffffff)');
		p2.setAttribute('opacity', '0.8');
		svg.appendChild(p2);

		const addLine = (x1: string, y1: string, x2: string, y2: string) => {
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', x1);
			line.setAttribute('y1', y1);
			line.setAttribute('x2', x2);
			line.setAttribute('y2', y2);
			svg.appendChild(line);
		};

		addLine('30', '85', '30', '55');
		addLine('110', '40', '110', '10');
		addLine('155', '65', '155', '35');
		addLine('75', '110', '75', '80');

		box.appendChild(svg);
		append(box, $('span', undefined, localize('cad.viewportNote', "3D CAD geometry preview")));

		const triad = append(this.viewport3d, $('.ma-cad-triad'));
		append(triad, $('span.axis-x', undefined, "X"));
		append(triad, $('span.axis-y', undefined, "Y"));
		append(triad, $('span.axis-z', undefined, "Z"));

		this._register(addDisposableListener(this.viewport3d, EventType.CLICK, () => {
			if (this.selectedBodyId) {
				const data = this.currentData;
				const body = data?.bodies?.find(b => b.id === this.selectedBodyId);
				if (body) {
					this.selectBody(body);
				}
			}
		}));
	}

	private switchView(mode: '3d' | 'bodies'): void {
		this.viewport3d.classList.toggle('hidden', mode !== '3d');
		this.bodiesContainer.classList.toggle('hidden', mode !== 'bodies');
	}

	private currentData: ICadData | undefined;

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();

		const resource = (input as CadEditorInput).resource;
		if (resource) {
			const folder = dirname(resource);
			this.inputDisposables.add(this.fileService.onDidFilesChange(e => {
				if (e.contains(resource) || e.affects(folder)) {
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
			this.currentData = JSON.parse(content.value.toString()) as ICadData;
		} catch {
			this.currentData = undefined;
		}
		this.currentStatus = await resolvePartStatus('geometry', this.fileService, this.projectService, this.currentData, resource);
		this.render();
	}

	private render(): void {
		const data = this.currentData;
		const bodies = data?.bodies ?? [];
		const hasGeometry = this.currentStatus?.state === 'done';

		if (!hasGeometry) {
			this.frame.setEmpty({
				icon: Codicon.package,
				title: localize('cad.emptyTitle', "No geometry yet"),
				text: localize('cad.emptyText', "No geometry yet. Import a STEP, IGES or BREP file."),
				actions: [{
					label: localize('cad.importAction', "Import CAD..."),
					primary: true,
					run: () => void this.importCad()
				}]
			});
			this.frame.setStatus({
				text: localize('cad.emptyStatus', "No geometry imported"),
				link: { label: localize('cad.importAction', "Import CAD..."), run: () => void this.importCad() }
			});
			this.propertiesDockService.clearProperties();
			return;
		}

		this.frame.setEmpty(undefined);
		const count = bodies.length;
		const cadFile = data?.cadFile ?? 'model';
		if (count === 0) {
			this.frame.setStatus({
				text: localize('cad.statusNoBodies', "{0} imported (use Read model in the Bodies view to list its bodies and faces)", cadFile)
			});
		} else {
			const bodyText = count === 1 ? '1 body' : `${count} bodies`;
			this.frame.setStatus({
				text: localize('cad.status', "Geometry: {0} ({1})", cadFile, this.currentStatus?.text ?? bodyText)
			});
		}

		// Register Bodies Table to bottom Tables Panel
		this.inputDisposables.add(MAEngineTables.registerTable({
			id: 'maengine.cad.bodies',
			label: localize('table.bodies', "Bodies"),
			getData: () => ({
				columns: [
					{ id: 'name', label: localize('col.name', "Name"), sortable: true, getValue: (r: ICadBody) => r.name },
					{ id: 'material', label: localize('col.material', "Material"), sortable: true, getValue: (r: ICadBody) => r.material ?? 'n/a' },
					{ id: 'volume', label: localize('col.volume', "Volume (mm³)"), align: 'right', sortable: true, getValue: (r: ICadBody) => r.volume_mm3 ?? 0 }
				],
				rows: bodies
			})
		}));

		// Render Bodies View
		clearNode(this.bodiesContainer);
		append(this.bodiesContainer, $('.ma-cad-section-title', undefined, localize('cad.bodiesSection', "Bodies in Model")));

		if (bodies.length === 0) {
			this.selectedBodyId = undefined;
			append(this.bodiesContainer, $('.ma-cad-empty-notice', undefined, localize('cad.noBodiesNote', "No bodies listed yet. Use Read model (or run the mesher) to read them from the CAD file.")));
		} else {
			const list = append(this.bodiesContainer, $('.ma-cad-item-list'));
			for (const body of bodies) {
				const row = append(list, $('.ma-cad-body-row'));
				if (this.selectedBodyId === body.id) {
					row.classList.add('selected');
				}
				append(row, $('span.ma-cad-body-name', undefined, body.name));
				const meta = append(row, $('.ma-cad-body-meta'));
				if (body.material) {
					append(meta, $('span.ma-cad-body-mat', undefined, body.material));
				}
				if (typeof body.volume_mm3 === 'number') {
					append(meta, $('span.ma-cad-body-vol', undefined, `${body.volume_mm3.toLocaleString()} mm³`));
				}

				this.inputDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
					for (const child of Array.from(list.children)) {
						child.classList.remove('selected');
					}
					row.classList.add('selected');
					this.selectBody(body);
				}));
			}
		}

		// a. Model Section
		const modelSec = append(this.bodiesContainer, $('.ma-cad-section'));
		const modelHead = append(modelSec, $('.ma-cad-header-row'));
		append(modelHead, $('.ma-cad-section-title', undefined, localize('cad.modelSection', "Model")));
		const readBtn = append(modelHead, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('cad.readModel', "Read model")));
		readBtn.style.padding = '2px 8px';
		readBtn.style.fontSize = 'var(--ma-font-xs, 11px)';
		this.inputDisposables.add(addDisposableListener(readBtn, EventType.CLICK, () => {
			void this.commandService.executeCommand('maengine.geometry.inspect');
		}));

		const modelBody = append(modelSec, $('.ma-cad-model-body'));
		if (data?.modelBounds && data.modelBounds.length >= 6) {
			const faceCount = data.faces ? data.faces.length : 0;
			const faceText = faceCount === 1 ? localize('cad.faceCountOne', "1 face") : localize('cad.faceCountN', "{0} faces", faceCount);
			append(modelBody, $('span', undefined, localize('cad.modelBoundsDesc', "Model bounds: {0}, {1}", fmtBox(data.modelBounds), faceText)));
		} else {
			append(modelBody, $('span.ma-cad-empty-notice', undefined, localize('cad.modelNotRead', "The CAD model has not been read yet.")));
		}

		// b. Face selectors section
		const selSec = append(this.bodiesContainer, $('.ma-cad-section'));
		const selHead = append(selSec, $('.ma-cad-header-row'));
		append(selHead, $('.ma-cad-section-title', undefined, localize('cad.selectorsSection', "Face selectors")));

		const addSelBtn = append(selHead, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('cad.addSelector', "Add selector")));
		addSelBtn.style.padding = '2px 8px';
		addSelBtn.style.fontSize = 'var(--ma-font-xs, 11px)';
		this.inputDisposables.add(addDisposableListener(addSelBtn, EventType.CLICK, () => {
			const currentSelectors = this.currentData?.selectors ?? [];
			const existingNames = new Set(currentSelectors.map(s => s.name.toLowerCase()));
			let i = 1;
			while (existingNames.has(`selector_${i}`.toLowerCase())) {
				i++;
			}
			const defaultName = `selector_${i}`;
			const defaultBounds = this.currentData?.modelBounds && this.currentData.modelBounds.length >= 6
				? [...this.currentData.modelBounds]
				: [0, 0, 0, 0, 0, 0];
			const newSel: ICadSelector = {
				name: defaultName,
				type: 'face',
				rule: 'box',
				bounds: defaultBounds
			};
			void this.writeSelectors([...currentSelectors, newSel]);
		}));

		const selList = append(selSec, $('.ma-cad-item-list'));
		const selectors = data?.selectors ?? [];
		if (selectors.length === 0) {
			append(selList, $('.ma-cad-empty-notice', undefined, localize('cad.noSelectors', "No face selectors defined yet.")));
		} else {
			for (let selIndex = 0; selIndex < selectors.length; selIndex++) {
				const sel = selectors[selIndex];
				const row = append(selList, $('.ma-cad-selector-row'));

				const nameInput = append(row, $<HTMLInputElement>('input.ma-cad-selector-name-input', {
					type: 'text',
					value: sel.name,
					title: localize('cad.selectorNameTitle', "Selector name"),
					placeholder: localize('cad.selectorNamePlaceholder', "Name")
				}));

				const coordLabels = ['xmin', 'ymin', 'zmin', 'xmax', 'ymax', 'zmax'] as const;
				const coordInputs: HTMLInputElement[] = [];
				const bounds = sel.bounds && sel.bounds.length >= 6 ? sel.bounds : [0, 0, 0, 0, 0, 0];

				const coordGroup = append(row, $('.ma-cad-coord-group'));
				for (let i = 0; i < 6; i++) {
					const field = append(coordGroup, $<HTMLLabelElement>('label.ma-cad-coord-field'));
					append(field, $('span.ma-cad-coord-label', undefined, coordLabels[i]));
					const numInp = append(field, $<HTMLInputElement>('input.ma-cad-number-input', {
						type: 'number',
						step: 'any',
						title: coordLabels[i],
						placeholder: coordLabels[i],
						value: fmt(bounds[i])
					}));
					coordInputs.push(numInp);
				}

				const statusSpan = append(row, $('span.ma-cad-selector-status'));

				const updatePicksStatus = () => {
					if (!this.currentData?.faces) {
						statusSpan.textContent = localize('cad.facesUnknown', "faces unknown: read the model");
						statusSpan.classList.remove('warning');
						return;
					}
					const boxVals = coordInputs.map(inp => Number(inp.value));
					const valid = coordInputs.every(inp => inp.value.trim() !== '') && boxVals.every(v => Number.isFinite(v));
					const pickedTags: number[] = [];
					if (valid) {
						for (const face of this.currentData.faces) {
							if (faceInsideBox(face.bounds, boxVals)) {
								pickedTags.push(face.tag);
							}
						}
						pickedTags.sort((a, b) => a - b);
					}
					if (pickedTags.length === 0) {
						statusSpan.textContent = localize('cad.picksNoFace', "picks no face");
						statusSpan.classList.add('warning');
					} else if (pickedTags.length === 1) {
						statusSpan.textContent = localize('cad.picksFace', "picks face {0}", pickedTags[0]);
						statusSpan.classList.remove('warning');
					} else {
						statusSpan.textContent = localize('cad.picksFaces', "picks faces {0}", pickedTags.join(', '));
						statusSpan.classList.remove('warning');
					}
				};

				const actions = append(row, $('.ma-cad-selector-actions'));

				const saveBtn = append(actions, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('cad.saveSelector', "Save")));
				saveBtn.style.padding = '2px 8px';
				saveBtn.style.fontSize = 'var(--ma-font-xs, 11px)';

				const delBtn = append(actions, $<HTMLButtonElement>('button.ma-cad-remove-btn', {
					type: 'button',
					'aria-label': localize('cad.deleteSelector', "Delete")
				}));
				append(delBtn, $(ThemeIcon.asCSSSelector(Codicon.trash)));

				const errorSpan = append(row, $('span.ma-cad-selector-error'));
				errorSpan.style.display = 'none';

				for (const inp of coordInputs) {
					this.inputDisposables.add(addDisposableListener(inp, EventType.INPUT, () => {
						errorSpan.style.display = 'none';
						updatePicksStatus();
					}));
				}
				this.inputDisposables.add(addDisposableListener(nameInput, EventType.INPUT, () => {
					errorSpan.style.display = 'none';
				}));

				updatePicksStatus();

				this.inputDisposables.add(addDisposableListener(saveBtn, EventType.CLICK, async () => {
					const newName = nameInput.value.trim();
					const nameErr = this.validateSelectorName(newName, selIndex);
					if (nameErr) {
						errorSpan.textContent = nameErr;
						errorSpan.style.display = '';
						return;
					}

					const vals = coordInputs.map(inp => Number(inp.value));
					if (coordInputs.some(inp => inp.value.trim() === '') || vals.some(v => isNaN(v) || !Number.isFinite(v))) {
						errorSpan.textContent = localize('cad.errInvalidNumbers', "All six bounds must be finite numbers.");
						errorSpan.style.display = '';
						return;
					}

					if (vals[0] > vals[3] || vals[1] > vals[4] || vals[2] > vals[5]) {
						errorSpan.textContent = localize('cad.errMinMax', "Minimum bound must be less than or equal to maximum bound per axis.");
						errorSpan.style.display = '';
						return;
					}

					errorSpan.style.display = 'none';
					errorSpan.textContent = '';

					const oldName = sel.name;
					if (oldName !== newName) {
						await this.renameSelectorInPhysics(oldName, newName);
					}

					const updatedSelector: ICadSelector = {
						name: newName,
						type: 'face',
						rule: 'box',
						bounds: vals
					};
					const nextSelectors = [...(this.currentData?.selectors ?? [])];
					nextSelectors[selIndex] = updatedSelector;
					await this.writeSelectors(nextSelectors);
				}));

				this.inputDisposables.add(addDisposableListener(delBtn, EventType.CLICK, async e => {
					e.stopPropagation();
					const nextSelectors = (this.currentData?.selectors ?? []).filter((_, idx) => idx !== selIndex);
					await this.writeSelectors(nextSelectors);
				}));
			}
		}

		// c. Faces Section (only when faces exist)
		if (data?.faces && data.faces.length > 0) {
			const facesSec = append(this.bodiesContainer, $('.ma-cad-section'));
			const facesHead = append(facesSec, $('.ma-cad-header-row'));
			append(facesHead, $('.ma-cad-section-title', undefined, localize('cad.facesSection', "Faces")));

			const facesList = append(facesSec, $('.ma-cad-item-list'));
			for (const face of data.faces) {
				const faceRow = append(facesList, $('.ma-cad-face-row'));

				const faceInfo = append(faceRow, $('.ma-cad-face-info'));
				append(faceInfo, $('span.ma-cad-face-tag', undefined, localize('cad.faceTag', "Face {0}", face.tag)));
				append(faceInfo, $('span.ma-cad-face-bounds', undefined, fmtBox(face.bounds)));

				const usingSelectors = (this.currentData?.selectors ?? [])
					.filter(s => s.bounds && s.bounds.length >= 6 && faceInsideBox(face.bounds, s.bounds))
					.map(s => s.name);

				if (usingSelectors.length > 0) {
					append(faceInfo, $('span.ma-cad-face-used-by', undefined, localize('cad.faceUsedBy', "used by: {0}", usingSelectors.join(', '))));
				}

				const makeBtn = append(faceRow, $<HTMLButtonElement>('button.monaco-button', { type: 'button' }, localize('cad.makeSelector', "Make selector")));
				makeBtn.style.padding = '2px 8px';
				makeBtn.style.fontSize = 'var(--ma-font-xs, 11px)';

				this.inputDisposables.add(addDisposableListener(makeBtn, EventType.CLICK, async e => {
					e.stopPropagation();
					const name = await this.quickInputService.input({
						prompt: localize('cad.makeSelectorPrompt', "Selector name for Face {0}", face.tag),
						value: 'face_' + face.tag,
						validateInput: async (v: string) => {
							return this.validateSelectorName(v);
						}
					});
					if (!name) {
						return;
					}
					const newSel: ICadSelector = {
						name: name.trim(),
						type: 'face',
						rule: 'box',
						bounds: [...face.bounds]
					};
					await this.writeSelectors([...(this.currentData?.selectors ?? []), newSel]);
				}));
			}
		}

		// Initial selection
		if (bodies.length > 0 && !this.selectedBodyId) {
			this.selectBody(bodies[0]);
		}
	}

	private validateSelectorName(name: string, ignoreIndex?: number): string | undefined {
		const trimmed = name.trim();
		if (!trimmed) {
			return localize('cad.errNameEmpty', "Selector name cannot be empty.");
		}
		if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) {
			return localize('cad.errNameFormat', "Name must match /^[A-Za-z][A-Za-z0-9_]*$/ (start with a letter, followed by letters, numbers, or underscores).");
		}
		const upper = trimmed.toUpperCase();
		if (upper === 'EALL' || upper === 'NALL') {
			return localize('cad.errReservedName', "Name cannot be EALL or NALL.");
		}
		const currentSelectors = this.currentData?.selectors ?? [];
		for (let i = 0; i < currentSelectors.length; i++) {
			if (i !== ignoreIndex && currentSelectors[i].name.toLowerCase() === trimmed.toLowerCase()) {
				return localize('cad.errDuplicateName', "Selector name already exists.");
			}
		}
		return undefined;
	}

	private async renameSelectorInPhysics(oldName: string, newName: string): Promise<void> {
		if (oldName === newName) {
			return;
		}
		const resource = (this.input as CadEditorInput | undefined)?.resource;
		if (!resource) {
			return;
		}
		try {
			const physicsUri = joinPath(dirname(dirname(resource)), '05 Physics & BCs', 'physics.json');
			const content = await this.fileService.readFile(physicsUri);
			const parsed = JSON.parse(content.value.toString());
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				return;
			}
			const physicsData = parsed as Record<string, unknown>;
			let modified = false;

			if (Array.isArray(physicsData['constraints'])) {
				for (const item of physicsData['constraints']) {
					if (item && typeof item === 'object' && !Array.isArray(item)) {
						const constraint = item as Record<string, unknown>;
						if (constraint['selector'] === oldName) {
							constraint['selector'] = newName;
							modified = true;
						}
					}
				}
			}

			if (Array.isArray(physicsData['loads'])) {
				for (const item of physicsData['loads']) {
					if (item && typeof item === 'object' && !Array.isArray(item)) {
						const load = item as Record<string, unknown>;
						if (load['selector'] === oldName) {
							load['selector'] = newName;
							modified = true;
						}
					}
				}
			}

			if (modified) {
				await this.fileService.writeFile(physicsUri, VSBuffer.fromString(JSON.stringify(physicsData, undefined, '\t') + '\n'));
			}
		} catch {
			// Skip silently if physics.json does not exist or fails to parse
		}
	}

	private async writeSelectors(selectors: readonly ICadSelector[]): Promise<void> {
		const resource = (this.input as CadEditorInput | undefined)?.resource;
		if (!resource) {
			return;
		}
		try {
			let data: Record<string, unknown>;
			try {
				const content = await this.fileService.readFile(resource);
				const parsed = JSON.parse(content.value.toString());
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					data = parsed as Record<string, unknown>;
				} else {
					data = { schema: 1 };
				}
			} catch {
				data = { schema: 1 };
			}
			data['selectors'] = selectors;
			await this.fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify(data, undefined, '\t') + '\n'));
			await this.load(resource);
		} catch (err) {
			this.notificationService.error(localize('cad.writeSelectorsFailed', "Could not write selectors: {0}", String(err)));
		}
	}

	private selectBody(body: ICadBody): void {
		this.selectedBodyId = body.id;
		this.propertiesDockService.setProperties({
			title: body.name,
			detail: body.id,
			rows: [
				{ name: localize('prop.bodyId', "Body ID"), value: body.id },
				{ name: localize('prop.bodyName', "Name"), value: body.name },
				{ name: localize('prop.material', "Material"), value: body.material ?? localize('prop.na', "n/a") },
				{ name: localize('prop.volume', "Volume"), value: typeof body.volume_mm3 === 'number' ? `${body.volume_mm3.toLocaleString()} mm³` : localize('prop.na', "n/a") }
			]
		});
	}

	private async importCad(): Promise<void> {
		const pickedUris = await this.fileDialogService.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: localize('cad.importTitle', "Import CAD Geometry"),
			openLabel: localize('cad.importOpenLabel', "Import"),
			filters: [{
				name: localize('cad.filterName', "CAD files (STEP, IGES, BREP)"),
				extensions: ['step', 'stp', 'iges', 'igs', 'brep', 'brp']
			}]
		});
		if (!pickedUris || pickedUris.length === 0) {
			return;
		}

		const picked = pickedUris[0];
		try {
			const resource = (this.input as CadEditorInput | undefined)?.resource;
			if (!resource) {
				return;
			}
			const folder = dirname(resource);
			const target = joinPath(folder, basename(picked));
			if (!isEqual(picked, target)) {
				await this.fileService.copy(picked, target, true);
			}

			let data: Record<string, unknown>;
			try {
				const content = await this.fileService.readFile(resource);
				const parsed = JSON.parse(content.value.toString());
				if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
					data = parsed as Record<string, unknown>;
				} else {
					data = { schema: 1, selectors: [] };
				}
			} catch {
				data = { schema: 1, selectors: [] };
			}

			data['cadFile'] = basename(picked);
			data['bodies'] = [];
			// The faces and bounds described the previous file; Read model or a mesh run reads them again.
			delete data['faces'];
			delete data['modelBounds'];

			await this.fileService.writeFile(resource, VSBuffer.fromString(JSON.stringify(data, undefined, '\t') + '\n'));
			this.notificationService.info(localize('cad.imported', "Imported {0} into the study.", basename(picked)));
		} catch (err) {
			this.notificationService.error(localize('cad.importFailed', "Could not import {0}: {1}", basename(picked), String(err)));
		}
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
