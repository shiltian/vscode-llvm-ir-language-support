import * as vscode from 'vscode';

/**
 * Types of symbols in LLVM IR
 */
export enum SymbolKind {
    LocalValue,      // %name, %0
    GlobalValue,     // @name, @0
    Label,           // labelname:
    NamedType,       // %struct.Name = type
    Metadata,        // !name, !0
    AttributeGroup,  // #0
    Function,        // define/declare @name
    Comdat,          // $name
}

/**
 * A symbol definition in LLVM IR
 */
export interface SymbolDefinition {
    name: string;
    kind: SymbolKind;
    range: vscode.Range;
    selectionRange: vscode.Range;
    detail?: string;
    // For local values and labels, the function they belong to
    functionName?: string;
    // For functions, store the range of the entire function body
    functionRange?: vscode.Range;
}

/**
 * A reference to a symbol
 */
export interface SymbolReference {
    name: string;
    kind: SymbolKind;
    range: vscode.Range;
    // For local values and labels, the function they belong to
    functionName?: string;
}

/**
 * Symbol information at a cursor position.
 */
export interface SymbolAtPosition {
    name: string;
    kind: SymbolKind;
    range: vscode.Range;
    functionName?: string;
}

/**
 * Information about a function's scope
 */
interface FunctionScope {
    name: string;
    startLine: number;
    endLine: number;
}

/**
 * Parsed result for a document
 */
export interface ParsedDocument {
    definitions: Map<string, SymbolDefinition>;
    references: SymbolReference[];
    referencesByKey: Map<string, SymbolReference[]>;
    functionScopes: FunctionScope[];
    functionNameByLine: (string | undefined)[];
}

/**
 * Result of resolving a cursor symbol to its canonical definition kind.
 */
export interface ResolvedSymbol {
    definition?: SymbolDefinition;
    actualName: string;
    actualKind: SymbolKind;
}

/**
 * Cache for parsed documents
 */
const documentCache = new Map<string, { version: number; parsed: ParsedDocument }>();

const LOCAL_NAME_PATTERN = '%(?:[-a-zA-Z$._][-a-zA-Z$._0-9]*|"[^"]+"|[0-9]+)';
const GLOBAL_NAME_PATTERN = '@(?:[-a-zA-Z$._][-a-zA-Z$._0-9]*|"[^"]+"|[0-9]+)';
const LABEL_NAME_PATTERN = '(?:[-a-zA-Z$._][-a-zA-Z$._0-9]*|[0-9]+|"[^"]+")';
const METADATA_NAME_PATTERN = '!(?:[a-zA-Z_][a-zA-Z0-9_.]*|[0-9]+)';
const ATTRIBUTE_GROUP_PATTERN = '#[0-9]+';
const COMDAT_NAME_PATTERN = '\\$(?:[-a-zA-Z$._][-a-zA-Z$._0-9]*|"[^"]+")';

function localRegex(flags = ''): RegExp {
    return new RegExp(LOCAL_NAME_PATTERN, flags);
}

function globalRegex(flags = ''): RegExp {
    return new RegExp(GLOBAL_NAME_PATTERN, flags);
}

function metadataRegex(flags = ''): RegExp {
    return new RegExp(`${METADATA_NAME_PATTERN}(?![a-zA-Z0-9_.])`, flags);
}

function attributeGroupRegex(flags = ''): RegExp {
    return new RegExp(ATTRIBUTE_GROUP_PATTERN, flags);
}

function comdatRegex(flags = ''): RegExp {
    return new RegExp(COMDAT_NAME_PATTERN, flags);
}

/**
 * Get the symbol key for lookups (combines kind, name, and optionally function scope)
 */
export function getSymbolKey(kind: SymbolKind, name: string, functionName?: string): string {
    if (functionName && (kind === SymbolKind.LocalValue || kind === SymbolKind.Label)) {
        return `${kind}:${functionName}:${name}`;
    }
    return `${kind}:${name}`;
}

function createEmptyParsedDocument(): ParsedDocument {
    return {
        definitions: new Map<string, SymbolDefinition>(),
        references: [],
        referencesByKey: new Map<string, SymbolReference[]>(),
        functionScopes: [],
        functionNameByLine: [],
    };
}

