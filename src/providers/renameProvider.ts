import * as vscode from 'vscode';
import {
    getReferencesForSymbol,
    getSymbolAndParsedDocument,
    resolveSymbol,
    SymbolKind,
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
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {
        const result = getSymbolAndParsedDocument(document, position, token);
        if (!result) {
            throw new Error('Cannot rename this element');
        }

        const { symbol, parsed } = result;

        // Resolve the symbol to get the actual definition
        const { definition, actualKind } = resolveSymbol(parsed, symbol);

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
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.WorkspaceEdit> {
        const result = getSymbolAndParsedDocument(document, position, token);
        if (!result) {
            return null;
        }

        const { symbol, parsed } = result;
        const workspaceEdit = new vscode.WorkspaceEdit();
        const edits: vscode.TextEdit[] = [];

        // Resolve the symbol to find the actual definition and kind
        const resolved = resolveSymbol(parsed, symbol);
        const { definition, actualKind } = resolved;

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

        for (const ref of getReferencesForSymbol(parsed, symbol, resolved)) {
            if (token.isCancellationRequested) {
                return null;
            }
            if (definition && ref.range.isEqual(definition.selectionRange)) {
                continue;
            }
            locationsToRename.push({
                range: ref.range,
                prefix: getSymbolPrefix(ref.kind, ref.name),
            });
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

