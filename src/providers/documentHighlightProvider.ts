import * as vscode from 'vscode';
import {
    getReferencesForSymbol,
    getSymbolAndParsedDocument,
    resolveSymbol,
} from '../llvmIrParser';

export class LLVMIRDocumentHighlightProvider implements vscode.DocumentHighlightProvider {
    provideDocumentHighlights(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DocumentHighlight[]> {
        const result = getSymbolAndParsedDocument(document, position, token);
        if (!result) {
            return null;
        }

        const { parsed, symbol } = result;
        const highlights: vscode.DocumentHighlight[] = [];

        // Resolve the symbol (handles label %name -> name relationship)
        const resolved = resolveSymbol(parsed, symbol);
        const { definition } = resolved;

        // Add definition highlight (as Write kind to distinguish from reads)
        if (definition) {
            highlights.push(new vscode.DocumentHighlight(
                definition.selectionRange,
                vscode.DocumentHighlightKind.Write
            ));
        }

        for (const ref of getReferencesForSymbol(parsed, symbol, resolved)) {
            if (token.isCancellationRequested) {
                return null;
            }
            if (definition && ref.range.isEqual(definition.selectionRange)) {
                continue;
            }

            highlights.push(new vscode.DocumentHighlight(
                ref.range,
                vscode.DocumentHighlightKind.Read
            ));
        }

        return highlights.length > 0 ? highlights : null;
    }
}

