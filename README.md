# Code Dryer

Finds similar code in selected files with semantic embeddings, so you can refactor and DRY up your codebase.

## Use

1. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Run `Code Dryer: Dry`
3. Select files
4. See similarity results
 
## About

Code Dryer extracts functions, classes, and top-level code chunks from the files you select, computes embeddings for each chunk, and finds nearest neighbor matches so you can refactor them and **stay DRY**.

## Features

- Extracts symbols and top-level code chunks
- Computes and caches embeddings per workspace
- Performs cosine nearest neighbor search for similarity
- Shows results in a simple similarities view

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Press `F5` to open the Extension Development Host, then run the `Code Dryer: Dry` command and select files.

## How it is helpful
In a large codebase, it isn't always easy to find similar code sections that could be refactored. With Code Dryer, you can quickly identify these sections and DRY up your code.


## Notes
- Embeddings are stored in the extension global storage (per workspace).
