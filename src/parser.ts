import * as vscode from 'vscode';
import Parser = require('tree-sitter');
import JavaScript = require('tree-sitter-javascript');
import Python = require('tree-sitter-python');
import TypeScript = require('tree-sitter-typescript');
const crypto = require('crypto');

type TreeSitterLanguage = {
	name: string;
	language: unknown;
};

const parserByLanguage = new Map<string, Parser>();
export const grammarByLanguageId = new Map<string, TreeSitterLanguage>([
	['javascript', JavaScript],
	['javascriptreact', JavaScript],
	['python', Python],
	['typescript', TypeScript.typescript],
	['typescriptreact', TypeScript.tsx],
]);

const supportedNodeTypes = new Set([
	'class_declaration',
	'class_definition',
	'function_declaration',
	'function_definition',
	'generator_function_declaration',
	'method_definition',
]);

const parameterNodeTypes = new Set([
	'default_parameter',
	'formal_parameters',
	'list_pattern',
	'list_splat_pattern',
	'parameters',
	'pattern_list',
	'positional_separator',
	'required_parameter',
	'optional_parameter',
	'rest_pattern',
	'assignment_pattern',
	'object_pattern',
	'array_pattern',
	'tuple_pattern',
	'typed_default_parameter',
	'typed_parameter',
]);

const toRange = (node: Parser.SyntaxNode) => {
	return new vscode.Range(
		new vscode.Position(node.startPosition.row, node.startPosition.column),
		new vscode.Position(node.endPosition.row, node.endPosition.column)
	);
};

export type SymbolWithSource = {
	id: string;
	uri: vscode.Uri;
	name: string;
	kind: vscode.SymbolKind;
	range: vscode.Range;
	selectionRange: vscode.Range;
	rawSource: string;
	source: string;
};

const getParserForDocument = (document: vscode.TextDocument) => {
	const grammar = grammarByLanguageId.get(document.languageId);
	if (!grammar) {
		return null;
	}

	let parser = parserByLanguage.get(document.languageId);
	if (!parser) {
		parser = new Parser();
		parser.setLanguage(grammar);
		parserByLanguage.set(document.languageId, parser);
	}

	return parser;
};

const getDeclarationName = (node: Parser.SyntaxNode) => {
	const nameNode = node.childForFieldName('name');
	return nameNode?.text ?? '[anonymous]';
};

const getSymbolKind = (node: Parser.SyntaxNode) => {
	if (node.type === 'class_declaration' || node.type === 'class_definition') {
		return vscode.SymbolKind.Class;
	}

	if (node.type === 'method_definition') {
		return vscode.SymbolKind.Method;
	}

	return vscode.SymbolKind.Function;
};

const collectIdentifierNodes = (
	node: Parser.SyntaxNode,
	collected: Parser.SyntaxNode[],
	excludedNodes: Set<Parser.SyntaxNode> = new Set()
) => {
	if (
		excludedNodes.has(node) ||
		node.type === 'type' ||
		node.type === 'type_annotation'
	) {
		return;
	}

	if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
		collected.push(node);
	}

	for (const child of node.namedChildren) {
		collectIdentifierNodes(child, collected, excludedNodes);
	}
};

const stripComments = (node: Parser.SyntaxNode, source: string) => {
	const commentEdits = node
		.descendantsOfType('comment')
		.map((commentNode) => ({
			start: commentNode.startIndex - node.startIndex,
			end: commentNode.endIndex - node.startIndex,
			text: source
				.slice(commentNode.startIndex - node.startIndex, commentNode.endIndex - node.startIndex)
				.replace(/[^\r\n]/g, ' '),
		}))
		.sort((left, right) => right.start - left.start);

	let nextSource = source;
	for (const edit of commentEdits) {
		nextSource = `${nextSource.slice(0, edit.start)}${edit.text}${nextSource.slice(edit.end)}`;
	}

	return nextSource;
};

