import * as vscode from 'vscode';
import {
    getSymbolAndParsedDocument,
    resolveSymbol,
} from '../llvmIrParser';

export class LLVMIRDefinitionProvider implements vscode.DefinitionProvider {
    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
        const result = getSymbolAndParsedDocument(document, position, token);
        if (!result) {
            return null;
        }

        const { definition } = resolveSymbol(result.parsed, result.symbol);

        if (!definition) {
            return null;
        }

        return new vscode.Location(document.uri, definition.selectionRange);
    }
}
