import * as vscode from 'vscode';
import type { SymbolWithSource } from './parser';

type SimilarityMatch = {
	item: SymbolWithSource;
	similarItem: SymbolWithSource;
	similarity: number;
};

let similaritiesPanel: vscode.WebviewPanel | undefined;

const formatLineNumber = (value: number) => `${value + 1}`;

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

const createSymbolButton = (symbol: SymbolWithSource, role: string) => {
	const startLine = formatLineNumber(symbol.range.start.line);
	const endLine = formatLineNumber(symbol.range.end.line);
	return `
		<button
			class="symbol-button"
			data-role="${escapeHtml(role)}"
			data-uri="${escapeHtml(symbol.uri.toString())}"
			data-start-line="${symbol.range.start.line}"
			data-start-character="${symbol.range.start.character}"
			data-end-line="${symbol.range.end.line}"
			data-end-character="${symbol.range.end.character}"
		>
			<span class="symbol-name">${escapeHtml(symbol.name)}</span>
			<span class="symbol-range">${escapeHtml(vscode.workspace.asRelativePath(symbol.uri))}</span>
			<span class="symbol-range">Lines ${startLine}-${endLine}</span>
			<span class="symbol-snippet"><code>${escapeHtml(symbol.rawSource.length > 0 ? symbol.rawSource : '[No source code available]')}</code></span>
		</button>
	`;
};

const getWebviewHtml = (webview: vscode.Webview, document: vscode.TextDocument, similarities: SimilarityMatch[]) => {
	const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
	const cardsHtml = similarities.length === 0
		? `<div class="empty-state" data-empty-all>No similar symbols were found in ${escapeHtml(document.fileName)}.</div>`
		: similarities.map((entry) => `
			<section class="card" data-similarity-percent="${(entry.similarity * 100).toFixed(1)}">
				<div class="score">${(entry.similarity * 100).toFixed(1)}%</div>
				<div class="pairing">
					<div>
						<div class="label">Symbol</div>
						${createSymbolButton(entry.item, 'source')}
					</div>
				</div>
				<div class="pairing">
					<div class="label">Most similar to</div>
					${createSymbolButton(entry.similarItem, 'match')}
				</div>
			</section>
		`).join('');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
	/>
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Similarities</title>
	<style>
		:root {
			color-scheme: light dark;
		}

		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-editor-foreground);
			background: var(--vscode-editor-background);
			margin: 0;
			padding: 20px;
		}

		main {
			max-width: 860px;
			margin: 0 auto;
		}

		h1 {
			font-size: 1.1rem;
			font-weight: 600;
			margin: 0 0 6px;
		}

		.subtitle {
			color: var(--vscode-descriptionForeground);
			margin: 0 0 18px;
		}

		.toolbar {
			display: grid;
			gap: 8px;
			margin: 0 0 18px;
			padding: 14px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px;
			background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editor-selectionBackground));
		}

		.toolbar-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
		}

		.toolbar-title {
			font-weight: 600;
		}

		.threshold-value,
		.results-count {
			color: var(--vscode-descriptionForeground);
			font-size: 0.9rem;
		}

		.threshold-slider {
			width: 100%;
		}

		.results {
			display: grid;
			gap: 12px;
		}

		.card {
			position: relative;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px;
			padding: 14px;
			background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-editor-selectionBackground));
		}

		.pairing + .pairing {
			margin-top: 14px;
		}

		.label {
			font-size: 0.8rem;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 6px;
		}

		.score {
			position: absolute;
			top: 14px;
			right: 14px;
			font-size: 0.95rem;
			font-weight: 600;
			white-space: nowrap;
		}

		.symbol-button {
			width: 100%;
			border: 1px solid var(--vscode-button-border, transparent);
			border-radius: 6px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			padding: 10px 12px;
			text-align: left;
			cursor: pointer;
		}

		.symbol-button:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		.symbol-name,
		.symbol-range {
			display: block;
		}

		.symbol-name {
			font-weight: 600;
			margin-bottom: 4px;
		}

		.symbol-range {
			font-size: 0.8rem;
			color: var(--vscode-descriptionForeground);
		}

		.symbol-snippet {
			display: block;
			margin: 8px 0 0;
			padding: 10px 12px;
			border-radius: 6px;
			overflow-x: auto;
			border: 1px solid var(--vscode-panel-border);
			background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
			line-height: 1.45;
			white-space: pre-wrap;
		}

		.pairing:first-of-type .label {
			padding-right: 84px;
		}

		.empty-state {
			border: 1px dashed var(--vscode-panel-border);
			border-radius: 8px;
			padding: 18px;
			color: var(--vscode-descriptionForeground);
		}
	</style>