const normalizeCode = (node: Parser.SyntaxNode, source: string) => {
	type SourceEdit = {
		start: number;
		end: number;
		text: string;
	};

	const abstractifyVariableNames = (node: Parser.SyntaxNode) => {
		const replacements = new Map<string, string>();
		let counter = 1;
	
		const registerNode = (identifierNode: Parser.SyntaxNode) => {
			const identifier = identifierNode.text;
			if (!replacements.has(identifier)) {
				replacements.set(identifier, `var${counter}`);
				counter += 1;
			}
		};
		for (const descendant of node.descendantsOfType([
			'assignment',
			'variable_declarator',
			'catch_clause',
			...parameterNodeTypes,
		])) {
			if (descendant.type === 'variable_declarator') {
				const nameNode = descendant.childForFieldName('name');
				if (!nameNode) {
					continue;
				}

				const identifiers: Parser.SyntaxNode[] = [];
				collectIdentifierNodes(nameNode, identifiers);
				for (const identifierNode of identifiers) {
					registerNode(identifierNode);
				}
				continue;
			}

			if (descendant.type === 'assignment') {
				const leftNode = descendant.childForFieldName('left');
				if (!leftNode) {
					continue;
				}

				const identifiers: Parser.SyntaxNode[] = [];
				collectIdentifierNodes(leftNode, identifiers);
				for (const identifierNode of identifiers) {
					registerNode(identifierNode);
				}
				continue;
			}

			if (descendant.type === 'catch_clause') {
				const parameterNode = descendant.childForFieldName('parameter');
				if (!parameterNode) {
					continue;
				}

				const identifiers: Parser.SyntaxNode[] = [];
				collectIdentifierNodes(parameterNode, identifiers);
				for (const identifierNode of identifiers) {
					registerNode(identifierNode);
				}
				continue;
			}

			const identifiers: Parser.SyntaxNode[] = [];
			const excludedNodes = new Set<Parser.SyntaxNode>();
			for (const fieldName of ['type', 'value', 'right']) {
				const excludedNode = descendant.childForFieldName(fieldName);
				if (excludedNode) {
					excludedNodes.add(excludedNode);
				}
			}

			collectIdentifierNodes(descendant, identifiers, excludedNodes);
			for (const identifierNode of identifiers) {
				registerNode(identifierNode);
			}
		}

		const identifierNodes = node.descendantsOfType([
			'identifier',
			'shorthand_property_identifier',
			'shorthand_property_identifier_pattern',
		]);

		return identifierNodes
			.filter((identifierNode) => replacements.has(identifierNode.text))
			.map((identifierNode): SourceEdit => ({
				start: identifierNode.startIndex - node.startIndex,
				end: identifierNode.endIndex - node.startIndex,
				text: replacements.get(identifierNode.text)!,
			}));
	};

	const collectLiteralNormalizationEdits = (node: Parser.SyntaxNode) => {
		const replacementsByType = new Map<string, string>([
			// JS / TS
			['string', '"STR"'],
			['template_string', '"STR"'],
			['number', '0'],
			['array', '[]'],
			['object', '{}'],

			// Python
			['concatenated_string', '"STR"'],
			['integer', '0'],
			['float', '0'],
			['none', 'None'],
			['list', '[]'],
			['tuple', '()'],
			['dictionary', '{}'],
			['set', 'set()'],
		]);

		const replaceableTypes = Array.from(replacementsByType.keys());
		const replaceableTypeSet = new Set(replaceableTypes);

		const hasReplaceableAncestor = (literalNode: Parser.SyntaxNode) => {
			let current = literalNode.parent;
			while (current && current !== node) {
				if (replaceableTypeSet.has(current.type)) {
					return true;
				}
				current = current.parent;
			}
			return false;
		};

		return node
			.descendantsOfType(replaceableTypes)
			.filter((literalNode) => !hasReplaceableAncestor(literalNode))
			.map((literalNode): SourceEdit => ({
				start: literalNode.startIndex - node.startIndex,
				end: literalNode.endIndex - node.startIndex,
				text: replacementsByType.get(literalNode.type)!,
			}));
	};

	const editsOverlap = (left: SourceEdit, right: SourceEdit) => {
		return left.start < right.end && right.start < left.end;
	};

	const literalEdits = collectLiteralNormalizationEdits(node);
	const variableEdits = abstractifyVariableNames(node).filter((variableEdit) => {
		return !literalEdits.some((literalEdit) => editsOverlap(variableEdit, literalEdit));
	});

	const edits = [
		...variableEdits,
		...literalEdits,
	].sort((left, right) => right.start - left.start);


	let nextSource = source;
	for (const edit of edits) {
		nextSource = `${nextSource.slice(0, edit.start)}${edit.text}${nextSource.slice(edit.end)}`;
	}

	return nextSource;
};