function addReference(
    references: SymbolReference[],
    referencesByKey: Map<string, SymbolReference[]>,
    reference: SymbolReference
): void {
    references.push(reference);

    const unscopedKey = getSymbolKey(reference.kind, reference.name);
    addReferenceToIndex(referencesByKey, unscopedKey, reference);

    if (reference.functionName &&
        (reference.kind === SymbolKind.LocalValue || reference.kind === SymbolKind.Label)) {
        const scopedKey = getSymbolKey(reference.kind, reference.name, reference.functionName);
        addReferenceToIndex(referencesByKey, scopedKey, reference);
    }
}

function addReferenceToIndex(
    referencesByKey: Map<string, SymbolReference[]>,
    key: string,
    reference: SymbolReference
): void {
    const refs = referencesByKey.get(key);
    if (refs) {
        refs.push(reference);
    } else {
        referencesByKey.set(key, [reference]);
    }
}

function buildFunctionNameByLine(
    lineCount: number,
    functionScopes: FunctionScope[]
): (string | undefined)[] {
    const functionNameByLine: (string | undefined)[] = new Array(lineCount);

    for (const scope of functionScopes) {
        const endLine = Math.min(scope.endLine, lineCount - 1);
        for (let lineNum = scope.startLine; lineNum <= endLine; lineNum++) {
            functionNameByLine[lineNum] = scope.name;
        }
    }

    return functionNameByLine;
}

function normalizeLines(text: string): string[] {
    return text.replace(/\r\n?/g, '\n').split('\n');
}

function getCodeBeforeComment(line: string): string {
    let inString = false;
    let stringStart = -1;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (inString) {
            if (char === '\\') {
                i++;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === ';') {
            return line.substring(0, i);
        }

        if (char === '"') {
            inString = true;
            stringStart = i;
        }
    }

    return stringStart >= 0 || inString ? line : line;
}

function getReferenceCode(line: string): string {
    const code = getCodeBeforeComment(line);
    const chars = code.split('');

    for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        const prev = i > 0 ? chars[i - 1] : '';

        if (char !== '"') {
            continue;
        }

        // Quoted identifiers use a sigil before the quote and should remain matchable.
        if (prev === '@' || prev === '%' || prev === '$') {
            i = skipQuotedString(chars, i);
            continue;
        }

        const end = skipQuotedString(chars, i);
        for (let j = i; j <= end && j < chars.length; j++) {
            chars[j] = ' ';
        }
        i = end;
    }

    return chars.join('');
}

function skipQuotedString(chars: string[], start: number): number {
    for (let i = start + 1; i < chars.length; i++) {
        if (chars[i] === '\\') {
            i++;
        } else if (chars[i] === '"') {
            return i;
        }
    }
    return chars.length - 1;
}

