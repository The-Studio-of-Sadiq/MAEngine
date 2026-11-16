/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { dirname, isEqual, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMAEngineProjectService, IMechastudioProject, IProjectPart, PROJECT_PARTS, createManifest } from '../../../services/maengineProject/common/maengineProject.js';
import { CadEditorInput } from '../../maengineCad/browser/cadEditorInput.js';
import { MarketplaceEditorInput } from '../../maengineMarketplace/browser/marketplaceEditorInput.js';
import { MaterialEditorInput } from '../../maengineMaterial/browser/materialEditorInput.js';
import { MeshEditorInput } from '../../maengineMesh/browser/meshEditorInput.js';
import { PhysicsEditorInput } from '../../maenginePhysics/browser/physicsEditorInput.js';
import { ResultsEditorInput } from '../../maengineResults/browser/resultsEditorInput.js';
import { SolverEditorInput } from '../../maengineSolver/browser/solverEditorInput.js';

export type PartState = 'notStarted' | 'defaults' | 'inProgress' | 'done' | 'stale' | 'failed' | 'warn' | 'error';

export interface IPartStatus {
	readonly part: string;
	readonly state: PartState;
	readonly text: string;
	readonly hint?: string;
}

export interface IPartEntry {
	readonly number?: number;
	readonly part: IProjectPart;
	readonly name: string;
	readonly isUnnumbered?: boolean;
}

export interface IPartGroup {
	readonly id: string;
	readonly label: string;
	readonly parts: readonly IPartEntry[];
}

export interface IPartSection {
	readonly id: string;
	readonly label: string;
}

export function partName(part: IProjectPart): string {
	switch (part.id) {
		case 'settings': return localize('partName.settings', "Study Settings");
		case 'geometry': return localize('partName.geometry', "Geometry");
		case 'materials': return localize('partName.materials', "Materials");
		case 'mesh': return localize('partName.mesh', "Mesh");
		case 'physics': return localize('partName.physics', "Boundary Conditions & Loads");
		case 'solver': return localize('partName.solver', "Solver");
		case 'results': return localize('partName.results', "Results");
		case 'reports': return localize('partName.reports', "Report");
		case 'marketplace': return localize('partName.marketplace', "Marketplace");
		default: return part.folder.replace(/^\d+\s+/, '');
	}
}

export function partGroups(parts: readonly IProjectPart[]): IPartGroup[] {
	const findPart = (id: string) => parts.find(p => p.id === id);

	return [
		{
			id: 'setup',
			label: localize('partGroup.setup', "Setup"),
			parts: [
				{ number: 1, part: findPart('settings')!, name: localize('partName.settings', "Study Settings") }
			].filter(p => !!p.part)
		},
		{
			id: 'model',
			label: localize('partGroup.model', "Model"),
			parts: [
				{ number: 2, part: findPart('geometry')!, name: localize('partName.geometry', "Geometry") },
				{ number: 3, part: findPart('materials')!, name: localize('partName.materials', "Materials") },
				{ number: 4, part: findPart('mesh')!, name: localize('partName.mesh', "Mesh") },
			].filter(p => !!p.part)
		},
		{
			id: 'physics',
			label: localize('partGroup.physics', "Physics"),
			parts: [
				{ number: 5, part: findPart('physics')!, name: localize('partName.physics', "Boundary Conditions & Loads") }
			].filter(p => !!p.part)
		},
		{
			id: 'solve',
			label: localize('partGroup.solve', "Solve"),
			parts: [
				{ number: 6, part: findPart('solver')!, name: localize('partName.solver', "Solver") }
			].filter(p => !!p.part)
		},
		{
			id: 'outputs',
			label: localize('partGroup.outputs', "Outputs"),
			parts: [
				{ number: 7, part: findPart('results')!, name: localize('partName.results', "Results") },
				{ number: 8, part: findPart('reports')!, name: localize('partName.reports', "Report") },
			].filter(p => !!p.part)
		},
		{
			id: 'library',
			label: localize('partGroup.library', "Library"),
			parts: [
				{ part: findPart('marketplace')!, name: localize('partName.marketplace', "Marketplace"), isUnnumbered: true }
			].filter(p => !!p.part)
		}
	];
}

