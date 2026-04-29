import * as vscode from 'vscode';
import { getFunctionsAndClasses, grammarByLanguageId, type SymbolWithSource } from './parser';
import { HierarchicalNSW } from 'hnswlib-node';
import * as path from 'path';
import * as crypto from 'crypto';
import { showSimilaritiesView } from './similaritiesView';

const API_KEY="sk-hc-v1-341f2d23e92447f0b20a9fb1cf05773af4a837cc35b144e3b604bd502f141072";

const EMBEDDING_DIM = 1536;
type StoredEmbedding = {
	embedding: number[];
	label: number;
	itemId: string;
};

type EmbeddingResponse = {
	data: Array<{
		embedding: number[];
	}>;
};

type SimilarityMatch = {
	item: SymbolWithSource;
	similarItem: SymbolWithSource;
	similarity: number;
};


async function getEmbeddings(text: string): Promise<number[]> {
	const response = await fetch("https://ai.hackclub.com/proxy/v1/embeddings", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${API_KEY}`
		},
		body: JSON.stringify({
			input: text,
			model: "openai/text-embedding-3-small"
		})
	})
	const data = await response.json() as EmbeddingResponse;
	return data.data[0].embedding;
}

function getEmbeddingsFilePath(context: vscode.ExtensionContext) {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	const workspaceKey = workspaceFolders && workspaceFolders.length > 0
		? workspaceFolders.map((folder) => folder.uri.fsPath).join('|')
		: 'no-workspace';
	const workspaceHash = crypto.createHash('sha256').update(workspaceKey).digest('hex').slice(0, 12);
	return path.join(context.globalStorageUri.fsPath, `embeddings_${workspaceHash}.json`);
}

async function storeEmbeddings(embeddings: StoredEmbedding[], filePath: string) {
	const data = JSON.stringify(embeddings);
	const fileUri = vscode.Uri.file(filePath);
	await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(filePath)));
	await vscode.workspace.fs.writeFile(fileUri, Buffer.from(data, 'utf-8'));
}

async function getEmbeddingsFromFile(filePath: string): Promise<StoredEmbedding[] | null> {
	try {
		const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
		return JSON.parse(Buffer.from(data).toString('utf-8')) as StoredEmbedding[];
	} catch (error) {
		if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
			return null;
		}

		console.error(`Failed to read embeddings from file: ${error}`);
		return null;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('Code Dryer');

	const disposable = vscode.commands.registerCommand('code-dryer.dry', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('Open a file first.');
			return;
		}

		const items = await getFunctionsAndClasses(editor.document);
		outputChannel.clear();
		outputChannel.show(true);

		if (items.length === 0) {
			const unsupportedLanguage = !grammarByLanguageId.has(editor.document.languageId);
			const message = unsupportedLanguage
				? `Tree-sitter is not configured for "${editor.document.languageId}" yet.`
				: 'No classes or functions were found in the active file.';
			vscode.window.showInformationMessage(message);
			outputChannel.appendLine(message);
			return;
		}

		for (const item of items) {
			outputChannel.appendLine(`Name: ${item.name}`);
			outputChannel.appendLine(`Kind: ${vscode.SymbolKind[item.kind]}`);
			outputChannel.appendLine('Source:');
			outputChannel.appendLine(item.source.length > 0 ? item.source: '[No source code available]');
			outputChannel.appendLine('');
		}


		const index = new HierarchicalNSW('cosine', EMBEDDING_DIM);
		index.initIndex(10000);

		const embeddingsFilePath = getEmbeddingsFilePath(context);
		const storedEmbeddings = await getEmbeddingsFromFile(embeddingsFilePath);
		const storedEmbeddingsByItemId = new Map(
			(storedEmbeddings ?? []).map((entry) => [entry.itemId, entry.embedding])
		);
		const embeddings: StoredEmbedding[] = [];

		for (const [idx, item] of items.entries()) {
			let embedding = storedEmbeddingsByItemId.get(item.id);
			if (!embedding) {
				embedding = await getEmbeddings(item.source);
			}

			embeddings.push({ embedding, label: idx, itemId: item.id });
		}
		await storeEmbeddings(embeddings, embeddingsFilePath);

		for (const { embedding, label } of embeddings) {
			index.addPoint(embedding, label);
		}
		
		const similarities: SimilarityMatch[] = [];

		for(const item of items) {
			const embedding = embeddings.find((entry) => entry.itemId === item.id)?.embedding;
			if (!embedding) continue;
			const searchResult = index.searchKnn(embedding, 2);
			if (searchResult.neighbors.length > 1) {
				if(!similarities.find((entry) => entry.similarItem.id === item.id)){
					outputChannel.appendLine(`Top similar symbol to ${item.name} (other than itself):`);
					similarities.push({
					item,
					similarItem: items[searchResult.neighbors[1]],
					similarity: 1 - searchResult.distances[1]
				});
					const similarItem = items[searchResult.neighbors[1]];
					outputChannel.appendLine(`- ${similarItem.name} (Similarity: ${(1 - searchResult.distances[1]).toFixed(4)})`);
				}	
			}
			outputChannel.appendLine('');
		}
		
		vscode.window.showInformationMessage(`Found ${similarities.length} class/function symbol(s) that are similar to others.`);
		showSimilaritiesView(context, editor.document, similarities);
	
	});

	context.subscriptions.push(disposable, outputChannel);
}

export function deactivate() {}