function countBracesOutsideStringsAndComments(line: string): number {
    const code = getCodeBeforeComment(line);
    let inString = false;
    let delta = 0;

    for (let i = 0; i < code.length; i++) {
        const char = code[i];

        if (inString) {
            if (char === '\\') {
                i++;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            delta++;
        } else if (char === '}') {
            delta--;
        }
    }

    return delta;
}

/**
 * Parse a document and extract all definitions and references
 */
export function parseDocument(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken
): ParsedDocument {
    const cached = documentCache.get(document.uri.toString());
    if (cached && cached.version === document.version) {
        return cached.parsed;
    }

    const definitions = new Map<string, SymbolDefinition>();
    const references: SymbolReference[] = [];
    const referencesByKey = new Map<string, SymbolReference[]>();
    const functionScopes: FunctionScope[] = [];
    const text = document.getText();
    const lines = normalizeLines(text);

    // First pass: find all function boundaries
    let currentFunction: string | null = null;
    let functionStartLine = -1;
    let braceDepth = 0;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        if (token?.isCancellationRequested) {
            return createEmptyParsedDocument();
        }

        const line = lines[lineNum];
        const trimmedLine = line.trim();

        // Skip empty lines and comments for function detection
        if (trimmedLine === '' || trimmedLine.startsWith(';')) {
            continue;
        }

        // Function definition start: define ... @name(...) ... {
        const funcMatch = line.match(new RegExp(`^\\s*define\\s+.*?(${GLOBAL_NAME_PATTERN})\\s*\\(`));
        if (funcMatch && currentFunction === null) {
            currentFunction = funcMatch[1];
            functionStartLine = lineNum;
            braceDepth = 0; // Will be counted below
        }

        // Track braces for function body
        if (currentFunction !== null) {
            braceDepth += countBracesOutsideStringsAndComments(line);

            if (braceDepth === 0 && functionStartLine >= 0) {
                functionScopes.push({
                    name: currentFunction,
                    startLine: functionStartLine,
                    endLine: lineNum,
                });
                currentFunction = null;
                functionStartLine = -1;
            }
        }
    }

    const functionNameByLine = buildFunctionNameByLine(lines.length, functionScopes);

    // Second pass: parse definitions and references with function scope awareness
    currentFunction = null;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        if (token?.isCancellationRequested) {
            return createEmptyParsedDocument();
        }

        const line = lines[lineNum];
        const trimmedLine = line.trim();
        currentFunction = functionNameByLine[lineNum] || null;

        // Skip empty lines and comments
        if (trimmedLine === '' || trimmedLine.startsWith(';')) {
            continue;
        }

        // Parse definitions
        parseDefinitions(line, lineNum, definitions, currentFunction, functionScopes);

        // Parse references
        parseReferences(line, lineNum, references, referencesByKey, currentFunction);
    }

    const parsed = { definitions, references, referencesByKey, functionScopes, functionNameByLine };
    documentCache.set(document.uri.toString(), { version: document.version, parsed });
    return parsed;
}

/**
 * Parse definitions from a line
 */
