import * as vscode from 'vscode';
import {
    getReferencesForSymbol,
    getSymbolAndParsedDocument,
    resolveSymbol,
} from '../llvmIrParser';

export class LLVMIRReferenceProvider implements vscode.ReferenceProvider {
    provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Location[]> {
        const result = getSymbolAndParsedDocument(document, position, token);
        if (!result) {
            return null;
        }

        const { parsed, symbol } = result;
        const locations: vscode.Location[] = [];

        // Determine actual symbol info (might be a label referenced as %name)
        const resolved = resolveSymbol(parsed, symbol);
        const { definition } = resolved;

        // Include definition if requested
        if (context.includeDeclaration && definition) {
            locations.push(new vscode.Location(document.uri, definition.selectionRange));
        }

        for (const ref of getReferencesForSymbol(parsed, symbol, resolved)) {
            if (token.isCancellationRequested) {
                return null;
            }
            if (definition && ref.range.isEqual(definition.selectionRange)) {
                continue;
            }
            locations.push(new vscode.Location(document.uri, ref.range));
        }

        return locations;
    }
}