export function partSections(partId: string): readonly IPartSection[] {
	switch (partId) {
		case 'settings': return [
			{ id: 'general', label: localize('partSection.settingsGeneral', "General & Units") },
			{ id: 'solverDefaults', label: localize('partSection.settingsSolverDefaults', "Default Solver Options") },
		];
		case 'geometry': return [
			{ id: 'cadModel', label: localize('partSection.geometryCadModel', "CAD Model (STEP)") },
			{ id: 'selectors', label: localize('partSection.geometrySelectors', "Topological Selectors") },
		];
		case 'materials': return [
			{ id: 'library', label: localize('partSection.materialsLibrary', "Material Cards") },
		];
		case 'mesh': return [
			{ id: 'sizing', label: localize('partSection.meshSizing', "Element Sizing & Order") },
			{ id: 'quality', label: localize('partSection.meshQuality', "Conformal Quality Checks") },
		];
		case 'physics': return [
			{ id: 'bcs', label: localize('partSection.physicsBcs', "Boundary Conditions & Clamping") },
			{ id: 'loads', label: localize('partSection.physicsLoads', "Applied Loads & Pressures") },
		];
		case 'solver': return [
			{ id: 'deck', label: localize('partSection.solverDeck', "CalculiX Solver Deck") },
		];
		case 'results': return [
			{ id: 'stress', label: localize('partSection.resultsStress', "Von Mises Stress Contours") },
			{ id: 'deformation', label: localize('partSection.resultsDeformation', "Deformed Shape & Displacements") },
		];
		case 'reports': return [
			{ id: 'exports', label: localize('partSection.reportsExports', "Web & VTU Exports") },
		];
		default: return [];
	}
}

export function partResource(project: IMechastudioProject, part: IProjectPart): URI | undefined {
	return part.mainFile ? joinPath(project.root, part.folder, part.mainFile) : undefined;
}

export function isPartEditor(partId: string, editor: EditorInput | undefined): boolean {
	if (!editor) {
		return false;
	}
	switch (partId) {
		case 'geometry': return editor.typeId === CadEditorInput.ID;
		case 'materials': return editor.typeId === MaterialEditorInput.ID;
		case 'mesh': return editor.typeId === MeshEditorInput.ID;
		case 'physics': return editor.typeId === PhysicsEditorInput.ID;
		case 'solver': return editor.typeId === SolverEditorInput.ID;
		case 'results': return editor.typeId === ResultsEditorInput.ID;
		case 'marketplace': return editor.typeId === MarketplaceEditorInput.ID;
		default: return false;
	}
}

export async function openPart(project: IMechastudioProject, part: IProjectPart, services: {
	readonly editorService: IEditorService;
	readonly commandService: ICommandService;
}, options?: { readonly preserveFocus?: boolean }): Promise<void> {
	const root = project.root;
	const mainFileUri = part.mainFile ? joinPath(root, part.folder, part.mainFile) : undefined;
	const preserveFocus = options?.preserveFocus;

	switch (part.id) {
		case 'geometry':
			await services.editorService.openEditor(new CadEditorInput(mainFileUri ?? joinPath(root, '02 Geometry', 'geometry.json')), { pinned: true, preserveFocus });
			break;
		case 'materials':
			await services.editorService.openEditor(new MaterialEditorInput(mainFileUri ?? joinPath(root, '03 Materials', 'materials.json')), { pinned: true, preserveFocus });
			break;
		case 'mesh':
			await services.editorService.openEditor(new MeshEditorInput(mainFileUri ?? joinPath(root, '04 Mesh', 'mesh.json')), { pinned: true, preserveFocus });
			break;
		case 'physics':
			await services.editorService.openEditor(new PhysicsEditorInput(mainFileUri ?? joinPath(root, '05 Physics & BCs', 'physics.json')), { pinned: true, preserveFocus });
			break;
		case 'solver':
			await services.editorService.openEditor(new SolverEditorInput(mainFileUri ?? joinPath(root, '06 Solver', 'solver.json')), { pinned: true, preserveFocus });
			break;
		case 'results':
			await services.editorService.openEditor(new ResultsEditorInput(mainFileUri ?? joinPath(root, '07 Results', 'results.json')), { pinned: true, preserveFocus });
			break;
		case 'marketplace':
			await services.editorService.openEditor(new MarketplaceEditorInput(mainFileUri ?? joinPath(root, '08 Marketplace', 'marketplace.json')), { pinned: true, preserveFocus });
			break;
		case 'settings':
			if (mainFileUri) {
				await services.editorService.openEditor({ resource: mainFileUri, options: { pinned: true, preserveFocus } });
			}
			break;
		case 'reports':
			if (mainFileUri) {
				await services.editorService.openEditor({ resource: mainFileUri, options: { pinned: true, preserveFocus } });
			}
			break;
	}
}

export function stageIcon(state: PartState | undefined): ThemeIcon {
	switch (state) {
		case 'done': return Codicon.passFilled; // filled check
		case 'defaults': return Codicon.info; // filled info ring (counts as satisfied)
		case 'inProgress': return Codicon.circleLargeFilled;
		case 'failed':
		case 'warn':
		case 'error': return Codicon.warning; // warning ring
		case 'stale': return Codicon.history;
		case 'notStarted':
		default: return Codicon.circleLargeOutline; // empty ring
	}
}

export function isPartSatisfied(state: PartState | undefined): boolean {
	return state === 'done' || state === 'defaults';
}