function parseDefinitions(
    line: string,
    lineNum: number,
    definitions: Map<string, SymbolDefinition>,
    currentFunction: string | null,
    functionScopes: FunctionScope[]
): void {
    // Named type definition: %typename = type ...
    const typeMatch = line.match(new RegExp(`^\\s*(${LOCAL_NAME_PATTERN})\\s*=\\s*type\\b`));
    if (typeMatch) {
        const name = typeMatch[1];
        const startCol = line.indexOf(name);
        const def: SymbolDefinition = {
            name,
            kind: SymbolKind.NamedType,
            range: new vscode.Range(lineNum, 0, lineNum, line.length),
            selectionRange: new vscode.Range(lineNum, startCol, lineNum, startCol + name.length),
            detail: line.trim(),
        };
        definitions.set(getSymbolKey(SymbolKind.NamedType, name), def);
        return; // Type definitions are not inside functions
    }

    // Global variable definition: @name = ...
    const globalVarMatch = line.match(new RegExp(`^\\s*(${GLOBAL_NAME_PATTERN})\\s*=`));
    if (globalVarMatch && !line.includes(' alias ') && !line.includes(' ifunc ') && !line.match(/^\s*define\b/)) {
        const name = globalVarMatch[1];
        const startCol = line.indexOf(name);
        const def: SymbolDefinition = {
            name,
            kind: SymbolKind.GlobalValue,
            range: new vscode.Range(lineNum, 0, lineNum, line.length),
            selectionRange: new vscode.Range(lineNum, startCol, lineNum, startCol + name.length),
            detail: line.trim(),
        };
        definitions.set(getSymbolKey(SymbolKind.GlobalValue, name), def);
    }

    // Alias definition: @name = ... alias ...
    const aliasMatch = line.match(new RegExp(`^\\s*(${GLOBAL_NAME_PATTERN})\\s*=.*\\balias\\b`));
    if (aliasMatch) {
        const name = aliasMatch[1];
        const startCol = line.indexOf(name);
        const def: SymbolDefinition = {
            name,
            kind: SymbolKind.GlobalValue,
            range: new vscode.Range(lineNum, 0, lineNum, line.length),
            selectionRange: new vscode.Range(lineNum, startCol, lineNum, startCol + name.length),
            detail: 'alias: ' + line.trim(),
        };
        definitions.set(getSymbolKey(SymbolKind.GlobalValue, name), def);
    }

    // IFUNC definition: @name = ... ifunc ...
    const ifuncMatch = line.match(new RegExp(`^\\s*(${GLOBAL_NAME_PATTERN})\\s*=.*\\bifunc\\b`));
    if (ifuncMatch) {
        const name = ifuncMatch[1];
        const startCol = line.indexOf(name);
        const def: SymbolDefinition = {
            name,
            kind: SymbolKind.GlobalValue,
            range: new vscode.Range(lineNum, 0, lineNum, line.length),
            selectionRange: new vscode.Range(lineNum, startCol, lineNum, startCol + name.length),
            detail: 'ifunc: ' + line.trim(),
        };
        definitions.set(getSymbolKey(SymbolKind.GlobalValue, name), def);
    }

    // Function definition: define ... @name(...)
    const funcDefMatch = line.match(new RegExp(`^\\s*define\\s+.*?(${GLOBAL_NAME_PATTERN})\\s*\\(`));
    if (funcDefMatch) {
        const name = funcDefMatch[1];
        const startCol = line.indexOf(name);

        // Find the function's end line
        const funcScope = functionScopes.find(s => s.name === name);
        const funcEndLine = funcScope ? funcScope.endLine : lineNum;

        const def: SymbolDefinition = {
            name,
            kind: SymbolKind.Function,
            range: new vscode.Range(lineNum, 0, funcEndLine, 0),
            selectionRange: new vscode.Range(lineNum, startCol, lineNum, startCol + name.length),
            detail: line.trim(),
            functionRange: new vscode.Range(lineNum, 0, funcEndLine, 0),
        };
        definitions.set(getSymbolKey(SymbolKind.Function, name), def);
        // Also add as GlobalValue for references
        definitions.set(getSymbolKey(SymbolKind.GlobalValue, name), def);

        // Parse function parameters - they belong to this function's scope
        // Use balanced parentheses matching to handle cases like addrspace(1)
        const paramsStr = extractBalancedParentheses(line, funcDefMatch[0].length - 1);
        if (paramsStr) {
            parseParameters(paramsStr, lineNum, line, definitions, name);
        }
    }

    // Function declaration: declare ... @name(...)
    const funcDeclMatch = line.match(new RegExp(`^\\s*declare\\s+.*?(${GLOBAL_NAME_PATTERN})\\s*\\(`));
    if (funcDeclMatch) {
        const name = funcDeclMatch[1];
        const startCol = line.indexOf(name);
        const def: SymbolDefinition = {
            name,
            kind: SymbolKind.Function,
            range: new vscode.Range(lineNum, 0, lineNum, line.length),
            selectionRange: new vscode.Range(lineNum, startCol, lineNum, startCol + name.length),
            detail: line.trim(),
        };
        definitions.set(getSymbolKey(SymbolKind.Function, name), def);
        definitions.set(getSymbolKey(SymbolKind.GlobalValue, name), def);
    }

    // Local value definition: %name = ... (must be inside a function)
    if (currentFunction) {
        const localMatch = line.match(new RegExp(`^\\s*(${LOCAL_NAME_PATTERN})\\s*=`));
        if (localMatch && !typeMatch) {  // Exclude type definitions
            const name = localMatch[1];
            const startCol = line.indexOf(name);
            const def: SymbolDefinition = {
                name,
                kind: SymbolKind.LocalValue,
                range: new vscode.Range(lineNum, 0, lineNum, line.length),
                selectionRange: new vscode.Range(lineNum, startCol, lineNum, startCol + name.length),
                detail: line.trim(),
                functionName: currentFunction,
            };
            definitions.set(getSymbolKey(SymbolKind.LocalValue, name, currentFunction), def);
        }

        // Label definition: labelname: (must be inside a function)
        const labelMatch = line.match(new RegExp(`^(\\s*)(${LABEL_NAME_PATTERN}):\\s*(;.*)?$`));
        if (labelMatch) {
            const indent = labelMatch[1].length;
            const name = labelMatch[2];
            const def: SymbolDefinition = {
                name,
                kind: SymbolKind.Label,
                range: new vscode.Range(lineNum, 0, lineNum, line.length),
                selectionRange: new vscode.Range(lineNum, indent, lineNum, indent + name.length),
                detail: `label ${name}`,
                functionName: currentFunction,
            };
            definitions.set(getSymbolKey(SymbolKind.Label, name, currentFunction), def);
        }
    }

    // Metadata definition: !name = ... or !0 = ...
    const metadataMatch = line.match(new RegExp(`^\\s*(${METADATA_NAME_PATTERN})\\s*=`));
    if (metadataMatch) {
        const name = metadataMatch[1];
        const startCol = line.indexOf(name);
        const def: SymbolDefinition = {
            name,
            kind: SymbolKind.Metadata,
            range: new vscode.Range(lineNum, 0, lineNum, line.length),
            selectionRange: new vscode.Range(lineNum, startCol, lineNum, startCol + name.length),
            detail: line.trim(),
        };
        definitions.set(getSymbolKey(SymbolKind.Metadata, name), def);
    }

    // Attribute group definition: attributes #0 = { ... }
    const attrMatch = line.match(new RegExp(`^\\s*attributes\\s+(${ATTRIBUTE_GROUP_PATTERN})\\s*=`));
    if (attrMatch) {
        const name = attrMatch[1];
        const startCol = line.indexOf(name);
        const def: SymbolDefinition = {
            name,
            kind: SymbolKind.AttributeGroup,
            range: new vscode.Range(lineNum, 0, lineNum, line.length),
            selectionRange: new vscode.Range(lineNum, startCol, lineNum, startCol + name.length),
            detail: line.trim(),
        };
        definitions.set(getSymbolKey(SymbolKind.AttributeGroup, name), def);
    }

    // Comdat definition: $name = comdat ...
    const comdatMatch = line.match(new RegExp(`^\\s*(${COMDAT_NAME_PATTERN})\\s*=\\s*comdat\\b`));
    if (comdatMatch) {
        const name = comdatMatch[1];
        const startCol = line.indexOf(name);
        const def: SymbolDefinition = {
            name,
            kind: SymbolKind.Comdat,
            range: new vscode.Range(lineNum, 0, lineNum, line.length),
            selectionRange: new vscode.Range(lineNum, startCol, lineNum, startCol + name.length),
            detail: line.trim(),
        };
        definitions.set(getSymbolKey(SymbolKind.Comdat, name), def);
    }
}

