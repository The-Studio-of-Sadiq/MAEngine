/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { SolverEditor } from './solverEditor.js';
import { SolverEditorInput } from './solverEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(SolverEditor, SolverEditorInput.EDITOR_ID, localize('solverEditor', "06 Solver Manager")),
	[new SyncDescriptor(SolverEditorInput)]
);

class SolverEditorResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.maengineSolverEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
	) {
		super();

		this._register(
			editorResolverService.registerEditor(
				'**/06 Solver/solver.json',
				{
					id: SolverEditorInput.EDITOR_ID,
					label: localize('solverEditor.resolverLabel', "Solver Manager"),
					priority: RegisteredEditorPriority.default
				},
				{
					singlePerResource: true,
					canSupportResource: resource => /\/06 Solver\/solver\.json$/i.test(resource.path)
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: new SolverEditorInput(resource),
						options
					})
				}
			)
		);
	}
}

registerWorkbenchContribution2(SolverEditorResolverContribution.ID, SolverEditorResolverContribution, WorkbenchPhase.BlockStartup);

