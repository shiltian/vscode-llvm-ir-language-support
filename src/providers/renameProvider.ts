import * as vscode from 'vscode';
import {
    parseDocument,
    getSymbolAtPosition,
    getSymbolKey,
    SymbolKind,
    SymbolDefinition,
} from '../llvmIrParser';

/**
 * Get the prefix for a symbol kind
 */
function getSymbolPrefix(kind: SymbolKind, name: string): string {
    switch (kind) {
        case SymbolKind.LocalValue:
        case SymbolKind.NamedType:
            return '%';
        case SymbolKind.GlobalValue:
        case SymbolKind.Function:
            return '@';
        case SymbolKind.Metadata:
            return '!';
        case SymbolKind.AttributeGroup:
            return '#';
        case SymbolKind.Comdat:
            return '$';
        case SymbolKind.Label:
            // Labels don't have a prefix in their definition
            return '';
        default:
            return '';
    }
}

/**
 * Extract the name without prefix
 */
function getNameWithoutPrefix(name: string): string {
    if (name.startsWith('%') || name.startsWith('@') || name.startsWith('!') ||
        name.startsWith('#') || name.startsWith('$')) {
        return name.substring(1);
    }
    return name;
}

/**
 * Calculate the range for just the name part (excluding prefix)
 */
function getNameOnlyRange(range: vscode.Range, fullName: string): vscode.Range {
    const prefix = fullName.match(/^[%@!#$]/)?.[0] || '';
    if (prefix) {
        return new vscode.Range(
            range.start.line,
            range.start.character + prefix.length,
            range.end.line,
            range.end.character
        );
    }
    return range;
}

export class LLVMIRRenameProvider implements vscode.RenameProvider {
    /**
     * Prepare rename - validates if rename is possible and returns the range/text
     */
    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {
        const symbol = getSymbolAtPosition(document, position);
        if (!symbol) {
            throw new Error('Cannot rename this element');
        }

        const parsed = parseDocument(document);

        // Resolve the symbol to get the actual definition
        const { definition, actualKind } = this.resolveSymbol(
            parsed.definitions,
            symbol.kind,
            symbol.name,
            symbol.functionName
        );

        // Check if we can rename this symbol
        if (!definition && actualKind !== SymbolKind.Label) {
            throw new Error('Cannot find symbol definition');
        }

        // Get the name without prefix for the placeholder
        const nameWithoutPrefix = getNameWithoutPrefix(symbol.name);

        // Return the range covering just the name part (excluding prefix)
        const nameOnlyRange = getNameOnlyRange(symbol.range, symbol.name);

        return {
            range: nameOnlyRange,
            placeholder: nameWithoutPrefix,
        };
    }

    /**
     * Provide rename edits
     */
    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.WorkspaceEdit> {
        const symbol = getSymbolAtPosition(document, position);
        if (!symbol) {
            return null;
        }

        const parsed = parseDocument(document);
        const workspaceEdit = new vscode.WorkspaceEdit();
        const edits: vscode.TextEdit[] = [];

        // Resolve the symbol to find the actual definition and kind
        const { definition, actualName, actualKind } = this.resolveSymbol(
            parsed.definitions,
            symbol.kind,
            symbol.name,
            symbol.functionName
        );

        // Collect all locations that need to be renamed
        const locationsToRename: { range: vscode.Range; prefix: string }[] = [];

        // Add the definition location if it exists
        if (definition) {
            const prefix = getSymbolPrefix(actualKind, definition.name);
            locationsToRename.push({
                range: definition.selectionRange,
                prefix: prefix,
            });
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
                // Skip if this is the same location as the definition
                if (definition && ref.range.isEqual(definition.selectionRange)) {
                    continue;
                }
                locationsToRename.push({
                    range: ref.range,
                    prefix: getSymbolPrefix(ref.kind, ref.name),
                });
            }

            // Handle label references stored with % prefix
            if (actualKind === SymbolKind.Label && ref.kind === SymbolKind.LocalValue) {
                if (ref.functionName !== symbol.functionName) {
                    continue;
                }
                const refWithoutPercent = ref.name.startsWith('%') ? ref.name.substring(1) : ref.name;
                if (refWithoutPercent === actualName) {
                    if (definition && ref.range.isEqual(definition.selectionRange)) {
                        continue;
                    }
                    locationsToRename.push({
                        range: ref.range,
                        prefix: '%',  // Label references use % prefix
                    });
                }
            }
        }

        // Create text edits for all locations
        for (const location of locationsToRename) {
            // Calculate the range for just the name part (after the prefix)
            const nameOnlyRange = getNameOnlyRange(location.range, location.prefix + 'x');

            // For labels in definitions (no prefix), use the full range
            if (!location.prefix) {
                edits.push(vscode.TextEdit.replace(location.range, newName));
            } else {
                edits.push(vscode.TextEdit.replace(nameOnlyRange, newName));
            }
        }

        // Remove duplicate edits (same range)
        const uniqueEdits = this.deduplicateEdits(edits);

        workspaceEdit.set(document.uri, uniqueEdits);
        return workspaceEdit;
    }

    /**
     * Resolve a symbol to find its definition and actual kind
     */
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

    /**
     * Remove duplicate edits that have the same range
     */
    private deduplicateEdits(edits: vscode.TextEdit[]): vscode.TextEdit[] {
        const seen = new Set<string>();
        return edits.filter(edit => {
            const key = `${edit.range.start.line}:${edit.range.start.character}-${edit.range.end.line}:${edit.range.end.character}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }
}