/**
 * Parse function parameters as local definitions
 */
function parseParameters(
    paramsStr: string,
    lineNum: number,
    fullLine: string,
    definitions: Map<string, SymbolDefinition>,
    functionName: string
): void {
    const paramsStart = fullLine.indexOf(paramsStr);

    for (const parameter of splitTopLevelParameters(paramsStr)) {
        const match = getParameterNameMatch(parameter.text);
        if (!match) {
            continue;
        }

        const name = match[0];
        const paramStart = paramsStart + parameter.start + match.index;
        const def: SymbolDefinition = {
            name,
            kind: SymbolKind.LocalValue,
            range: new vscode.Range(lineNum, 0, lineNum, fullLine.length),
            selectionRange: new vscode.Range(lineNum, paramStart, lineNum, paramStart + name.length),
            detail: `parameter ${name}`,
            functionName: functionName,
        };
        definitions.set(getSymbolKey(SymbolKind.LocalValue, name, functionName), def);
    }
}

function splitTopLevelParameters(paramsStr: string): { text: string; start: number }[] {
    const parameters: { text: string; start: number }[] = [];
    let start = 0;
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let angleDepth = 0;
    let inString = false;

    for (let i = 0; i < paramsStr.length; i++) {
        const char = paramsStr[i];

        if (inString) {
            if (char === '\\') {
                i++;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === '(') {
            parenDepth++;
        } else if (char === ')') {
            parenDepth = Math.max(0, parenDepth - 1);
        } else if (char === '{') {
            braceDepth++;
        } else if (char === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
        } else if (char === '[') {
            bracketDepth++;
        } else if (char === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
        } else if (char === '<') {
            angleDepth++;
        } else if (char === '>') {
            angleDepth = Math.max(0, angleDepth - 1);
        } else if (
            char === ',' &&
            parenDepth === 0 &&
            braceDepth === 0 &&
            bracketDepth === 0 &&
            angleDepth === 0
        ) {
            parameters.push({ text: paramsStr.substring(start, i), start });
            start = i + 1;
        }
    }

    parameters.push({ text: paramsStr.substring(start), start });
    return parameters;
}

function getParameterNameMatch(parameter: string): RegExpExecArray | null {
    const regex = localRegex('g');
    let match: RegExpExecArray | null;
    let lastMatch: RegExpExecArray | null = null;

    while ((match = regex.exec(parameter)) !== null) {
        lastMatch = match;
    }

    if (!lastMatch) {
        return null;
    }

    const afterName = parameter.substring(lastMatch.index + lastMatch[0].length).trim();
    return /^[*)\]}>]/.test(afterName) ? null : lastMatch;
}

