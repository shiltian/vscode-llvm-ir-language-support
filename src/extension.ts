import * as vscode from 'vscode';
import { LLVMIRDefinitionProvider } from './providers/definitionProvider';
import { LLVMIRReferenceProvider } from './providers/referenceProvider';
import { LLVMIRDocumentSymbolProvider } from './providers/documentSymbolProvider';
import { LLVMIRHoverProvider } from './providers/hoverProvider';
import { clearCache, clearAllCache } from './llvmIrParser';

const LLVM_IR_LANGUAGE_ID = 'llvm-ir';

export function activate(context: vscode.ExtensionContext) {
    console.log('LLVM IR extension activated');

    // Register the definition provider
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            { language: LLVM_IR_LANGUAGE_ID },
            new LLVMIRDefinitionProvider()
        )
    );

    // Register the reference provider
    context.subscriptions.push(
        vscode.languages.registerReferenceProvider(
            { language: LLVM_IR_LANGUAGE_ID },
            new LLVMIRReferenceProvider()
        )
    );

    // Register the document symbol provider
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(
            { language: LLVM_IR_LANGUAGE_ID },
            new LLVMIRDocumentSymbolProvider()
        )
    );

    // Register the hover provider
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { language: LLVM_IR_LANGUAGE_ID },
            new LLVMIRHoverProvider()
        )
    );

    // Clear cache when documents are changed or closed
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.languageId === LLVM_IR_LANGUAGE_ID) {
                clearCache(event.document.uri);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (document.languageId === LLVM_IR_LANGUAGE_ID) {
                clearCache(document.uri);
            }
        })
    );
}

export function deactivate() {
    clearAllCache();
}

