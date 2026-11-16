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
import { CadEditor } from './cadEditor.js';
import { CadEditorInput } from './cadEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(CadEditor, CadEditorInput.EDITOR_ID, localize('cadEditor', "02 Geometry & CAD")),
	[new SyncDescriptor(CadEditorInput)]
);

class CadEditorResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.maengineCadEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
	) {
		super();

		this._register(
			editorResolverService.registerEditor(
				'**/02 Geometry/geometry.json',
				{
					id: CadEditorInput.EDITOR_ID,
					label: localize('cadEditor.resolverLabel', "Geometry & CAD"),
					priority: RegisteredEditorPriority.default
				},
				{
					singlePerResource: true,
					canSupportResource: resource => /\/02 Geometry\/geometry\.json$/i.test(resource.path)
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: new CadEditorInput(resource),
						options
					})
				}
			)
		);
	}
}

registerWorkbenchContribution2(CadEditorResolverContribution.ID, CadEditorResolverContribution, WorkbenchPhase.BlockStartup);