/**
 * Parse references from a line
 */
function parseReferences(
    line: string,
    lineNum: number,
    references: SymbolReference[],
    referencesByKey: Map<string, SymbolReference[]>,
    currentFunction: string | null
): void {
    const codePart = getReferenceCode(line);

    // Global references: @name, @"name", @0
    const globalRefRegex = globalRegex('g');
    let match;
    while ((match = globalRefRegex.exec(codePart)) !== null) {
        const fullName = match[0];
        addReference(references, referencesByKey, {
            name: fullName,
            kind: SymbolKind.GlobalValue,
            range: new vscode.Range(lineNum, match.index, lineNum, match.index + fullName.length),
        });
    }

    // Local references: %name, %"name", %0
    const localRefRegex = localRegex('g');
    while ((match = localRefRegex.exec(codePart)) !== null) {
        const fullName = match[0];
        addReference(references, referencesByKey, {
            name: fullName,
            kind: SymbolKind.LocalValue,
            range: new vscode.Range(lineNum, match.index, lineNum, match.index + fullName.length),
            functionName: currentFunction || undefined,
        });
    }

    // Label references in branch instructions: label %labelname or br ... label %name
    const labelRefRegex = new RegExp(`\\blabel\\s+%(${LABEL_NAME_PATTERN})`, 'g');
    while ((match = labelRefRegex.exec(codePart)) !== null) {
        const labelName = match[1];
        const fullMatch = match[0];
        const nameStart = match.index + fullMatch.lastIndexOf('%') + 1;
        addReference(references, referencesByKey, {
            name: labelName,
            kind: SymbolKind.Label,
            range: new vscode.Range(lineNum, nameStart, lineNum, nameStart + labelName.length),
            functionName: currentFunction || undefined,
        });
    }

    // Metadata references: !name, !0
    const metadataRefRegex = metadataRegex('g');
    while ((match = metadataRefRegex.exec(codePart)) !== null) {
        // Skip if it's a definition (has = after it)
        const afterMatch = codePart.substring(match.index + match[0].length).trim();
        if (afterMatch.startsWith('=')) {
            continue;
        }
        addReference(references, referencesByKey, {
            name: match[0],
            kind: SymbolKind.Metadata,
            range: new vscode.Range(lineNum, match.index, lineNum, match.index + match[0].length),
        });
    }

    // Attribute group references: #0
    const attrRegex = attributeGroupRegex('g');
    while ((match = attrRegex.exec(codePart)) !== null) {
        const fullName = match[0];
        addReference(references, referencesByKey, {
            name: fullName,
            kind: SymbolKind.AttributeGroup,
            range: new vscode.Range(lineNum, match.index, lineNum, match.index + fullName.length),
        });
    }

    // Comdat references: comdat($name)
    const comdatRefRegex = new RegExp(`comdat\\s*\\((${COMDAT_NAME_PATTERN})\\)`, 'g');
    while ((match = comdatRefRegex.exec(codePart)) !== null) {
        const name = match[1];
        const nameStart = match.index + match[0].indexOf(name);
        addReference(references, referencesByKey, {
            name,
            kind: SymbolKind.Comdat,
            range: new vscode.Range(lineNum, nameStart, lineNum, nameStart + name.length),
        });
    }
}