export function stateClass(state: PartState | undefined): string {
	switch (state) {
		case 'done': return 'sa-state-ok';
		case 'defaults': return 'sa-state-info';
		case 'inProgress': return 'sa-state-info';
		case 'stale':
		case 'warn': return 'sa-state-warn';
		case 'failed':
		case 'error': return 'sa-state-fail';
		default: return 'sa-state-idle';
	}
}

export function stateLabel(status: IPartStatus | undefined): string {
	switch (status?.state) {
		case 'done': return localize('partState.done', "Done");
		case 'defaults': return localize('partState.defaults', "Defaults");
		case 'inProgress': return localize('partState.inProgress', "In progress");
		case 'stale': return localize('partState.stale', "Out of date");
		case 'warn': return localize('partState.warn', "Needs attention");
		case 'failed': return localize('partState.failed', "Failed");
		case 'error': return localize('partState.error', "Invalid file");
		default: return localize('partState.notStarted', "Not started");
	}
}

export function stateText(status: IPartStatus | undefined): string {
	if (status?.text) {
		return status.text;
	}
	switch (status?.state) {
		case 'done': return localize('partText.done', "done");
		case 'defaults': return localize('partText.defaults', "defaults");
		case 'inProgress': return localize('partText.inProgress', "in progress");
		case 'stale': return localize('partText.stale', "stale");
		case 'warn': return localize('partText.warn', "needs attention");
		case 'failed': return localize('partText.failed', "failed");
		case 'error': return localize('partText.error', "invalid file");
		default: return localize('partText.notStarted', "not started");
	}
}

export function defaultPartIdleText(partId: string): string {
	switch (partId) {
		case 'geometry': return localize('partStatus.notImported', "not imported");
		case 'mesh': return localize('partStatus.notMeshed', "not meshed");
		case 'physics': return localize('partStatus.notSet', "not set");
		case 'solver': return localize('partStatus.notRun', "not run");
		case 'results': return localize('partStatus.none', "none");
		case 'reports': return localize('partStatus.noReport', "no report");
		default: return localize('partStatus.notStarted', "not started");
	}
}

export function isDeepEqualIgnoringTimestamps(a: any, b: any): boolean {
	if (a === b) {
		return true;
	}
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
		return false;
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		return false;
	}
	if (Array.isArray(a)) {
		if (a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (!isDeepEqualIgnoringTimestamps(a[i], b[i])) {
				return false;
			}
		}
		return true;
	}
	const timestampKeys = new Set(['created', 'updated', 'timestamp', 'date', 'lastModified', 'modified']);
	const aKeys = Object.keys(a).filter(k => !timestampKeys.has(k));
	const bKeys = Object.keys(b).filter(k => !timestampKeys.has(k));
	if (aKeys.length !== bKeys.length) {
		return false;
	}
	for (const key of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(b, key)) {
			return false;
		}
		if (!isDeepEqualIgnoringTimestamps(a[key], b[key])) {
			return false;
		}
	}
	return true;
}

