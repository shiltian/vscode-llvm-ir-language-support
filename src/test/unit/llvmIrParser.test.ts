/**
 * Unit tests for the LLVM IR parser.
 * These tests use mocked VS Code APIs to test parsing logic in isolation.
 *
 * Note: The vscode module is mocked in setup.ts which is loaded before this file.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Import parser - vscode is mocked by setup.ts
import {
    SymbolKind,
    parseDocument,
    getSymbolAtPosition,
    getSymbolKey,
} from '../../llvmIrParser';

// Import the mock for creating test documents
// Note: setup.js is copied to out/test/ during test run (see package.json test:unit script)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { vscodeMock } = require('../setup.js');

// Counter for unique document URIs to avoid cache collisions
let documentCounter = 0;

/**
 * Create a mock TextDocument for testing
 * Each call creates a document with a unique URI to avoid parser cache issues
 */
function createMockDocument(content: string, uri?: string): any {
    const uniqueUri = uri || `file:///test_${++documentCounter}_${Date.now()}.ll`;
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
        positionAt: (offset: number) => {
            let remaining = offset;
            for (let line = 0; line < lines.length; line++) {
                const lineLength = lines[line].length + 1;
                if (remaining < lineLength) {
                    return new vscodeMock.Position(line, remaining);
                }
                remaining -= lineLength;
            }
            return new vscodeMock.Position(lines.length - 1, lines[lines.length - 1]?.length || 0);
        },
        offsetAt: (position: any) => {
            let offset = 0;
            for (let line = 0; line < position.line; line++) {
                offset += lines[line].length + 1;
            }
            return offset + position.character;
        },
    };
}