/**
 * Get the function containing a given position
 */
export function getFunctionAtPosition(
    parsed: ParsedDocument,
    position: vscode.Position
): string | undefined {
    const functionName = parsed.functionNameByLine[position.line];
    if (functionName) {
        return functionName;
    }

    for (const scope of parsed.functionScopes) {
        if (position.line >= scope.startLine && position.line <= scope.endLine) {
            return scope.name;
        }
    }
    return undefined;
}

/**
 * Get the symbol at a specific position
 */
export function getSymbolAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): SymbolAtPosition | null {
    const symbol = getRawSymbolAtPosition(document, position);
    if (!symbol) {
        return null;
    }

    if (symbol.kind !== SymbolKind.LocalValue && symbol.kind !== SymbolKind.Label) {
        return symbol;
    }

    const parsed = parseDocument(document);
    return {
        ...symbol,
        functionName: getFunctionAtPosition(parsed, position),
    };
}

/**
 * Get both the symbol and parsed document using a single parse on provider hot paths.
 */
export function getSymbolAndParsedDocument(
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken
): { symbol: SymbolAtPosition; parsed: ParsedDocument } | null {
    const rawSymbol = getRawSymbolAtPosition(document, position);
    if (!rawSymbol || token?.isCancellationRequested) {
        return null;
    }

    const parsed = parseDocument(document, token);
    if (token?.isCancellationRequested) {
        return null;
    }

    const symbol = (rawSymbol.kind === SymbolKind.LocalValue || rawSymbol.kind === SymbolKind.Label)
        ? { ...rawSymbol, functionName: getFunctionAtPosition(parsed, position) }
        : rawSymbol;

    return { symbol, parsed };
}

/**
 * Get the symbol token at a position without parsing the document.
 */
export function getRawSymbolAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
): SymbolAtPosition | null {
    const line = document.lineAt(position.line).text.replace(/\r$/, '');
    const codePart = getReferenceCode(line);
    const col = position.character;

    // Check for global identifier
    const globalMatch = matchAtPosition(codePart, col, globalRegex('g'));
    if (globalMatch) {
        return {
            name: globalMatch.match[0],
            kind: SymbolKind.GlobalValue,
            range: new vscode.Range(position.line, globalMatch.start, position.line, globalMatch.end),
        };
    }

    // Check for local identifier or type
    const localMatch = matchAtPosition(codePart, col, localRegex('g'));
    if (localMatch) {
        const name = localMatch.match[0];
        return {
            name,
            kind: SymbolKind.LocalValue,
            range: new vscode.Range(position.line, localMatch.start, position.line, localMatch.end),
        };
    }

    // Check for label (without prefix, at start of line)
    const labelDefMatch = line.match(new RegExp(`^(\\s*)(${LABEL_NAME_PATTERN}):`));
    if (labelDefMatch) {
        const indent = labelDefMatch[1].length;
        const name = labelDefMatch[2];
        if (col >= indent && col <= indent + name.length) {
            return {
                name,
                kind: SymbolKind.Label,
                range: new vscode.Range(position.line, indent, position.line, indent + name.length),
            };
        }
    }

    // Check for metadata
    const metadataMatch = matchAtPosition(codePart, col, metadataRegex('g'));
    if (metadataMatch) {
        return {
            name: metadataMatch.match[0],
            kind: SymbolKind.Metadata,
            range: new vscode.Range(position.line, metadataMatch.start, position.line, metadataMatch.end),
        };
    }

    // Check for attribute group
    const attrMatch = matchAtPosition(codePart, col, attributeGroupRegex('g'));
    if (attrMatch) {
        return {
            name: attrMatch.match[0],
            kind: SymbolKind.AttributeGroup,
            range: new vscode.Range(position.line, attrMatch.start, position.line, attrMatch.end),
        };
    }

    // Check for comdat
    const comdatMatch = matchAtPosition(codePart, col, comdatRegex('g'));
    if (comdatMatch) {
        return {
            name: comdatMatch.match[0],
            kind: SymbolKind.Comdat,
            range: new vscode.Range(position.line, comdatMatch.start, position.line, comdatMatch.end),
        };
    }

    return null;
}

