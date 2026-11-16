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
import { MarketplaceEditor } from './marketplaceEditor.js';
import { MarketplaceEditorInput } from './marketplaceEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(MarketplaceEditor, MarketplaceEditorInput.EDITOR_ID, localize('marketplaceEditor', "Marketplace")),
	[new SyncDescriptor(MarketplaceEditorInput)]
);

class MarketplaceEditorResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.maengineMarketplaceEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
	) {
		super();

		this._register(
			editorResolverService.registerEditor(
				'**/08 Marketplace/marketplace.json',
				{
					id: MarketplaceEditorInput.EDITOR_ID,
					label: localize('marketplaceEditor.resolverLabel', "Marketplace"),
					priority: RegisteredEditorPriority.default
				},
				{
					singlePerResource: true,
					canSupportResource: resource => /\/08 Marketplace\/marketplace\.json$/i.test(resource.path)
				},
				{
					createEditorInput: ({ resource, options }) => ({
						editor: new MarketplaceEditorInput(resource),
						options
					})
				}
			)
		);
	}
}

registerWorkbenchContribution2(MarketplaceEditorResolverContribution.ID, MarketplaceEditorResolverContribution, WorkbenchPhase.BlockStartup);

