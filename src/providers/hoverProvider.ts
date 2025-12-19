import * as vscode from 'vscode';
import {
    parseDocument,
    getSymbolAtPosition,
    getSymbolKey,
    SymbolKind,
    SymbolDefinition,
} from '../llvmIrParser';

export class LLVMIRHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
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

        // Build hover content
        const kindName = this.getKindName(definition.kind);
        const markdown = new vscode.MarkdownString();

        // Add kind label
        markdown.appendMarkdown(`**${kindName}**\n\n`);

        // Add the definition line as code
        markdown.appendCodeblock(definition.detail || definition.name, 'llvm-ir');

        // Add location info
        const line = definition.selectionRange.start.line + 1;
        let locationInfo = `*Defined at line ${line}*`;
        if (definition.functionName) {
            locationInfo += ` in \`${definition.functionName}\``;
        }
        markdown.appendMarkdown(`\n\n${locationInfo}`);

        return new vscode.Hover(markdown, symbol.range);
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

        // Try exact match first
        let definition = definitions.get(getSymbolKey(kind, name));
        if (definition) {
            return definition;
        }

        // If it's a LocalValue starting with %, try alternatives
        if (kind === SymbolKind.LocalValue && name.startsWith('%')) {
            // Try NamedType
            definition = definitions.get(getSymbolKey(SymbolKind.NamedType, name));
            if (definition) {
                return definition;
            }

            // Try Label (labels are defined without % prefix)
            if (functionName) {
                const labelName = name.substring(1);
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

    private getKindName(kind: SymbolKind): string {
        switch (kind) {
            case SymbolKind.Function:
                return 'Function';
            case SymbolKind.GlobalValue:
                return 'Global Variable';
            case SymbolKind.LocalValue:
                return 'Local Value';
            case SymbolKind.NamedType:
                return 'Type Definition';
            case SymbolKind.Label:
                return 'Label';
            case SymbolKind.Metadata:
                return 'Metadata';
            case SymbolKind.AttributeGroup:
                return 'Attribute Group';
            case SymbolKind.Comdat:
                return 'Comdat';
            default:
                return 'Symbol';
        }
    }
}
