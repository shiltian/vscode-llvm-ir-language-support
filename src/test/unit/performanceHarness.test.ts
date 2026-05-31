/**
 * Lightweight performance harness for parser and provider hot paths.
 *
 * The assertions verify that generated inputs exercise the intended code paths;
 * the duration values are emitted for local comparison without flaky thresholds.
 */

import * as assert from 'assert';

import { LLVMIRDocumentHighlightProvider } from '../../providers/documentHighlightProvider';
import { LLVMIRReferenceProvider } from '../../providers/referenceProvider';
import { LLVMIRRenameProvider } from '../../providers/renameProvider';
import {
    clearCache,
    getSymbolAndParsedDocument,
    parseDocument,
} from '../../llvmIrParser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { vscodeMock } = require('../setup.js');

let documentCounter = 0;

function createMockDocument(content: string): any {
    const uniqueUri = `file:///perf_${++documentCounter}_${Date.now()}.ll`;
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

function generateLargeIR(functionCount: number, valuesPerFunction: number): string {
    const lines: string[] = [];

    for (let funcIndex = 0; funcIndex < functionCount; funcIndex++) {
        lines.push(`define i32 @func${funcIndex}(i32 %arg) {`);
        lines.push('entry:');
        lines.push(`  %v${funcIndex}_0 = add i32 %arg, ${funcIndex}`);

        for (let valueIndex = 1; valueIndex < valuesPerFunction; valueIndex++) {
            lines.push(
                `  %v${funcIndex}_${valueIndex} = add i32 %v${funcIndex}_${valueIndex - 1}, ${valueIndex}`
            );
        }

        lines.push(`  ret i32 %v${funcIndex}_${valuesPerFunction - 1}`);
        lines.push('}');
        lines.push('');
    }

    return lines.join('\n');
}

function measure(name: string, fn: () => void): number {
    const start = process.hrtime.bigint();
    fn();
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    console.log(`[perf] ${name}: ${durationMs.toFixed(3)}ms`);
    return durationMs;
}

const activeToken = { isCancellationRequested: false } as any;

describe('LLVM IR Performance Harness', () => {
    it('measures parser and provider hot paths on synthetic IR', () => {
        const content = generateLargeIR(80, 24);
        const doc = createMockDocument(content);
        const linesPerFunction = 24 + 5;
        const targetLine = 40 * linesPerFunction + 12;
        const targetText = doc.lineAt(targetLine).text;
        const targetColumn = targetText.indexOf('%v40_10') + 2;
        const targetPosition = new vscodeMock.Position(targetLine, targetColumn);

        let parsed: ReturnType<typeof parseDocument> | undefined;
        const parseMs = measure('parseDocument cold', () => {
            parsed = parseDocument(doc);
        });
        assert.ok(parsed, 'Parser should produce a parsed document');
        assert.ok(parsed!.references.length > 0, 'Synthetic IR should produce references');
        assert.ok(parsed!.referencesByKey.size > 0, 'Parser should populate reference indexes');

        clearCache(doc.uri);
        const symbolMs = measure('getSymbolAndParsedDocument cold', () => {
            const result = getSymbolAndParsedDocument(doc, targetPosition, activeToken);
            assert.ok(result, 'Symbol lookup should find the target value');
        });

        const referenceProvider = new LLVMIRReferenceProvider();
        const referencesMs = measure('reference provider hot', () => {
            const references = referenceProvider.provideReferences(
                doc,
                targetPosition,
                { includeDeclaration: true },
                activeToken
            );
            assert.ok(Array.isArray(references), 'Reference provider should return locations');
            assert.ok(references.length > 0, 'Reference provider should find references');
        });

        const highlightProvider = new LLVMIRDocumentHighlightProvider();
        const highlightsMs = measure('highlight provider hot', () => {
            const highlights = highlightProvider.provideDocumentHighlights(doc, targetPosition, activeToken);
            assert.ok(Array.isArray(highlights), 'Highlight provider should return highlights');
            assert.ok(highlights.length > 0, 'Highlight provider should find highlights');
        });

        const renameProvider = new LLVMIRRenameProvider();
        const renameMs = measure('rename provider hot', () => {
            const edits = renameProvider.provideRenameEdits(doc, targetPosition, 'renamed', activeToken);
            assert.ok(edits, 'Rename provider should return workspace edits');
        });

        assert.ok(parseMs >= 0);
        assert.ok(symbolMs >= 0);
        assert.ok(referencesMs >= 0);
        assert.ok(highlightsMs >= 0);
        assert.ok(renameMs >= 0);
    });
});
