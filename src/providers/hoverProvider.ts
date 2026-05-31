import * as vscode from 'vscode';
import {
    getSymbolAndParsedDocument,
    resolveSymbol,
    SymbolKind,
} from '../llvmIrParser';

export class LLVMIRHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const result = getSymbolAndParsedDocument(document, position, token);
        if (!result) {
            return null;
        }

        const { definition } = resolveSymbol(result.parsed, result.symbol);

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

        return new vscode.Hover(markdown, result.symbol.range);
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
