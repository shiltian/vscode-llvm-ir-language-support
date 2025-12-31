import * as vscode from 'vscode';
import {
    parseDocument,
    getSymbolAtPosition,
    getSymbolKey,
    SymbolKind,
    SymbolDefinition,
} from '../llvmIrParser';

export class LLVMIRDocumentHighlightProvider implements vscode.DocumentHighlightProvider {
    provideDocumentHighlights(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DocumentHighlight[]> {
        const symbol = getSymbolAtPosition(document, position);
        if (!symbol) {
            return null;
        }

        const parsed = parseDocument(document);
        const highlights: vscode.DocumentHighlight[] = [];

        // Resolve the symbol (handles label %name -> name relationship)
        const { definition, actualName, actualKind } = this.resolveSymbol(
            parsed.definitions,
            symbol.kind,
            symbol.name,
            symbol.functionName
        );

        // Add definition highlight (as Write kind to distinguish from reads)
        if (definition) {
            highlights.push(new vscode.DocumentHighlight(
                definition.selectionRange,
                vscode.DocumentHighlightKind.Write
            ));
        }

        // Find all references
        for (const ref of parsed.references) {
            // For function-scoped symbols, only match references in the same function
            if (actualKind === SymbolKind.LocalValue || actualKind === SymbolKind.Label) {
                if (ref.functionName !== symbol.functionName) {
                    continue;
                }
            }

            // Skip if this is the same location as the definition
            if (definition && ref.range.isEqual(definition.selectionRange)) {
                continue;
            }

            // Match by the reference name (exact match)
            if (ref.name === symbol.name && ref.kind === symbol.kind) {
                highlights.push(new vscode.DocumentHighlight(
                    ref.range,
                    vscode.DocumentHighlightKind.Read
                ));
            }

            // Also check if this is a label reference with % but we're looking at a label definition without %
            if (actualKind === SymbolKind.Label && ref.kind === SymbolKind.LocalValue) {
                if (ref.functionName !== symbol.functionName) {
                    continue;
                }
                const refWithoutPercent = ref.name.startsWith('%') ? ref.name.substring(1) : ref.name;
                if (refWithoutPercent === actualName) {
                    if (definition && ref.range.isEqual(definition.selectionRange)) {
                        continue;
                    }
                    highlights.push(new vscode.DocumentHighlight(
                        ref.range,
                        vscode.DocumentHighlightKind.Read
                    ));
                }
            }
        }

        return highlights.length > 0 ? highlights : null;
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

