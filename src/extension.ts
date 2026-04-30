import * as vscode from 'vscode';
import { getFunctionsAndClasses, getTopLevelCodeChunks, grammarByLanguageId, type SymbolWithSource } from './parser';
import { HierarchicalNSW } from 'hnswlib-node';
import * as path from 'path';
import * as crypto from 'crypto';
import { showSimilaritiesView } from './similaritiesView';

const EMBEDDINGS_API_URL = "https://code-dryer-production-1fmg2m6a.up.railway.app/embeddings";

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
	const response = await fetch(EMBEDDINGS_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			input: text,
			model: "openai/text-embedding-3-small"
		})
	});

	if (!response.ok) {
		throw new Error(`Embeddings request failed with status ${response.status}`);
	}

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

async function pickWorkspaceFiles(): Promise<vscode.Uri[] | undefined> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		vscode.window.showErrorMessage('Open a workspace first.');
		return;
	}

	const fileUris = await vscode.workspace.findFiles(
		'**/*',
		'**/{.git,node_modules,out,dist,coverage}/**'
	);

	if (fileUris.length === 0) {
		vscode.window.showInformationMessage('No workspace files were found to analyze.');
		return;
	}

	const selectedItems = await vscode.window.showQuickPick(
		fileUris.map((uri) => ({
			label: vscode.workspace.asRelativePath(uri),
			description: workspaceFolders.find((folder) => folder.uri.toString() === vscode.workspace.getWorkspaceFolder(uri)?.uri.toString())?.name,
			uri,
		})),
		{
			canPickMany: true,
			ignoreFocusOut: true,
			matchOnDescription: true,
			matchOnDetail: true,
			placeHolder: 'Select workspace files to analyze',
			title: 'Code Dryer',
		}
	);

	return selectedItems?.map((item) => item.uri);
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('Code Dryer');

	const disposable = vscode.commands.registerCommand('code-dryer.dry', async () => {
		const selectedUris = await pickWorkspaceFiles();
		if (!selectedUris || selectedUris.length === 0) {
			return;
		}

		const documents = await Promise.all(
			selectedUris.map((uri) => vscode.workspace.openTextDocument(uri))
		);
		const allItems: SymbolWithSource[] = [];
		let totalSymbols = 0;
		let totalTopLevelChunks = 0;

		for (const document of documents) {
			const symbols = getFunctionsAndClasses(document);
			const topLevelChunks = getTopLevelCodeChunks(document);
			totalSymbols += symbols.length;
			totalTopLevelChunks += topLevelChunks.length;
			allItems.push(...symbols, ...topLevelChunks);
		}

		outputChannel.clear();
		outputChannel.show(true);

		outputChannel.appendLine(`Selected ${documents.length} file(s).`);
		outputChannel.appendLine(`Identified ${totalSymbols} class/function symbol(s) and ${totalTopLevelChunks} top-level code chunk(s) across the selected files.`);
		outputChannel.appendLine(''); 

		if (allItems.length === 0) {
			const unsupportedLanguages = [...new Set(
				documents
					.map((document) => document.languageId)
					.filter((languageId) => !grammarByLanguageId.has(languageId))
			)];
			const message = unsupportedLanguages.length > 0
				? `Tree-sitter is not configured for: ${unsupportedLanguages.join(', ')}.`
				: 'No classes, functions, or top-level code chunks were found in the selected files.';
			vscode.window.showInformationMessage(message);
			outputChannel.appendLine(message);
			return;
		}

		for (const item of allItems) {
			outputChannel.appendLine(`Name: ${item.name}`);
			outputChannel.appendLine(`Kind: ${vscode.SymbolKind[item.kind]}`);
			outputChannel.appendLine('Source:');
			outputChannel.appendLine(item.source.length > 0 ? item.source : '[No source code available]');
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

		for (const [idx, item] of allItems.entries()) {
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

		for(const item of allItems) {
			const embedding = embeddings.find((entry) => entry.itemId === item.id)?.embedding;
			if (!embedding) continue;
			const searchResult = index.searchKnn(embedding, 2);
			if (searchResult.neighbors.length > 1) {
				if(!similarities.find((entry) => entry.similarItem.id === item.id)){
					outputChannel.appendLine(`Top similar symbol to ${item.name} (other than itself):`);
					const similarItem = allItems[searchResult.neighbors[1]];
					if (!similarItem) {
						continue;
					}
					similarities.push({
						item,
						similarItem,
						similarity: 1 - searchResult.distances[1]
					});
					outputChannel.appendLine(`- ${similarItem.name} (Similarity: ${(1 - searchResult.distances[1]).toFixed(4)})`);
				}	
			}
			outputChannel.appendLine('');
		}

		// Filter out pairs with very low similarity
		const similarityThreshold = 0.75;
		const filteredSimilarities = similarities.filter((entry) => entry.similarity >= similarityThreshold);
		
		vscode.window.showInformationMessage(`Found ${filteredSimilarities.length} code section(s) that are similar to others.`);
		showSimilaritiesView(context, documents[0], filteredSimilarities);
	
	});

	context.subscriptions.push(disposable, outputChannel);
}

export function deactivate() {}