</head>
<body>
	<main>
		<h1>Similarity Results</h1>
		<p class="subtitle">${escapeHtml(document.fileName)}</p>
		<section class="toolbar">
			<div class="toolbar-header">
				<div class="toolbar-title">Minimum similarity</div>
				<div id="threshold-value" class="threshold-value">75%</div>
			</div>
			<input id="threshold-slider" class="threshold-slider" type="range" min="0" max="100" step="5" value="75" />
			<div id="results-count" class="results-count"></div>
		</section>
		<div id="results" class="results"></div>
	</main>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const thresholdSlider = document.getElementById('threshold-slider');
		const thresholdValue = document.getElementById('threshold-value');
		const resultsCount = document.getElementById('results-count');
		const results = document.getElementById('results');
		results.innerHTML = ${JSON.stringify(cardsHtml)};

		const bindRevealHandlers = () => {
			for (const button of document.querySelectorAll('.symbol-button')) {
				button.addEventListener('click', () => {
					vscode.postMessage({
						type: 'revealRange',
						uri: button.dataset.uri,
						startLine: Number(button.dataset.startLine),
						startCharacter: Number(button.dataset.startCharacter),
						endLine: Number(button.dataset.endLine),
						endCharacter: Number(button.dataset.endCharacter)
					});
				});
			}
		};

		const render = () => {
			const threshold = Number(thresholdSlider.value);
			thresholdValue.textContent = \`\${threshold}%\`;
			const cards = Array.from(results.querySelectorAll('[data-similarity-percent]'));
			let visibleCount = 0;

			for (const card of cards) {
				const similarityPercent = Number(card.getAttribute('data-similarity-percent'));
				const isVisible = similarityPercent >= threshold;
				card.hidden = !isVisible;
				if (isVisible) {
					visibleCount += 1;
				}
			}

			const emptyAll = results.querySelector('[data-empty-all]');
			if (emptyAll) {
				resultsCount.textContent = '0 match(es) available';
				return;
			}

			let thresholdEmpty = results.querySelector('[data-empty-threshold]');
			if (!thresholdEmpty) {
				thresholdEmpty = document.createElement('div');
				thresholdEmpty.className = 'empty-state';
				thresholdEmpty.setAttribute('data-empty-threshold', 'true');
				thresholdEmpty.textContent = 'No similarity matches meet the current threshold.';
				results.appendChild(thresholdEmpty);
			}

			thresholdEmpty.hidden = visibleCount > 0;
			resultsCount.textContent = \`\${visibleCount} of \${cards.length} match(es) shown\`;
		};

		bindRevealHandlers();
		thresholdSlider.addEventListener('input', render);
		render();
	</script>
</body>
</html>`;
};

export function showSimilaritiesView(
	context: vscode.ExtensionContext,
	document: vscode.TextDocument,
	similarities: SimilarityMatch[]
) {
	if (!similaritiesPanel) {
		similaritiesPanel = vscode.window.createWebviewPanel(
			'codeDryerSimilarities',
			'Similarities',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		similaritiesPanel.onDidDispose(() => {
			similaritiesPanel = undefined;
		}, null, context.subscriptions);

		similaritiesPanel.webview.onDidReceiveMessage(async (message) => {
			if (message.type !== 'revealRange') {
				return;
			}

			const documentUri = vscode.Uri.parse(message.uri);
			const range = new vscode.Range(
				new vscode.Position(message.startLine, message.startCharacter),
				new vscode.Position(message.endLine, message.endCharacter)
			);
			const targetDocument = await vscode.workspace.openTextDocument(documentUri);
			const editor = await vscode.window.showTextDocument(targetDocument, {
				viewColumn: vscode.ViewColumn.One,
				preserveFocus: true,
			});
			editor.selection = new vscode.Selection(range.start, range.end);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		}, null, context.subscriptions);
	}

	similaritiesPanel.title = `Similarities: ${vscode.workspace.asRelativePath(document.uri)}`;
	similaritiesPanel.webview.html = getWebviewHtml(similaritiesPanel.webview, document, similarities);
	similaritiesPanel.reveal(vscode.ViewColumn.Beside, true);
}
