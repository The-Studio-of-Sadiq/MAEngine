/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MAEngine contributors. All rights reserved.
 *  Licensed under the MIT license.
 *--------------------------------------------------------------------------------------------*/

import './media/reportEditor.css';
import { $, append } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { dirname, isEqual, isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { EditorFrame } from '../../maengineProject/browser/editorFrame.js';
import { IWebviewElement, IWebviewService } from '../../webview/browser/webview.js';
import { ReportEditorInput } from './reportEditorInput.js';

interface IReportsData {
	readonly schema?: number;
	readonly exports?: readonly string[];
	readonly report?: string;
	readonly generatedAt?: string;
}

const REPORT_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">`;

function injectReportCsp(html: string): string {
	if (/<head\b[^>]*>/i.test(html)) {
		return html.replace(/<head\b[^>]*>/i, match => `${match}\n\t${REPORT_CSP_META}`);
	}
	if (/<html\b[^>]*>/i.test(html)) {
		return html.replace(/<html\b[^>]*>/i, match => `${match}\n<head>\n\t${REPORT_CSP_META}\n</head>`);
	}
	return `<!DOCTYPE html>\n<html>\n<head>\n\t${REPORT_CSP_META}\n</head>\n<body>\n${html}\n</body>\n</html>`;
}

function formatGeneratedAt(generatedAt: string | undefined): string | undefined {
	if (typeof generatedAt !== 'string' || generatedAt.trim().length === 0) {
		return undefined;
	}
	const parsed = new Date(generatedAt);
	if (Number.isNaN(parsed.getTime())) {
		return undefined;
	}
	return parsed.toLocaleString();
}

export class ReportEditor extends EditorPane {

	private frame!: EditorFrame;
	private viewport!: HTMLElement;
	private webview!: IWebviewElement;
	private openInBrowserAction!: Action;
	private revealInFolderAction!: Action;

	private readonly inputDisposables = this._register(new DisposableStore());

	private currentResource: URI | undefined;
	private reportUri: URI | undefined;
	private webviewLoaded = false;
	private webviewDismounted = false;
	private loadGeneration = 0;
	private isDisposed = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(ReportEditorInput.EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.frame = this._register(this.instantiationService.createInstance(EditorFrame, parent, {
			id: 'maengine.reportEditor',
			ariaLabel: localize('reportEditor.aria', "Report")
		}));
		this.frame.element.classList.add('maengine-report-editor');
		this.frame.setTitle(localize('report.title', "Report"));

		this.openInBrowserAction = this._register(new Action(
			'maengine.report.openInBrowser',
			localize('report.openInBrowser', "Open in browser"),
			ThemeIcon.asClassName(Codicon.linkExternal),
			false,
			() => this.openInBrowser()
		));

		this.revealInFolderAction = this._register(new Action(
			'maengine.report.revealInFolder',
			localize('report.revealInFolder', "Reveal in folder"),
			ThemeIcon.asClassName(Codicon.folderOpened),
			false,
			() => this.revealInFolder()
		));

		this.frame.setActions([this.openInBrowserAction, this.revealInFolderAction]);

		this.viewport = append(this.frame.main, $('.ma-report-viewport.hidden'));

		this.webview = this._register(this.webviewService.createWebviewElement({
			title: localize('reportEditor.webviewTitle', "Report"),
			options: { retainContextWhenHidden: true },
			contentOptions: { allowScripts: false },
			extension: undefined
		}));
		this.webview.mountTo(this.viewport, this.window);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();

		const resource = input instanceof ReportEditorInput ? input.resource : undefined;
		this.currentResource = resource;
		if (resource) {
			const folder = dirname(resource);
			this.inputDisposables.add(this.fileService.onDidFilesChange(e => {
				if (e.contains(resource) || (this.reportUri && e.contains(this.reportUri)) || e.affects(folder)) {
					void this.load(resource);
				}
			}));
			await this.load(resource);
		} else {
			this.showEmpty();
		}
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (!visible) {
			queueMicrotask(() => {
				if (!this.viewport.isConnected) {
					this.webviewDismounted = true;
				}
			});
		} else if (this.webviewDismounted && this.webviewLoaded) {
			this.webviewDismounted = false;
			this.webview.reinitializeAfterDismount();
		}
	}

	override clearInput(): void {
		this.loadGeneration++;
		this.currentResource = undefined;
		this.reportUri = undefined;
		this.webviewLoaded = false;
		this.inputDisposables.clear();
		this.updateActionState();
		this.viewport.classList.add('hidden');
		super.clearInput();
	}

	override dispose(): void {
		this.isDisposed = true;
		this.loadGeneration++;
		super.dispose();
	}

	private async load(resource: URI): Promise<void> {
		const generation = ++this.loadGeneration;

		let data: IReportsData | undefined;
		try {
			const content = await this.fileService.readFile(resource);
			data = JSON.parse(content.value.toString()) as IReportsData;
		} catch {
			data = undefined;
		}

		if (generation !== this.loadGeneration || this.isDisposed || this.currentResource?.toString() !== resource.toString()) {
			return;
		}

		const reportName = typeof data?.report === 'string' ? data.report.trim() : '';
		if (!reportName) {
			this.showEmpty();
			return;
		}

		const folder = dirname(resource);
		const candidateUri = joinPath(folder, reportName);
		if (isEqual(candidateUri, folder) || !isEqualOrParent(candidateUri, folder)) {
			this.showEmpty();
			return;
		}

		let html: string;
		try {
			const reportFile = await this.fileService.readFile(candidateUri);
			html = reportFile.value.toString();
		} catch {
			if (generation === this.loadGeneration && !this.isDisposed && this.currentResource?.toString() === resource.toString()) {
				this.showEmpty();
			}
			return;
		}

		if (generation !== this.loadGeneration || this.isDisposed || this.currentResource?.toString() !== resource.toString()) {
			return;
		}

		this.reportUri = candidateUri;
		this.updateActionState();
		this.frame.setEmpty(undefined);
		this.viewport.classList.remove('hidden');
		this.webviewLoaded = true;
		this.webview.setHtml(injectReportCsp(html));

		const formattedTime = formatGeneratedAt(data?.generatedAt);
		if (formattedTime) {
			this.frame.setStatus({
				text: localize('report.statusGeneratedAt', "Report from the run at {0}", formattedTime)
			});
		} else {
			this.frame.setStatus({
				text: localize('report.statusReady', "Report ready")
			});
		}
	}

	private showEmpty(): void {
		this.reportUri = undefined;
		this.webviewLoaded = false;
		this.updateActionState();
		this.viewport.classList.add('hidden');
		this.frame.setEmpty({
			icon: Codicon.fileText,
			title: localize('report.emptyTitle', "No report yet"),
			text: localize('report.emptyText', "A report is written after every solver run."),
			actions: [{
				label: localize('report.openSolver', "Open Solver"),
				primary: true,
				run: () => void this.commandService.executeCommand('maengine.project.openPart6')
			}]
		});
		this.frame.setStatus({
			text: localize('report.emptyStatus', "No report yet"),
			link: {
				label: localize('report.openSolver', "Open Solver"),
				run: () => void this.commandService.executeCommand('maengine.project.openPart6')
			}
		});
	}

	private updateActionState(): void {
		const hasReport = !!this.reportUri;
		this.openInBrowserAction.enabled = hasReport;
		this.revealInFolderAction.enabled = hasReport;
	}

	private async openInBrowser(): Promise<void> {
		if (!this.reportUri) {
			return;
		}
		try {
			await this.openerService.open(this.reportUri, { openExternal: true });
		} catch (err) {
			this.notificationService.error(localize('report.openBrowserError', "Could not open report in browser: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	private async revealInFolder(): Promise<void> {
		if (!this.reportUri) {
			return;
		}
		try {
			await this.commandService.executeCommand('revealFileInOS', this.reportUri);
		} catch (err) {
			this.notificationService.error(localize('report.revealError', "Could not reveal report in folder: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	override layout(dimension: { width: number; height: number }): void {
		this.frame.layout(dimension.width, dimension.height);
	}
}