export async function derivePartStatus(
	project: IMechastudioProject,
	part: IProjectPart,
	data: any,
	fileService: IFileService
): Promise<IPartStatus> {
	if (!data || typeof data !== 'object') {
		return {
			part: part.id,
			state: 'warn',
			text: localize('partStatus.needsAttention', "needs attention"),
			hint: localize('partStatus.invalidObject', "Invalid JSON data"),
		};
	}

	if (typeof data.schema !== 'number') {
		return {
			part: part.id,
			state: 'warn',
			text: localize('partStatus.needsAttention', "needs attention"),
			hint: localize('partStatus.schemaMismatch', "Missing or invalid schema version"),
		};
	}

	let equalsDefault = false;
	try {
		const initialJson = part.initialContent(project.manifest.name, project.manifest.unitSystem);
		const initialObj = JSON.parse(initialJson);
		equalsDefault = isDeepEqualIgnoringTimestamps(data, initialObj);
	} catch {
		equalsDefault = false;
	}

	switch (part.id) {
		case 'settings': {
			if (equalsDefault) {
				return { part: part.id, state: 'defaults', text: localize('partStatus.defaults', "defaults") };
			}
			return { part: part.id, state: 'done', text: localize('partStatus.configured', "configured") };
		}

		case 'geometry': {
			if (equalsDefault) {
				return { part: part.id, state: 'notStarted', text: localize('partStatus.notImported', "not imported") };
			}
			const cadFile = data.cadFile;
			let cadExists = false;
			if (typeof cadFile === 'string' && cadFile.trim().length > 0) {
				cadExists = await fileService.exists(joinPath(project.root, part.folder, cadFile)) ||
					await fileService.exists(joinPath(project.root, cadFile));
			}
			if (cadExists) {
				const bodies = data.bodies;
				const count = Array.isArray(bodies) ? bodies.length : 0;
				// Bodies are listed by the engine on the first mesh run; until then just say imported.
				const text = count === 0
					? localize('partStatus.imported', "imported")
					: count === 1
						? localize('partStatus.oneBody', "1 body")
						: localize('partStatus.nBodies', "{0} bodies", count);
				return { part: part.id, state: 'done', text };
			}
			return { part: part.id, state: 'notStarted', text: localize('partStatus.notImported', "not imported") };
		}

		case 'materials': {
			if (equalsDefault) {
				return { part: part.id, state: 'defaults', text: localize('partStatus.defaults', "defaults") };
			}
			const materials = data.materials;
			if (Array.isArray(materials) && materials.length > 0) {
				const count = materials.length;
				const text = count === 1
					? localize('partStatus.oneMaterial', "1 material")
					: localize('partStatus.nMaterials', "{0} materials", count);
				return { part: part.id, state: 'done', text };
			}
			return { part: part.id, state: 'notStarted', text: localize('partStatus.notStarted', "not started") };
		}

		case 'mesh': {
			const namedMesh = typeof data.meshFile === 'string' ? data.meshFile
				: typeof data.outputMesh === 'string' ? data.outputMesh
				: typeof data.mesh === 'string' ? data.mesh
				: typeof data.file === 'string' ? data.file : undefined;

			let meshExists = false;
			if (namedMesh) {
				meshExists = await fileService.exists(joinPath(project.root, part.folder, namedMesh)) ||
					await fileService.exists(joinPath(project.root, namedMesh));
			}
			if (!meshExists) {
				try {
					const stat = await fileService.resolve(joinPath(project.root, part.folder));
					if (stat.children) {
						meshExists = stat.children.some(c => !c.isDirectory && (c.name.endsWith('.inp') || c.name.endsWith('.msh')));
					}
				} catch {
					meshExists = false;
				}
			}
			if (!meshExists) {
				try {
					const stat = await fileService.resolve(joinPath(project.root, 'sim_output'));
					if (stat.children) {
						meshExists = stat.children.some(c => !c.isDirectory && (c.name.endsWith('.inp') || c.name.endsWith('.msh')));
					}
				} catch { }
			}

			if (meshExists) {
				const elementCount = data.elementCount ?? data.numElements ?? data.totalElements ?? (typeof data.elements === 'number' ? data.elements : undefined);
				if (typeof elementCount === 'number' && elementCount > 0) {
					return {
						part: part.id,
						state: 'done',
						text: elementCount === 1 ? localize('partStatus.oneElement', "1 element") : localize('partStatus.nElements', "{0} elements", elementCount.toLocaleString())
					};
				}
				return { part: part.id, state: 'done', text: localize('partStatus.meshed', "meshed") };
			}

			return { part: part.id, state: 'notStarted', text: localize('partStatus.notMeshed', "not meshed") };
		}

		case 'physics': {
			if (equalsDefault) {
				return { part: part.id, state: 'defaults', text: localize('partStatus.defaults', "defaults") };
			}
			const bcs = Array.isArray(data.constraints) ? data.constraints.length : 0;
			const lds = Array.isArray(data.loads) ? data.loads.length : 0;
			if (bcs > 0 || lds > 0) {
				const geometryPart = PROJECT_PARTS.find(p => p.id === 'geometry')!;
				const geometry = await readJson(fileService, joinPath(project.root, geometryPart.folder, geometryPart.mainFile));
				const problems = physicsProblems(data, selectorNamesOf(geometry));
				if (problems.length > 0) {
					return {
						part: part.id,
						state: 'warn',
						text: localize('partStatus.needsAttention', "needs attention"),
						hint: problems.join('; '),
					};
				}
				const bcText = `${bcs} BC${bcs === 1 ? '' : 's'}`;
				const loadText = `${lds} load${lds === 1 ? '' : 's'}`;
				return { part: part.id, state: 'done', text: `${bcText}, ${loadText}` };
			}
			return { part: part.id, state: 'notStarted', text: localize('partStatus.notSet', "not set") };
		}

		case 'solver': {
			if (equalsDefault) {
				return { part: part.id, state: 'notStarted', text: localize('partStatus.notRun', "not run") };
			}
			let hasSolverOutput = false;
			try {
				const stat = await fileService.resolve(joinPath(project.root, part.folder));
				if (stat.children) {
					hasSolverOutput = stat.children.some(c =>
						!c.isDirectory && (
							c.name.endsWith('.frd') ||
							c.name.endsWith('.dat') ||
							c.name.endsWith('.sta') ||
							c.name.endsWith('.cvg')
						)
					);
				}
			} catch {
				hasSolverOutput = false;
			}

			if (!hasSolverOutput) {
				try {
					const stat = await fileService.resolve(joinPath(project.root, 'sim_output'));
					if (stat.children) {
						hasSolverOutput = stat.children.some(c =>
							!c.isDirectory && (
								c.name.endsWith('.frd') ||
								c.name.endsWith('.dat') ||
								c.name.endsWith('.sta') ||
								c.name.endsWith('.cvg')
							)
						);
					}
				} catch { }
			}

			if (hasSolverOutput) {
				const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
				if (status === 'converged' || status === 'solved' || status === 'success') {
					return { part: part.id, state: 'done', text: localize('partStatus.converged', "converged") };
				}
				if (status === 'failed' || status === 'error') {
					return { part: part.id, state: 'failed', text: localize('partStatus.failed', "failed") };
				}
				if (status === 'running' || status === 'solving') {
					return { part: part.id, state: 'inProgress', text: localize('partStatus.solving', "solving...") };
				}
				return { part: part.id, state: 'done', text: localize('partStatus.converged', "converged") };
			}

			const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
			if (status === 'running' || status === 'solving') {
				return { part: part.id, state: 'inProgress', text: localize('partStatus.solving', "solving...") };
			}
			return { part: part.id, state: 'notStarted', text: localize('partStatus.notRun', "not run") };
		}

		case 'results': {
			if (equalsDefault) {
				return { part: part.id, state: 'notStarted', text: localize('partStatus.none', "none") };
			}
			let hasResultFile = false;
			if (typeof data.resultFile === 'string') {
				hasResultFile = await fileService.exists(joinPath(project.root, part.folder, data.resultFile)) ||
					await fileService.exists(joinPath(project.root, data.resultFile));
			}
			if (!hasResultFile) {
				try {
					const resultsStat = await fileService.resolve(joinPath(project.root, part.folder));
					hasResultFile = !!resultsStat.children?.some(c => !c.isDirectory && (c.name.endsWith('.vtu') || c.name.endsWith('.frd') || c.name.endsWith('.gltf')));
				} catch { }
			}
			if (!hasResultFile) {
				try {
					const solverStat = await fileService.resolve(joinPath(project.root, '06 Solver'));
					hasResultFile = !!solverStat.children?.some(c => !c.isDirectory && (c.name.endsWith('.vtu') || c.name.endsWith('.frd') || c.name.endsWith('.gltf')));
				} catch { }
			}
			if (!hasResultFile) {
				try {
					const simStat = await fileService.resolve(joinPath(project.root, 'sim_output'));
					hasResultFile = !!simStat.children?.some(c => !c.isDirectory && (c.name.endsWith('.vtu') || c.name.endsWith('.frd') || c.name.endsWith('.gltf')));
				} catch { }
			}

			if (hasResultFile) {
				return { part: part.id, state: 'done', text: localize('partStatus.ready', "ready") };
			}
			return { part: part.id, state: 'notStarted', text: localize('partStatus.none', "none") };
		}

		case 'reports': {
			if (equalsDefault) {
				return { part: part.id, state: 'notStarted', text: localize('partStatus.noReport', "no report") };
			}
			let existingCount = 0;
			if (Array.isArray(data.exports)) {
				for (const exp of data.exports) {
					if (typeof exp === 'string') {
						const exists = await fileService.exists(joinPath(project.root, part.folder, exp)) ||
							await fileService.exists(joinPath(project.root, exp));
						if (exists) {
							existingCount++;
						}
					}
				}
			}
			if (existingCount === 0) {
				try {
					const reportStat = await fileService.resolve(joinPath(project.root, part.folder));
					const nonJson = reportStat.children?.filter(c => !c.isDirectory && !c.name.endsWith('.json')) ?? [];
					existingCount = nonJson.length;
				} catch { }
			}

			if (existingCount > 0) {
				const text = existingCount === 1 ? localize('partStatus.oneExport', "1 export") : localize('partStatus.nExports', "{0} exports", existingCount);
				return { part: part.id, state: 'done', text };
			}
			return { part: part.id, state: 'notStarted', text: localize('partStatus.noReport', "no report") };
		}

		case 'marketplace': {
			if (Array.isArray(data.installedPackages) && data.installedPackages.length > 0) {
				const count = data.installedPackages.length;
				const text = count === 1 ? localize('partStatus.onePackage', "1 package") : localize('partStatus.nPackages', "{0} packages", count);
				return { part: part.id, state: 'defaults', text };
			}
			return { part: part.id, state: 'defaults', text: localize('partStatus.zeroPackages', "0 packages") };
		}

		default:
			return { part: part.id, state: 'notStarted', text: defaultPartIdleText(part.id) };
	}
}