describe('LLVM IR Parser', () => {
    describe('parseDocument', () => {
        describe('Function Definitions', () => {
            it('should parse a simple function definition', () => {
                const content = `define i32 @main() {
entry:
  ret i32 0
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const funcDef = parsed.definitions.get(getSymbolKey(SymbolKind.Function, '@main'));
                assert.ok(funcDef, 'Function @main should be defined');
                assert.strictEqual(funcDef.name, '@main');
                assert.strictEqual(funcDef.kind, SymbolKind.Function);
            });

            it('should parse function with parameters', () => {
                const content = `define i32 @add(i32 %a, i32 %b) {
entry:
  %sum = add i32 %a, %b
  ret i32 %sum
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                // Check function is parsed
                const funcDef = parsed.definitions.get(getSymbolKey(SymbolKind.Function, '@add'));
                assert.ok(funcDef, 'Function @add should be defined');

                // Check parameters are parsed as local values
                const paramA = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%a', '@add'));
                assert.ok(paramA, 'Parameter %a should be defined');
                assert.strictEqual(paramA.detail, 'parameter %a');

                const paramB = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%b', '@add'));
                assert.ok(paramB, 'Parameter %b should be defined');
            });

            it('should parse function with addrspace in parameters', () => {
                const content = `define void @test_addrspace(ptr addrspace(1) %global, ptr addrspace(3) %local) {
entry:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                // Function should be parsed
                const funcDef = parsed.definitions.get(getSymbolKey(SymbolKind.Function, '@test_addrspace'));
                assert.ok(funcDef, 'Function @test_addrspace should be defined');

                // Parameters with addrspace should be parsed correctly
                const globalParam = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%global', '@test_addrspace'));
                assert.ok(globalParam, 'Parameter %global with addrspace(1) should be defined');

                const localParam = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%local', '@test_addrspace'));
                assert.ok(localParam, 'Parameter %local with addrspace(3) should be defined');
            });

            it('should parse complex function with multiple addrspace parameters', () => {
                const content = `define amdgpu_ps void @test_swmmac(<8 x i32> %A, <16 x i32> %B, <8 x i32> %C, ptr addrspace(1) %IndexVecPtr, ptr addrspace(1) %IndexVecOutPtr, ptr addrspace(1) %out) {
bb:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                // All parameters should be parsed
                const params = ['%A', '%B', '%C', '%IndexVecPtr', '%IndexVecOutPtr', '%out'];
                for (const param of params) {
                    const def = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, param, '@test_swmmac'));
                    assert.ok(def, `Parameter ${param} should be defined`);
                }
            });

            it('should parse function with nested parentheses in type', () => {
                const content = `define void @complex_types(ptr addrspace(1) %ptr, { i32, ptr addrspace(2) } %struct) {
entry:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const ptrParam = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%ptr', '@complex_types'));
                assert.ok(ptrParam, 'Parameter %ptr should be defined');

                const structParam = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%struct', '@complex_types'));
                assert.ok(structParam, 'Parameter %struct should be defined');
            });

            it('should not treat type references in byref/sret as parameters', () => {
                // Type references inside byref(), sret(), inalloca(), preallocated() should NOT be
                // registered as function parameters - only the actual parameter name should be
                const content = `%"struct.MyType" = type { i32, i64 }

define void @test_byref(ptr byref(%"struct.MyType") %0) {
entry:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                // The type should be defined as a NamedType
                const typeDef = parsed.definitions.get(getSymbolKey(SymbolKind.NamedType, '%"struct.MyType"'));
                assert.ok(typeDef, 'Type %"struct.MyType" should be defined');
                assert.strictEqual(typeDef.kind, SymbolKind.NamedType);

                // The actual parameter %0 should be defined
                const param0 = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%0', '@test_byref'));
                assert.ok(param0, 'Parameter %0 should be defined');
                assert.strictEqual(param0.detail, 'parameter %0');

                // The type reference inside byref() should NOT be registered as a parameter
                const wrongParam = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%"struct.MyType"', '@test_byref'));
                assert.strictEqual(wrongParam, undefined, 'Type reference inside byref() should NOT be a parameter');
            });

            it('should handle complex byref with quoted type names containing special characters', () => {
                // Real-world example: C++ mangled names with :: separators
                const content = `%"struct.ns::MyClass" = type { ptr, i32 }

define amdgpu_kernel void @kernel(ptr addrspace(4) noundef readonly byref(%"struct.ns::MyClass") align 8 captures(none) %args) {
entry:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                // The type should be defined
                const typeDef = parsed.definitions.get(getSymbolKey(SymbolKind.NamedType, '%"struct.ns::MyClass"'));
                assert.ok(typeDef, 'Type %"struct.ns::MyClass" should be defined');

                // The actual parameter %args should be defined
                const argsParam = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%args', '@kernel'));
                assert.ok(argsParam, 'Parameter %args should be defined');

                // Type reference should NOT be a parameter
                const wrongParam = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%"struct.ns::MyClass"', '@kernel'));
                assert.strictEqual(wrongParam, undefined, 'Type reference should NOT be a parameter');
            });

            it('should not treat type references in sret as parameters', () => {
                const content = `%struct.Result = type { i64, i64 }

define void @returns_struct(ptr sret(%struct.Result) %result, i32 %input) {
entry:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                // Actual parameters should be defined
                const resultParam = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%result', '@returns_struct'));
                assert.ok(resultParam, 'Parameter %result should be defined');

                const inputParam = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%input', '@returns_struct'));
                assert.ok(inputParam, 'Parameter %input should be defined');

                // Type reference should NOT be a parameter
                const wrongParam = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%struct.Result', '@returns_struct'));
                assert.strictEqual(wrongParam, undefined, 'Type reference in sret() should NOT be a parameter');
            });
        });

        describe('Local Value Definitions', () => {
            it('should parse local value assignments', () => {
                const content = `define i32 @test() {
entry:
  %x = add i32 1, 2
  %y = mul i32 %x, 3
  ret i32 %y
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const xDef = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%x', '@test'));
                assert.ok(xDef, 'Local value %x should be defined');
                assert.strictEqual(xDef.functionName, '@test');

                const yDef = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%y', '@test'));
                assert.ok(yDef, 'Local value %y should be defined');
            });

            it('should parse numbered local values', () => {
                const content = `define i32 @test() {
entry:
  %0 = add i32 1, 2
  %1 = mul i32 %0, 3
  ret i32 %1
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const def0 = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%0', '@test'));
                assert.ok(def0, 'Local value %0 should be defined');

                const def1 = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%1', '@test'));
                assert.ok(def1, 'Local value %1 should be defined');
            });
        });

        describe('Label Definitions', () => {
            it('should parse basic block labels', () => {
                const content = `define void @test() {
entry:
  br label %loop

loop:
  br label %exit

exit:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const entryLabel = parsed.definitions.get(getSymbolKey(SymbolKind.Label, 'entry', '@test'));
                assert.ok(entryLabel, 'Label entry should be defined');
                assert.strictEqual(entryLabel.functionName, '@test');

                const loopLabel = parsed.definitions.get(getSymbolKey(SymbolKind.Label, 'loop', '@test'));
                assert.ok(loopLabel, 'Label loop should be defined');

                const exitLabel = parsed.definitions.get(getSymbolKey(SymbolKind.Label, 'exit', '@test'));
                assert.ok(exitLabel, 'Label exit should be defined');
            });

            it('should parse labels with dots and special characters', () => {
                const content = `define void @test() {
for.cond:
  br label %for.body

for.body:
  br label %for.end

for.end:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const condLabel = parsed.definitions.get(getSymbolKey(SymbolKind.Label, 'for.cond', '@test'));
                assert.ok(condLabel, 'Label for.cond should be defined');

                const bodyLabel = parsed.definitions.get(getSymbolKey(SymbolKind.Label, 'for.body', '@test'));
                assert.ok(bodyLabel, 'Label for.body should be defined');
            });
        });

        describe('Global Variable Definitions', () => {
            it('should parse global variable definitions', () => {
                const content = `@global_var = global i32 42
@.str = private constant [6 x i8] c"hello\\00"`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const globalVar = parsed.definitions.get(getSymbolKey(SymbolKind.GlobalValue, '@global_var'));
                assert.ok(globalVar, 'Global @global_var should be defined');

                const strConst = parsed.definitions.get(getSymbolKey(SymbolKind.GlobalValue, '@.str'));
                assert.ok(strConst, 'Global @.str should be defined');
            });

            it('should parse external global declarations', () => {
                const content = `@external = external global i32`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const external = parsed.definitions.get(getSymbolKey(SymbolKind.GlobalValue, '@external'));
                assert.ok(external, 'External global @external should be defined');
            });
        });

        describe('Named Type Definitions', () => {
            it('should parse struct type definitions', () => {
                const content = `%struct.Point = type { i32, i32 }
%struct.Node = type { i32, ptr }`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const point = parsed.definitions.get(getSymbolKey(SymbolKind.NamedType, '%struct.Point'));
                assert.ok(point, 'Type %struct.Point should be defined');
                assert.strictEqual(point.kind, SymbolKind.NamedType);

                const node = parsed.definitions.get(getSymbolKey(SymbolKind.NamedType, '%struct.Node'));
                assert.ok(node, 'Type %struct.Node should be defined');
            });

            it('should parse opaque type definitions', () => {
                const content = `%opaque = type opaque`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const opaque = parsed.definitions.get(getSymbolKey(SymbolKind.NamedType, '%opaque'));
                assert.ok(opaque, 'Type %opaque should be defined');
            });
        });

        describe('Metadata Definitions', () => {
            it('should parse named metadata', () => {
                const content = `!llvm.module.flags = !{!0, !1}
!llvm.ident = !{!2}
!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{i32 7, !"uwtable", i32 2}
!2 = !{!"clang"}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const moduleFlags = parsed.definitions.get(getSymbolKey(SymbolKind.Metadata, '!llvm.module.flags'));
                assert.ok(moduleFlags, 'Dotted metadata !llvm.module.flags should be defined');

                const ident = parsed.definitions.get(getSymbolKey(SymbolKind.Metadata, '!llvm.ident'));
                assert.ok(ident, 'Dotted metadata !llvm.ident should be defined');

                const meta0 = parsed.definitions.get(getSymbolKey(SymbolKind.Metadata, '!0'));
                assert.ok(meta0, 'Metadata !0 should be defined');

                const meta1 = parsed.definitions.get(getSymbolKey(SymbolKind.Metadata, '!1'));
                assert.ok(meta1, 'Metadata !1 should be defined');
            });
        });

        describe('Attribute Group Definitions', () => {
            it('should parse attribute groups', () => {
                const content = `attributes #0 = { nounwind "frame-pointer"="all" }
attributes #1 = { nounwind readnone }`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const attr0 = parsed.definitions.get(getSymbolKey(SymbolKind.AttributeGroup, '#0'));
                assert.ok(attr0, 'Attribute group #0 should be defined');

                const attr1 = parsed.definitions.get(getSymbolKey(SymbolKind.AttributeGroup, '#1'));
                assert.ok(attr1, 'Attribute group #1 should be defined');
            });
        });

        describe('Function Declarations', () => {
            it('should parse function declarations', () => {
                const content = `declare i32 @printf(ptr, ...)
declare ptr @malloc(i64)`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const printf = parsed.definitions.get(getSymbolKey(SymbolKind.Function, '@printf'));
                assert.ok(printf, 'Declaration @printf should be defined');

                const malloc = parsed.definitions.get(getSymbolKey(SymbolKind.Function, '@malloc'));
                assert.ok(malloc, 'Declaration @malloc should be defined');
            });
        });

        describe('References', () => {
            it('should parse global references', () => {
                const content = `define void @test() {
  %val = load i32, ptr @global_var
  call void @other_func()
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const globalRefs = parsed.references.filter(r => r.name === '@global_var');
                assert.ok(globalRefs.length > 0, 'Reference to @global_var should be found');

                const funcRefs = parsed.references.filter(r => r.name === '@other_func');
                assert.ok(funcRefs.length > 0, 'Reference to @other_func should be found');
            });

            it('should parse local references with function scope', () => {
                const content = `define i32 @test() {
entry:
  %x = add i32 1, 2
  %y = mul i32 %x, 3
  ret i32 %y
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const xRefs = parsed.references.filter(r => r.name === '%x' && r.functionName === '@test');
                assert.ok(xRefs.length > 0, 'Reference to %x in @test should be found');

                const yRefs = parsed.references.filter(r => r.name === '%y' && r.functionName === '@test');
                assert.ok(yRefs.length > 0, 'Reference to %y in @test should be found');
            });

            it('should parse metadata references', () => {
                const content = `define void @test() !dbg !5 {
  ret void
}
!5 = !{!"test"}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const metaRefs = parsed.references.filter(r => r.name === '!5');
                assert.ok(metaRefs.length > 0, 'Reference to !5 should be found');
            });

            it('should parse dotted metadata references', () => {
                const content = `!llvm.module.flags = !{!0}
!llvm.ident = !{!1}
!named = !{!llvm.ident}
!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{!"clang"}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const moduleFlagsRefs = parsed.references.filter(r => r.name === '!llvm.module.flags');
                assert.strictEqual(moduleFlagsRefs.length, 0, 'Dotted metadata definition should not be a reference');

                const identRefs = parsed.references.filter(r => r.name === '!llvm.ident');
                assert.strictEqual(identRefs.length, 1, 'Dotted metadata reference should be found');

                const symbol = getSymbolAtPosition(doc, new vscodeMock.Position(0, 3));
                assert.ok(symbol, 'Dotted metadata symbol should be found');
                assert.strictEqual(symbol.name, '!llvm.module.flags');
            });

            it('should parse attribute group references', () => {
                const content = `define void @test() #0 {
  ret void
}
attributes #0 = { nounwind }`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const attrRefs = parsed.references.filter(r => r.name === '#0');
                assert.ok(attrRefs.length > 0, 'Reference to #0 should be found');
            });
        });

        describe('Function Scopes', () => {
            it('should track function scope boundaries', () => {
                const content = `define void @func1() {
entry:
  ret void
}

define void @func2() {
entry:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                assert.strictEqual(parsed.functionScopes.length, 2, 'Should have 2 function scopes');

                const func1Scope = parsed.functionScopes.find(s => s.name === '@func1');
                assert.ok(func1Scope, 'Scope for @func1 should exist');

                const func2Scope = parsed.functionScopes.find(s => s.name === '@func2');
                assert.ok(func2Scope, 'Scope for @func2 should exist');
            });

            it('should handle nested braces in functions', () => {
                const content = `define void @test() {
entry:
  switch i32 0, label %default [
    i32 0, label %case0
  ]
case0:
  ret void
default:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                const scope = parsed.functionScopes.find(s => s.name === '@test');
                assert.ok(scope, 'Scope for @test should exist');
                assert.strictEqual(scope.startLine, 0);
                assert.ok(scope.endLine > scope.startLine, 'End line should be after start line');
            });

            it('should ignore braces in strings and comments for function scope', () => {
                const content = `define void @first() {
entry:
  call void @use(ptr @.str)
  ret void ; } should not close the function early
}

@.str = private constant [8 x i8] c"{ text }\\00"

define void @second() {
entry:
  ret void
}`;
                const doc = createMockDocument(content);
                const parsed = parseDocument(doc);

                assert.ok(parsed.functionScopes.find(s => s.name === '@first'), 'First function scope should exist');
                assert.ok(parsed.functionScopes.find(s => s.name === '@second'), 'Second function scope should exist');
                assert.strictEqual(parsed.functionScopes.length, 2, 'Comment braces should not corrupt function scopes');
            });
        });
    });

    describe('getSymbolAtPosition', () => {
        it('should identify global symbol at cursor position', () => {
            const content = `@global = global i32 42`;
            const doc = createMockDocument(content);
            const position = new vscodeMock.Position(0, 1); // On '@global'

            const symbol = getSymbolAtPosition(doc, position);
            assert.ok(symbol, 'Symbol should be found');
            assert.strictEqual(symbol.name, '@global');
            assert.strictEqual(symbol.kind, SymbolKind.GlobalValue);
        });

        it('should identify local symbol at cursor position', () => {
            const content = `define i32 @test() {
entry:
  %result = add i32 1, 2
  ret i32 %result
}`;
            const doc = createMockDocument(content);
            const position = new vscodeMock.Position(3, 12); // On '%result' in ret

            const symbol = getSymbolAtPosition(doc, position);
            assert.ok(symbol, 'Symbol should be found');
            assert.strictEqual(symbol.name, '%result');
            assert.strictEqual(symbol.kind, SymbolKind.LocalValue);
        });

        it('should identify metadata symbol at cursor position', () => {
            const content = `!0 = !{i32 1}`;
            const doc = createMockDocument(content);
            const position = new vscodeMock.Position(0, 1); // On '!0'

            const symbol = getSymbolAtPosition(doc, position);
            assert.ok(symbol, 'Symbol should be found');
            assert.strictEqual(symbol.name, '!0');
            assert.strictEqual(symbol.kind, SymbolKind.Metadata);
        });

        it('should identify attribute group at cursor position', () => {
            const content = `define void @test() #0 {
  ret void
}`;
            const doc = createMockDocument(content);
            const position = new vscodeMock.Position(0, 21); // On '#0'

            const symbol = getSymbolAtPosition(doc, position);
            assert.ok(symbol, 'Symbol should be found');
            assert.strictEqual(symbol.name, '#0');
            assert.strictEqual(symbol.kind, SymbolKind.AttributeGroup);
        });

        it('should return null for non-symbol positions', () => {
            const content = `; This is a comment`;
            const doc = createMockDocument(content);
            const position = new vscodeMock.Position(0, 5);

            const symbol = getSymbolAtPosition(doc, position);
            assert.strictEqual(symbol, null, 'Should return null for comment');
        });

        it('should identify indented labels at cursor position', () => {
            const content = `define void @test() {
  entry:
    ret void
}`;
            const doc = createMockDocument(content);
            const position = new vscodeMock.Position(1, 4);

            const symbol = getSymbolAtPosition(doc, position);
            assert.ok(symbol, 'Indented label symbol should be found');
            assert.strictEqual(symbol.name, 'entry');
            assert.strictEqual(symbol.kind, SymbolKind.Label);
            assert.strictEqual(symbol.range.start.character, 2);
        });
    });

    describe('getSymbolKey', () => {
        it('should create unique keys for different symbol types', () => {
            const localKey = getSymbolKey(SymbolKind.LocalValue, '%x', '@func');
            const globalKey = getSymbolKey(SymbolKind.GlobalValue, '@x');

            assert.notStrictEqual(localKey, globalKey, 'Keys should be different');
        });

        it('should include function name for local values', () => {
            const key1 = getSymbolKey(SymbolKind.LocalValue, '%x', '@func1');
            const key2 = getSymbolKey(SymbolKind.LocalValue, '%x', '@func2');

            assert.notStrictEqual(key1, key2, 'Same local in different functions should have different keys');
        });

        it('should not include function name for global values', () => {
            const key1 = getSymbolKey(SymbolKind.GlobalValue, '@global', '@func1');
            const key2 = getSymbolKey(SymbolKind.GlobalValue, '@global', '@func2');

            assert.strictEqual(key1, key2, 'Global values should have same key regardless of function context');
        });
    });
});

describe('LLVM IR Grammar', () => {
    it('should classify splat as a language constant', () => {
        const grammarPath = path.resolve(__dirname, '../../../syntaxes/llvm-ir.tmLanguage.json');
        const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
        const constantPatterns = grammar.repository.constants.patterns;
        const languageConstants = constantPatterns.find((pattern: { name?: string }) =>
            pattern.name === 'constant.language.llvm-ir'
        );

        assert.ok(languageConstants, 'Language constant pattern should exist');
        assert.match('splat', new RegExp(languageConstants.match), 'splat should be highlighted as a constant');
    });

    it('should include all LLVM IR sigil symbols in the word pattern', () => {
        const languageConfigPath = path.resolve(__dirname, '../../../language-configuration.json');
        const languageConfig = JSON.parse(fs.readFileSync(languageConfigPath, 'utf8'));
        const wordPattern = new RegExp(languageConfig.wordPattern);

        for (const symbol of ['%local', '@global', '!llvm.module.flags', '!0', '#12', '$comdat']) {
            assert.match(symbol, wordPattern, `${symbol} should match the word pattern`);
        }
    });
});

describe('Edge Cases', () => {
    it('should handle empty document', () => {
        const doc = createMockDocument('');
        const parsed = parseDocument(doc);

        assert.strictEqual(parsed.definitions.size, 0);
        assert.strictEqual(parsed.references.length, 0);
    });

    it('should handle document with only comments', () => {
        const content = `; Comment line 1
; Comment line 2
; Comment line 3`;
        const doc = createMockDocument(content);
        const parsed = parseDocument(doc);

        assert.strictEqual(parsed.definitions.size, 0);
        assert.strictEqual(parsed.references.length, 0);
    });

    it('should handle quoted identifiers', () => {
        const content = `@"complex name with spaces" = global i32 0
define void @"function with spaces"() {
  ret void
}`;
        const doc = createMockDocument(content);
        const parsed = parseDocument(doc);

        const globalDef = parsed.definitions.get(getSymbolKey(SymbolKind.GlobalValue, '@"complex name with spaces"'));
        assert.ok(globalDef, 'Quoted global should be defined');

        const funcDef = parsed.definitions.get(getSymbolKey(SymbolKind.Function, '@"function with spaces"'));
        assert.ok(funcDef, 'Quoted function should be defined');
    });

    it('should handle very long lines', () => {
        const longType = '<' + Array(100).fill('i32').join(', ') + '>';
        const content = `define ${longType} @long_vector_func(${longType} %input) {
  ret ${longType} %input
}`;
        const doc = createMockDocument(content);
        const parsed = parseDocument(doc);

        const funcDef = parsed.definitions.get(getSymbolKey(SymbolKind.Function, '@long_vector_func'));
        assert.ok(funcDef, 'Function with long type should be defined');

        const paramDef = parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%input', '@long_vector_func'));
        assert.ok(paramDef, 'Parameter in function with long type should be defined');
    });

    it('should handle CRLF line endings and indented labels', () => {
        const content = 'define void @test() {\r\n  entry:\r\n    br label %exit\r\n  exit:\r\n    ret void\r\n}';
        const doc = createMockDocument(content);
        const parsed = parseDocument(doc);

        const entry = parsed.definitions.get(getSymbolKey(SymbolKind.Label, 'entry', '@test'));
        assert.ok(entry, 'Indented CRLF label entry should be defined');
        assert.strictEqual(entry.selectionRange.start.character, 2);

        const exit = parsed.definitions.get(getSymbolKey(SymbolKind.Label, 'exit', '@test'));
        assert.ok(exit, 'Indented CRLF label exit should be defined');
    });

    it('should not parse named types in signatures as local parameters', () => {
        const content = `%struct.T = type { i32 }
define void @typed(%struct.T* %p, ptr byref(%struct.T) %0) {
entry:
  ret void
}`;
        const doc = createMockDocument(content);
        const parsed = parseDocument(doc);

        assert.ok(parsed.definitions.get(getSymbolKey(SymbolKind.NamedType, '%struct.T')));
        assert.ok(parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%p', '@typed')));
        assert.ok(parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%0', '@typed')));
        assert.strictEqual(
            parsed.definitions.get(getSymbolKey(SymbolKind.LocalValue, '%struct.T', '@typed')),
            undefined,
            'Named type %struct.T should not be registered as a local parameter'
        );
    });

    it('should ignore symbol-looking text inside comments and string literals', () => {
        const content = `@.str = private constant [18 x i8] c"hello; @not_global\\00"
define void @test() {
entry:
  ret void ; @comment_global %comment_local !comment.meta
}`;
        const doc = createMockDocument(content);
        const parsed = parseDocument(doc);

        assert.strictEqual(parsed.references.some(r => r.name === '@not_global'), false);
        assert.strictEqual(parsed.references.some(r => r.name === '@comment_global'), false);
        assert.strictEqual(parsed.references.some(r => r.name === '%comment_local'), false);
        assert.strictEqual(parsed.references.some(r => r.name === '!comment.meta'), false);
    });

    it('should parse alias, ifunc, and comdat definitions', () => {
        const content = `$c = comdat any
@aliased = alias i32, ptr @target
@resolver = ifunc i32 (), ptr @resolve`;
        const doc = createMockDocument(content);
        const parsed = parseDocument(doc);

        assert.ok(parsed.definitions.get(getSymbolKey(SymbolKind.Comdat, '$c')), 'Comdat should be defined');
        assert.ok(parsed.definitions.get(getSymbolKey(SymbolKind.GlobalValue, '@aliased')), 'Alias should be defined');
        assert.ok(parsed.definitions.get(getSymbolKey(SymbolKind.GlobalValue, '@resolver')), 'IFUNC should be defined');
    });
});
