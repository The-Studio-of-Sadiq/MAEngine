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
import { MeshEditor } from './meshEditor.js';
import { MeshEditorInput } from './meshEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(MeshEditor, MeshEditorInput.EDITOR_ID, localize('meshEditor', "04 3D Conformal Mesh")),
	[new SyncDescriptor(MeshEditorInput)]
);

class MeshEditorResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.maengineMeshEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
	) {
		super();

		this._register(
			editorResolverService.registerEditor(
				'**/04 Mesh/mesh.json',
				{
					id: MeshEditorInput.EDITOR_ID,
					label: localize('meshEditor.resolverLabel', "Mesh"),
					priority: RegisteredEditorPriority.default
				},
				{
					singlePerResource: true,
					canSupportResource: resource => /\/04 Mesh\/mesh\.json$/i.test(resource.path)
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: new MeshEditorInput(resource),
						options
					})
				}
			)
		);
	}
}

registerWorkbenchContribution2(MeshEditorResolverContribution.ID, MeshEditorResolverContribution, WorkbenchPhase.BlockStartup);

