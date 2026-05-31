/**
 * Provider-level regression tests for behavior that parser-only tests cannot cover.
 */

import * as assert from 'assert';

import { LLVMIRDocumentSymbolProvider } from '../../providers/documentSymbolProvider';
import { LLVMIRRenameProvider } from '../../providers/renameProvider';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { vscodeMock } = require('../setup.js');

let documentCounter = 0;

function createMockDocument(content: string): any {
    const uniqueUri = `file:///provider_${++documentCounter}_${Date.now()}.ll`;
    const lines = content.split('\n');
    return {
        uri: vscodeMock.Uri.parse(uniqueUri),
        version: 1,
        getText: () => content,
        lineAt: (lineOrPosition: number | any) => {
            const lineNumber = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
            const text = lines[lineNumber] || '';
            return {
                lineNumber,
                text,
                range: new vscodeMock.Range(lineNumber, 0, lineNumber, text.length),
                rangeIncludingLineBreak: new vscodeMock.Range(lineNumber, 0, lineNumber, text.length),
                firstNonWhitespaceCharacterIndex: text.search(/\S/) === -1 ? text.length : text.search(/\S/),
                isEmptyOrWhitespace: text.trim().length === 0,
            };
        },
        lineCount: lines.length,
    };
}

const activeToken = { isCancellationRequested: false } as any;

describe('LLVM IR Provider Regressions', () => {
    it('should show functions once and keep globals in document symbols', () => {
        const content = `@global = global i32 0
define void @main() {
entry:
  ret void
}`;
        const doc = createMockDocument(content);
        const provider = new LLVMIRDocumentSymbolProvider();

        const symbols = provider.provideDocumentSymbols(doc, activeToken) as any[];
        assert.ok(Array.isArray(symbols), 'Document symbol provider should return symbols');

        assert.strictEqual(symbols.filter(symbol => symbol.name === '@main').length, 1);
        assert.strictEqual(symbols.filter(symbol => symbol.name === '@global').length, 1);
    });

    it('should rename ordinary symbols without their prefix', () => {
        const content = `define i32 @test(i32 %arg) {
entry:
  %value = add i32 %arg, 1
  ret i32 %value
}`;
        const doc = createMockDocument(content);
        const provider = new LLVMIRRenameProvider();
        const edits = provider.provideRenameEdits(doc, new vscodeMock.Position(2, 4), 'renamed', activeToken);

        assert.ok(edits, 'Rename should produce edits');
        const fileEdits = (edits as any).get(doc.uri);
        assert.ok(fileEdits.length >= 2, 'Rename should edit definition and references');
        assert.ok(fileEdits.every((edit: any) => edit.newText === 'renamed'));
    });

    it('should reject invalid unquoted rename names', () => {
        const content = `define i32 @test() {
entry:
  %value = add i32 1, 2
  ret i32 %value
}`;
        const doc = createMockDocument(content);
        const provider = new LLVMIRRenameProvider();

        assert.throws(
            () => provider.provideRenameEdits(doc, new vscodeMock.Position(2, 4), 'bad name', activeToken),
            /Invalid LLVM IR name/
        );
    });

    it('should preserve quoted identifier delimiters during rename', () => {
        const content = `define void @"foo bar"() {
entry:
  call void @"foo bar"()
  ret void
}`;
        const doc = createMockDocument(content);
        const provider = new LLVMIRRenameProvider();
        const edits = provider.provideRenameEdits(doc, new vscodeMock.Position(0, 15), 'baz qux', activeToken);

        assert.ok(edits, 'Quoted rename should produce edits');
        const fileEdits = (edits as any).get(doc.uri);
        assert.ok(fileEdits.length >= 2, 'Quoted rename should edit definition and reference');
        assert.ok(fileEdits.every((edit: any) => edit.newText === 'baz qux'));
        assert.ok(
            fileEdits.every((edit: any) => edit.range.start.character > 0),
            'Rename ranges should target the quoted identifier interior'
        );
    });

    it('should rename label definitions and label references', () => {
        const content = `define void @test() {
entry:
  br label %exit
exit:
  ret void
}`;
        const doc = createMockDocument(content);
        const provider = new LLVMIRRenameProvider();
        const edits = provider.provideRenameEdits(doc, new vscodeMock.Position(3, 1), 'done', activeToken);

        assert.ok(edits, 'Label rename should produce edits');
        const fileEdits = (edits as any).get(doc.uri);
        assert.ok(fileEdits.length >= 2, 'Label rename should edit definition and branch reference');
        assert.ok(fileEdits.every((edit: any) => edit.newText === 'done'));
    });
});
