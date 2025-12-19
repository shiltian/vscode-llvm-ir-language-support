import * as vscode from 'vscode';
import {
    parseDocument,
    getSymbolAtPosition,
    getSymbolKey,
    SymbolKind,
    SymbolDefinition,
} from '../llvmIrParser';

export class LLVMIRReferenceProvider implements vscode.ReferenceProvider {
    provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Location[]> {
        const symbol = getSymbolAtPosition(document, position);
        if (!symbol) {
            return null;
        }

        const parsed = parseDocument(document);
        const locations: vscode.Location[] = [];

        // Determine actual symbol info (might be a label referenced as %name)
        const { definition, actualName, actualKind } = this.resolveSymbol(
            parsed.definitions,
            symbol.kind,
            symbol.name,
            symbol.functionName
        );

        // Include definition if requested
        if (context.includeDeclaration && definition) {
            locations.push(new vscode.Location(document.uri, definition.selectionRange));
        }

        // Find all references
        for (const ref of parsed.references) {
            // For function-scoped symbols, only match references in the same function
            if (actualKind === SymbolKind.LocalValue || actualKind === SymbolKind.Label) {
                if (ref.functionName !== symbol.functionName) {
                    continue;
                }
            }

            // Match by the reference name
            if (ref.name === symbol.name && ref.kind === symbol.kind) {
                // Check if this is the same location as the definition
                if (definition && ref.range.isEqual(definition.selectionRange)) {
                    continue; // Skip, already added
                }
                locations.push(new vscode.Location(document.uri, ref.range));
            }

            // Also check if this is a label reference stored with % but we're looking at definition without %
            if (actualKind === SymbolKind.Label && ref.kind === SymbolKind.LocalValue) {
                if (ref.functionName !== symbol.functionName) {
                    continue;
                }
                const refWithoutPercent = ref.name.startsWith('%') ? ref.name.substring(1) : ref.name;
                if (refWithoutPercent === actualName) {
                    if (definition && ref.range.isEqual(definition.selectionRange)) {
                        continue;
                    }
                    locations.push(new vscode.Location(document.uri, ref.range));
                }
            }
        }

        return locations;
    }

    private resolveSymbol(
        definitions: Map<string, SymbolDefinition>,
        kind: SymbolKind,
        name: string,
        functionName?: string
    ): { definition?: SymbolDefinition; actualName: string; actualKind: SymbolKind } {
        // For local values and labels, look up with function scope
        if ((kind === SymbolKind.LocalValue || kind === SymbolKind.Label) && functionName) {
            const scopedKey = getSymbolKey(kind, name, functionName);
            const definition = definitions.get(scopedKey);
            if (definition) {
                return { definition, actualName: name, actualKind: kind };
            }
        }

        // Try exact match first
        let definition = definitions.get(getSymbolKey(kind, name));
        if (definition) {
            return { definition, actualName: name, actualKind: kind };
        }

        // If it's a LocalValue starting with %, try alternatives
        if (kind === SymbolKind.LocalValue && name.startsWith('%')) {
            // Try NamedType
            definition = definitions.get(getSymbolKey(SymbolKind.NamedType, name));
            if (definition) {
                return { definition, actualName: name, actualKind: SymbolKind.NamedType };
            }

            // Try Label (labels are defined without % prefix)
            if (functionName) {
                const labelName = name.substring(1);
                definition = definitions.get(getSymbolKey(SymbolKind.Label, labelName, functionName));
                if (definition) {
                    return { definition, actualName: labelName, actualKind: SymbolKind.Label };
                }
            }
        }

        // If it's a GlobalValue, try Function
        if (kind === SymbolKind.GlobalValue) {
            definition = definitions.get(getSymbolKey(SymbolKind.Function, name));
            if (definition) {
                return { definition, actualName: name, actualKind: SymbolKind.Function };
            }
        }

        return { definition: undefined, actualName: name, actualKind: kind };
    }
}
