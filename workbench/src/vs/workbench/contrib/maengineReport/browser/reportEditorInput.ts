/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export class ReportEditorInput extends EditorInput {

	static readonly ID: string = 'workbench.input.maengineReport';
	static readonly EDITOR_ID: string = 'maengine.reportEditor';

	constructor(readonly resource: URI) {
		super();
	}

	override get typeId(): string {
		return ReportEditorInput.ID;
	}

	override get editorId(): string {
		return ReportEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.None;
	}

	override getName(): string {
		return localize('reportEditor.name', "Report");
	}

	override getIcon(): ThemeIcon {
		return Codicon.fileText;
	}

	override matches(other: EditorInput): boolean {
		return other instanceof ReportEditorInput && other.resource.toString() === this.resource.toString();
	}
}