export function nextStep(statuses: ReadonlyMap<string, IPartStatus> | readonly IPartStatus[]): { part: string; label: string } | undefined {
	const get = (id: string): IPartStatus | undefined => {
		if (Array.isArray(statuses)) {
			return statuses.find(s => s.part === id);
		}
		return (statuses as ReadonlyMap<string, IPartStatus>).get(id);
	};

	const steps: { part: string; label: string }[] = [
		{ part: 'geometry', label: localize('step.geometry', "Geometry") },
		{ part: 'materials', label: localize('step.materials', "Materials") },
		{ part: 'mesh', label: localize('step.mesh', "Mesh") },
		{ part: 'physics', label: localize('step.physics', "Boundary Conditions & Loads") },
		{ part: 'solver', label: localize('step.solver', "Solver") },
		{ part: 'results', label: localize('step.results', "Results") },
	];

	for (const step of steps) {
		const s = get(step.part);
		if (!s || s.state === 'notStarted' || s.state === 'failed' || s.state === 'warn' || s.state === 'error') {
			return step;
		}
	}
	return undefined;
}

export async function resolveBenchmarkUri(environmentService: IEnvironmentService, fileService: IFileService): Promise<URI | undefined> {
	const nativeEnv = environmentService as Partial<INativeEnvironmentService>;
	const rootStr = nativeEnv.appRoot;
	let curr = rootStr ? URI.file(rootStr) : environmentService.userRoamingDataHome;
	for (let i = 0; i < 10; i++) {
		const candidates = [
			joinPath(curr, 'examples', 'cantilever_beam'),
			joinPath(curr, '..', 'MAEngine', 'examples', 'cantilever_beam')
		];
		for (const candidate of candidates) {
			try {
				if (await fileService.exists(candidate)) {
					return candidate;
				}
			} catch {
				// ignore
			}
		}
		const parent = dirname(curr);
		if (isEqual(parent, curr)) {
			break;
		}
		curr = parent;
	}
	return undefined;
}

