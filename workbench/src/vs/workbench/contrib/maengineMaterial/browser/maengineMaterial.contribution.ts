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
import { MaterialEditor } from './materialEditor.js';
import { MaterialEditorInput } from './materialEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(MaterialEditor, MaterialEditorInput.EDITOR_ID, localize('materialEditor', "03 Materials")),
	[new SyncDescriptor(MaterialEditorInput)]
);

class MaterialEditorResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.maengineMaterialEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
	) {
		super();

		this._register(
			editorResolverService.registerEditor(
				'**/03 Materials/materials.json',
				{
					id: MaterialEditorInput.EDITOR_ID,
					label: localize('materialEditor.resolverLabel', "Materials"),
					priority: RegisteredEditorPriority.default
				},
				{
					singlePerResource: true,
					canSupportResource: resource => /\/03 Materials\/materials\.json$/i.test(resource.path)
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: new MaterialEditorInput(resource),
						options
					})
				}
			)
		);
	}
}

registerWorkbenchContribution2(MaterialEditorResolverContribution.ID, MaterialEditorResolverContribution, WorkbenchPhase.BlockStartup);