export function getFunctionsAndClasses(document: vscode.TextDocument): SymbolWithSource[] {
	const parser = getParserForDocument(document);
	if (!parser) {
		return [];
	}

	const source = document.getText();
	const tree = parser.parse(source);
	const declarationNodes = tree.rootNode
		.descendantsOfType(Array.from(supportedNodeTypes))
		.sort((left, right) => left.startIndex - right.startIndex);

	return declarationNodes.map((node) => {
		const selectionNode = node.childForFieldName('name') ?? node;
		const nodeSource = source.slice(node.startIndex, node.endIndex);
		const range = toRange(node);
		const sourceHash = crypto.createHash('sha256').update(nodeSource).digest('hex'); 
		const id = `${document.uri.fsPath}:${sourceHash}`;
		return {
			id,
			uri: document.uri,
			name: getDeclarationName(node),
			kind: getSymbolKind(node),
			range,
			selectionRange: toRange(selectionNode),
			source: normalizeCode(node, stripComments(node, nodeSource)),
			rawSource: nodeSource,
		};
	});
}

export type TopLevelCodeChunk = SymbolWithSource & {
	nodes: Parser.SyntaxNode[];
};

const hasLargeBlankGap = (
	source: string,
	prev: Parser.SyntaxNode,
	next: Parser.SyntaxNode
) => {
	const between = source.slice(prev.endIndex, next.startIndex);
	return /\r?\n(\r?\n)+/.test(between);
};


export function getTopLevelCodeChunks(document: vscode.TextDocument): TopLevelCodeChunk[] {
	const parser = getParserForDocument(document);
	if (!parser) {
		return [];
	}

	const source = document.getText();
	const tree = parser.parse(source);
	const topLevelNodes = tree.rootNode.namedChildren;

	const chunks: Parser.SyntaxNode[][] = [];
	let currentChunk: Parser.SyntaxNode[] = [];

	const flush = () => {
		if (currentChunk.length > 0) {
			chunks.push(currentChunk);
			currentChunk = [];
		}
	};

	for (const node of topLevelNodes) {
		if (supportedNodeTypes.has(node.type)) {
			flush();
			continue;
		}

		const prevNode = currentChunk[currentChunk.length - 1];
		if (prevNode && hasLargeBlankGap(source, prevNode, node)) {
			flush();
		}

		currentChunk.push(node);
	}

	flush();

	return chunks.map((nodes) => {
		const first = nodes[0];
		const last = nodes[nodes.length - 1];
		const chunkNodeText = source.slice(first.startIndex, last.endIndex);
		const range = new vscode.Range(
			new vscode.Position(first.startPosition.row, first.startPosition.column),
			new vscode.Position(last.endPosition.row, last.endPosition.column)
		);
		const sourceHash = crypto.createHash('sha256').update(chunkNodeText).digest('hex');
		const id = `${document.uri.fsPath}:${sourceHash}`;
		return {
			id,
			uri: document.uri,
			name: `[top-level ${first.startPosition.row + 1}-${last.endPosition.row + 1}]`,
			kind: vscode.SymbolKind.Namespace,
			range,
			selectionRange: range,
			source: chunkNodeText,
			rawSource: chunkNodeText,
			nodes,
		};
	});
}