/**
 * Resolve a cursor symbol to the definition kind used by providers.
 */
export function resolveSymbol(
    parsed: ParsedDocument,
    symbol: SymbolAtPosition
): ResolvedSymbol {
    const { definitions } = parsed;
    const { kind, name, functionName } = symbol;

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
 * Get references for a resolved symbol using the keyed reference index.
 */
export function getReferencesForSymbol(
    parsed: ParsedDocument,
    symbol: SymbolAtPosition,
    resolved: ResolvedSymbol = resolveSymbol(parsed, symbol)
): SymbolReference[] {
    const references: SymbolReference[] = [];

    const addIndexedReferences = (key: string): void => {
        const indexedReferences = parsed.referencesByKey.get(key);
        if (indexedReferences) {
            references.push(...indexedReferences);
        }
    };

    if (resolved.actualKind === SymbolKind.LocalValue && symbol.functionName) {
        addIndexedReferences(getSymbolKey(symbol.kind, symbol.name, symbol.functionName));
    } else if (resolved.actualKind === SymbolKind.Label && symbol.functionName) {
        if (symbol.kind === SymbolKind.Label) {
            addIndexedReferences(getSymbolKey(SymbolKind.Label, resolved.actualName, symbol.functionName));
            addIndexedReferences(getSymbolKey(SymbolKind.LocalValue, `%${resolved.actualName}`, symbol.functionName));
        } else {
            addIndexedReferences(getSymbolKey(symbol.kind, symbol.name, symbol.functionName));
        }
    } else {
        addIndexedReferences(getSymbolKey(symbol.kind, symbol.name));
    }

    return references;
}

/**
 * Helper to find a regex match at a specific column position
 */
function matchAtPosition(
    line: string,
    col: number,
    regex: RegExp
): { match: RegExpExecArray; start: number; end: number } | null {
    let match;
    while ((match = regex.exec(line)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        if (col >= start && col <= end) {
            return { match, start, end };
        }
    }
    return null;
}

/**
 * Extract content between balanced parentheses starting at a given position.
 * Handles nested parentheses like in "ptr addrspace(1) %name".
 * @param line The line to parse
 * @param startPos The position of the opening '('
 * @returns The content between the balanced parentheses, or null if not found
 */
function extractBalancedParentheses(line: string, startPos: number): string | null {
    if (line[startPos] !== '(') {
        return null;
    }

    let depth = 0;
    let start = startPos + 1; // Skip the opening '('

    for (let i = startPos; i < line.length; i++) {
        const char = line[i];
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) {
                return line.substring(start, i);
            }
        }
    }

    return null; // No matching closing parenthesis found
}

/**
 * Convert SymbolKind to vscode.SymbolKind for document symbols
 */
export function toVSCodeSymbolKind(kind: SymbolKind): vscode.SymbolKind {
    switch (kind) {
        case SymbolKind.Function:
            return vscode.SymbolKind.Function;
        case SymbolKind.GlobalValue:
            return vscode.SymbolKind.Variable;
        case SymbolKind.LocalValue:
            return vscode.SymbolKind.Variable;
        case SymbolKind.NamedType:
            return vscode.SymbolKind.Struct;
        case SymbolKind.Label:
            return vscode.SymbolKind.Key;
        case SymbolKind.Metadata:
            return vscode.SymbolKind.Property;
        case SymbolKind.AttributeGroup:
            return vscode.SymbolKind.Constant;
        case SymbolKind.Comdat:
            return vscode.SymbolKind.Module;
        default:
            return vscode.SymbolKind.Variable;
    }
}

/**
 * Clear the cache for a document
 */
export function clearCache(uri: vscode.Uri): void {
    documentCache.delete(uri.toString());
}

/**
 * Clear all cached data
 */
export function clearAllCache(): void {
    documentCache.clear();
}
