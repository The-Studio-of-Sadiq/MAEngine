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
import { PhysicsEditor } from './physicsEditor.js';
import { PhysicsEditorInput } from './physicsEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(PhysicsEditor, PhysicsEditorInput.EDITOR_ID, localize('physicsEditor', "05 Physics & BCs")),
	[new SyncDescriptor(PhysicsEditorInput)]
);

class PhysicsEditorResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.maenginePhysicsEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
	) {
		super();

		this._register(
			editorResolverService.registerEditor(
				'**/05 Physics & BCs/physics.json',
				{
					id: PhysicsEditorInput.EDITOR_ID,
					label: localize('physicsEditor.resolverLabel', "Physics & BCs"),
					priority: RegisteredEditorPriority.default
				},
				{
					singlePerResource: true,
					canSupportResource: resource => /\/05 Physics & BCs\/physics\.json$/i.test(resource.path)
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: new PhysicsEditorInput(resource),
						options
					})
				}
			)
		);
	}
}

registerWorkbenchContribution2(PhysicsEditorResolverContribution.ID, PhysicsEditorResolverContribution, WorkbenchPhase.BlockStartup);

