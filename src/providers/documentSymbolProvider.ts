import * as vscode from 'vscode';
import {
    parseDocument,
    toVSCodeSymbolKind,
    SymbolKind,
    SymbolDefinition,
} from '../llvmIrParser';

export class LLVMIRDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    provideDocumentSymbols(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.SymbolInformation[] | vscode.DocumentSymbol[]> {
        const parsed = parseDocument(document);
        const symbols: vscode.DocumentSymbol[] = [];

        // Group symbols by kind for better organization
        const functions: SymbolDefinition[] = [];
        const globals: SymbolDefinition[] = [];
        const types: SymbolDefinition[] = [];
        const metadata: SymbolDefinition[] = [];
        const attributes: SymbolDefinition[] = [];

        for (const [key, def] of parsed.definitions) {
            switch (def.kind) {
                case SymbolKind.Function:
                    functions.push(def);
                    break;
                case SymbolKind.GlobalValue:
                    // Skip if it's also registered as a function
                    if (!parsed.definitions.has(key.replace('GlobalValue', 'Function'))) {
                        globals.push(def);
                    }
                    break;
                case SymbolKind.NamedType:
                    types.push(def);
                    break;
                case SymbolKind.Metadata:
                    // Only include named metadata, not numbered
                    if (!def.name.match(/^![0-9]+$/)) {
                        metadata.push(def);
                    }
                    break;
                case SymbolKind.AttributeGroup:
                    attributes.push(def);
                    break;
                // Skip local values and labels for document outline
            }
        }

        // Add functions
        for (const func of functions) {
            const symbol = new vscode.DocumentSymbol(
                func.name,
                func.detail?.substring(0, 50) || '',
                vscode.SymbolKind.Function,
                func.range,
                func.selectionRange
            );
            symbols.push(symbol);
        }

        // Add global variables
        for (const global of globals) {
            const symbol = new vscode.DocumentSymbol(
                global.name,
                'global',
                vscode.SymbolKind.Variable,
                global.range,
                global.selectionRange
            );
            symbols.push(symbol);
        }

        // Add types
        for (const type of types) {
            const symbol = new vscode.DocumentSymbol(
                type.name,
                'type',
                vscode.SymbolKind.Struct,
                type.range,
                type.selectionRange
            );
            symbols.push(symbol);
        }

        // Add metadata
        for (const meta of metadata) {
            const symbol = new vscode.DocumentSymbol(
                meta.name,
                'metadata',
                vscode.SymbolKind.Property,
                meta.range,
                meta.selectionRange
            );
            symbols.push(symbol);
        }

        // Add attribute groups
        for (const attr of attributes) {
            const symbol = new vscode.DocumentSymbol(
                attr.name,
                'attributes',
                vscode.SymbolKind.Constant,
                attr.range,
                attr.selectionRange
            );
            symbols.push(symbol);
        }

        return symbols;
    }
}

