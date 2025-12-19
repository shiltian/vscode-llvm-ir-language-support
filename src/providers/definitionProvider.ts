import * as vscode from 'vscode';
import {
    parseDocument,
    getSymbolAtPosition,
    getSymbolKey,
    SymbolKind,
    SymbolDefinition,
} from '../llvmIrParser';

export class LLVMIRDefinitionProvider implements vscode.DefinitionProvider {
    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
        const symbol = getSymbolAtPosition(document, position);
        if (!symbol) {
            return null;
        }

        const parsed = parseDocument(document);
        const definition = this.findDefinition(
            parsed.definitions,
            symbol.kind,
            symbol.name,
            symbol.functionName
        );

        if (!definition) {
            return null;
        }

        return new vscode.Location(document.uri, definition.selectionRange);
    }

    private findDefinition(
        definitions: Map<string, SymbolDefinition>,
        kind: SymbolKind,
        name: string,
        functionName?: string
    ): SymbolDefinition | undefined {
        // For local values and labels, look up with function scope
        if ((kind === SymbolKind.LocalValue || kind === SymbolKind.Label) && functionName) {
            const scopedKey = getSymbolKey(kind, name, functionName);
            const definition = definitions.get(scopedKey);
            if (definition) {
                return definition;
            }
        }

        // Try exact match (for global symbols or fallback)
        let definition = definitions.get(getSymbolKey(kind, name));
        if (definition) {
            return definition;
        }

        // If it's a LocalValue starting with %, try alternatives
        if (kind === SymbolKind.LocalValue && name.startsWith('%')) {
            // Try NamedType (for type references like %struct.Point)
            definition = definitions.get(getSymbolKey(SymbolKind.NamedType, name));
            if (definition) {
                return definition;
            }

            // Try Label (for label references like %for.cond in "br label %for.cond")
            // Labels are defined without % prefix, but scoped to function
            if (functionName) {
                const labelName = name.substring(1); // Remove the % prefix
                definition = definitions.get(getSymbolKey(SymbolKind.Label, labelName, functionName));
                if (definition) {
                    return definition;
                }
            }
        }

        // If it's a GlobalValue, try Function
        if (kind === SymbolKind.GlobalValue) {
            definition = definitions.get(getSymbolKey(SymbolKind.Function, name));
            if (definition) {
                return definition;
            }
        }

        return undefined;
    }
}