export async function resolvePythonExecutable(environmentService: IEnvironmentService, fileService: IFileService): Promise<string | undefined> {
	const nativeEnv = environmentService as Partial<INativeEnvironmentService>;
	const rootStr = nativeEnv.appRoot;
	let curr = rootStr ? URI.file(rootStr) : environmentService.userRoamingDataHome;
	for (let i = 0; i < 10; i++) {
		const candidates = isWindows
			? [
				joinPath(curr, '.venv', 'Scripts', 'python.exe'),
				joinPath(curr, '..', 'MAEngine', '.venv', 'Scripts', 'python.exe')
			]
			: [
				joinPath(curr, '.venv', 'bin', 'python'),
				joinPath(curr, '..', 'MAEngine', '.venv', 'bin', 'python')
			];
		for (const candidate of candidates) {
			try {
				if (await fileService.exists(candidate)) {
					return candidate.fsPath;
				}
			} catch {
				// ignore
			}
		}
		const parent = dirname(curr);
		if (isEqual(parent, curr)) {
			break;
		}
		curr = parent;
	}

	// Fall back to python on PATH
	try {
		const envPath = typeof process !== 'undefined'
			? (process.env?.['PATH'] || process.env?.['Path'] || '')
			: '';
		if (envPath) {
			const separator = isWindows ? ';' : ':';
			const dirs = envPath.split(separator);
			const exeName = isWindows ? 'python.exe' : 'python';
			for (const dir of dirs) {
				const trimmed = dir.trim();
				if (!trimmed) {
					continue;
				}
				try {
					const candidate = joinPath(URI.file(trimmed), exeName);
					if (await fileService.exists(candidate)) {
						return 'python';
					}
				} catch {
					// ignore
				}
			}
		}
	} catch {
		// ignore
	}

	return undefined;
}

export async function workspaceHasSimulationYaml(
	fileService: IFileService,
	contextService: IWorkspaceContextService,
	projectService?: IMAEngineProjectService
): Promise<boolean> {
	if (projectService?.project) {
		const candidate = joinPath(projectService.project.root, 'simulation.yaml');
		try {
			if (await fileService.exists(candidate)) {
				return true;
			}
		} catch { }
	}
	const folders = contextService.getWorkspace().folders;
	if (folders.length > 0) {
		const candidate = joinPath(folders[0].uri, 'simulation.yaml');
		try {
			if (await fileService.exists(candidate)) {
				return true;
			}
		} catch { }
	}
	return false;
}

export type RunStage = 'mesh' | 'solve';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Problems that stop the engine from running the study's physics, mirroring the checks in
 * `maengine/project_bridge.py` (load_study). Empty when the physics can run.
 */
