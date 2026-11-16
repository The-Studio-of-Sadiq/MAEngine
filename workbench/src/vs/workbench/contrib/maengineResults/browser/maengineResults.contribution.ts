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
import { ResultsEditor } from './resultsEditor.js';
import { ResultsEditorInput } from './resultsEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ResultsEditor, ResultsEditorInput.EDITOR_ID, localize('resultsEditor', "07 Analysis Results")),
	[new SyncDescriptor(ResultsEditorInput)]
);

class ResultsEditorResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.maengineResultsEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
	) {
		super();

		this._register(
			editorResolverService.registerEditor(
				'**/07 Results/results.json',
				{
					id: ResultsEditorInput.EDITOR_ID,
					label: localize('resultsEditor.resolverLabel', "Analysis Results"),
					priority: RegisteredEditorPriority.default
				},
				{
					singlePerResource: true,
					canSupportResource: resource => /\/07 Results\/results\.json$/i.test(resource.path)
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: new ResultsEditorInput(resource),
						options
					})
				}
			)
		);
	}
}

registerWorkbenchContribution2(ResultsEditorResolverContribution.ID, ResultsEditorResolverContribution, WorkbenchPhase.BlockStartup);