export function physicsProblems(physics: any, selectorNames: readonly string[]): string[] {
	const problems: string[] = [];
	const names = new Set(selectorNames);
	const checkSelector = (kind: string, id: string, selector: unknown) => {
		if (typeof selector !== 'string' || !selector) {
			problems.push(localize('physics.problem.noSelector', "{0} '{1}' has no selector", kind, id));
		} else if (!names.has(selector)) {
			problems.push(localize('physics.problem.missingSelector', "selector '{0}' is not defined in Geometry", selector));
		}
	};
	const constraints: any[] = Array.isArray(physics?.constraints) ? physics.constraints : [];
	const loads: any[] = Array.isArray(physics?.loads) ? physics.loads : [];
	if (constraints.length === 0) {
		problems.push(localize('physics.problem.noSupport', "no support is defined"));
	}
	constraints.forEach((c, i) => {
		const id = String(c?.id ?? `bc_${i + 1}`);
		if (c?.type === 'fixed') {
			checkSelector(localize('physics.constraint', "constraint"), id, c.selector);
		} else if (c?.type === 'displacement') {
			checkSelector(localize('physics.constraint', "constraint"), id, c.selector);
			if (![c.ux, c.uy, c.uz].some(isNum)) {
				problems.push(localize('physics.problem.noDisp', "constraint '{0}' sets no displacement component", id));
			}
		} else {
			problems.push(localize('physics.problem.constraintType', "constraint '{0}' has an unsupported type", id));
		}
	});
	loads.forEach((l, i) => {
		const id = String(l?.id ?? `load_${i + 1}`);
		if (l?.type === 'force') {
			checkSelector(localize('physics.load', "load"), id, l.selector);
			const v = l.vector;
			if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) {
				problems.push(localize('physics.problem.forceVector', "load '{0}' needs a force vector", id));
			} else if (v.every((x: number) => x === 0)) {
				problems.push(localize('physics.problem.zeroForce', "load '{0}' is a zero force", id));
			}
		} else if (l?.type === 'pressure') {
			checkSelector(localize('physics.load', "load"), id, l.selector);
			if (!isNum(l.magnitude)) {
				problems.push(localize('physics.problem.pressure', "load '{0}' needs a pressure in MPa", id));
			} else if (l.magnitude === 0) {
				problems.push(localize('physics.problem.zeroPressure', "load '{0}' is a zero pressure", id));
			}
		} else {
			problems.push(localize('physics.problem.loadType', "load '{0}' has an unsupported type", id));
		}
	});
	const g = physics?.gravity;
	if (g !== null && g !== undefined && !(Array.isArray(g) && g.length === 3 && g.every(isNum))) {
		problems.push(localize('physics.problem.gravity', "gravity must be [gx, gy, gz] in mm/s² or None"));
	}
	return [...new Set(problems)];
}

export function selectorNamesOf(geometry: any): string[] {
	return (Array.isArray(geometry?.selectors) ? geometry.selectors : [])
		.map((s: any) => s?.name)
		.filter((n: unknown): n is string => typeof n === 'string');
}

export interface IRunTarget {
	/** 'spec': the folder has a simulation.yaml; 'study': a study run by `maengine run-project`. */
	readonly kind: 'spec' | 'study' | 'none';
	readonly canRun: boolean;
	/** simulation.yaml for 'spec', the study root folder for 'study'. */
	readonly target?: URI;
	/** Why the study cannot run yet (shown in place of the run button). */
	readonly reason?: string;
}

async function readJson(fileService: IFileService, uri: URI): Promise<any> {
	try {
		return JSON.parse((await fileService.readFile(uri)).value.toString());
	} catch {
		return undefined;
	}
}

/**
 * Decides whether mesh/solve can really run for the open folder, mirroring the checks the
 * engine's `run-project` makes first. The engine still validates everything and reports
 * precise errors; this only keeps buttons disabled when a run is certain to fail.
 */
export async function resolveRunTarget(
	stage: RunStage,
	fileService: IFileService,
	contextService: IWorkspaceContextService,
	projectService: IMAEngineProjectService
): Promise<IRunTarget> {
	const project = projectService.project;
	const roots = [project?.root, contextService.getWorkspace().folders[0]?.uri].filter((u): u is URI => !!u);
	for (const root of roots) {
		const yaml = joinPath(root, 'simulation.yaml');
		try {
			if (await fileService.exists(yaml)) {
				return { kind: 'spec', canRun: true, target: yaml };
			}
		} catch { }
	}
	if (!project) {
		return { kind: 'none', canRun: false, reason: localize('run.noStudy', "Open a study to run it") };
	}

	const root = project.root;
	const part = (id: string) => PROJECT_PARTS.find(p => p.id === id)!;
	const fail = (reason: string): IRunTarget => ({ kind: 'study', canRun: false, target: root, reason });

	const settings = await readJson(fileService, joinPath(root, part('settings').folder, part('settings').mainFile));
	const units = settings?.project?.unitSystem ?? 'mm_N_MPa_tonne_s';
	if (units !== 'mm_N_MPa_tonne_s') {
		return fail(localize('run.units', "Only mm-N-MPa studies can run (Study Settings)"));
	}

	const geometry = await readJson(fileService, joinPath(root, part('geometry').folder, part('geometry').mainFile));
	const cadFile = geometry?.cadFile;
	let cadExists = false;
	if (typeof cadFile === 'string' && cadFile.trim()) {
		cadExists = await fileService.exists(joinPath(root, part('geometry').folder, cadFile)) || await fileService.exists(joinPath(root, cadFile));
	}
	if (!cadExists) {
		return fail(localize('run.noCad', "Import a CAD file in Geometry first"));
	}

	const materials = await readJson(fileService, joinPath(root, part('materials').folder, part('materials').mainFile));
	if (!Array.isArray(materials?.materials) || materials.materials.length === 0) {
		return fail(localize('run.noMaterial', "Add a material card in Materials first"));
	}

	if (stage === 'solve') {
		const physics = await readJson(fileService, joinPath(root, part('physics').folder, part('physics').mainFile));
		const problems = physicsProblems(physics, selectorNamesOf(geometry));
		if (problems.length > 0) {
			return fail(localize('run.physics', "Boundary Conditions & Loads: {0}", problems[0]));
		}
		const solver = await readJson(fileService, joinPath(root, part('solver').folder, part('solver').mainFile));
		const analysis = solver?.analysisType ?? 'static_linear';
		if (analysis !== 'static_linear') {
			return fail(localize('run.analysis', "Only static linear analysis can run from a study yet"));
		}
	}
	return { kind: 'study', canRun: true, target: root };
}

export async function resolvePartStatus(
	partId: string,
	fileService: IFileService,
	projectService: IMAEngineProjectService,
	data?: any,
	resource?: URI
): Promise<IPartStatus> {
	let project = projectService.project;
	const part = PROJECT_PARTS.find(p => p.id === partId);
	if (!part) {
		return { part: partId, state: 'notStarted', text: defaultPartIdleText(partId) };
	}

	if (!project && resource) {
		const folderUri = dirname(resource);
		const root = dirname(folderUri);
		project = {
			root,
			manifestUri: joinPath(root, 'project.maengine'),
			manifest: createManifest('Study', 'mm_N_MPa_tonne_s')
		};
	}

	if (!project) {
		return { part: partId, state: 'notStarted', text: defaultPartIdleText(partId) };
	}

	let fileData = data;
	if (!fileData && part.mainFile) {
		try {
			const fileUri = joinPath(project.root, part.folder, part.mainFile);
			const content = await fileService.readFile(fileUri);
			fileData = JSON.parse(content.value.toString());
		} catch {
			return { part: partId, state: 'notStarted', text: defaultPartIdleText(partId) };
		}
	}

	return await derivePartStatus(project, part, fileData, fileService);
}

export class PartStatusProvider extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly statuses = new Map<string, IPartStatus>();
	private refreshSequence = 0;
	private readonly refreshDebouncer = this._register(new RunOnceScheduler(() => void this.doRefresh(), 300));

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IMAEngineProjectService private readonly projectService: IMAEngineProjectService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(this.projectService.onDidChangeProject(() => {
			this.refreshSequence++;
			this.statuses.clear();
			this._onDidChange.fire();
			this.refreshDebouncer.schedule();
		}));
		this._register(this.fileService.onDidFilesChange(e => {
			const project = this.projectService.project;
			if (project) {
				const affectsPartFolder = PROJECT_PARTS.some(part => e.affects(joinPath(project.root, part.folder)));
				if (affectsPartFolder) {
					this.refreshDebouncer.schedule();
				}
			}
		}));
		void this.doRefresh();
	}

	getStatus(partId: string): IPartStatus {
		return this.statuses.get(partId) ?? {
			part: partId,
			state: 'notStarted',
			text: defaultPartIdleText(partId),
		};
	}

	getAllStatuses(): ReadonlyMap<string, IPartStatus> {
		return this.statuses;
	}

	async refresh(): Promise<void> {
		this.refreshDebouncer.schedule();
	}

	private async doRefresh(): Promise<void> {
		const seq = ++this.refreshSequence;
		const project = this.projectService.project;
		if (!project) {
			this.statuses.clear();
			this._onDidChange.fire();
			return;
		}

		const newStatuses = new Map<string, IPartStatus>();
		await Promise.all(PROJECT_PARTS.map(async part => {
			const status = await this.readStatus(project, part);
			newStatuses.set(part.id, status);
		}));

		if (seq !== this.refreshSequence || project !== this.projectService.project) {
			return;
		}

		this.statuses.clear();
		for (const [id, s] of newStatuses) {
			this.statuses.set(id, s);
			if (this.configurationService.getValue<boolean>('maengine.developerMode')) {
				console.log(`[maengine-status] ${id}: state=${s.state}, text="${s.text}"`);
			}
		}

		this._onDidChange.fire();
	}

	private async readStatus(project: IMechastudioProject, part: IProjectPart): Promise<IPartStatus> {
		if (!part.mainFile) {
			return { part: part.id, state: 'notStarted', text: defaultPartIdleText(part.id) };
		}
		const fileUri = joinPath(project.root, part.folder, part.mainFile);
		try {
			const content = await this.fileService.readFile(fileUri);
			const text = content.value.toString();
			let parsed: any;
			try {
				parsed = JSON.parse(text);
			} catch (parseError: any) {
				return {
					part: part.id,
					state: 'warn',
					text: localize('partStatus.needsAttention', "needs attention"),
					hint: parseError?.message || localize('partStatus.parseError', "Failed to parse JSON file"),
				};
			}
			return await derivePartStatus(project, part, parsed, this.fileService);
		} catch {
			return { part: part.id, state: 'notStarted', text: defaultPartIdleText(part.id) };
		}
	}
}
