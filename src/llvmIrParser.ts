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
    functionScopes: FunctionScope[];
}

/**
 * Cache for parsed documents
 */
const documentCache = new Map<string, { version: number; parsed: ParsedDocument }>();

/**
 * Get the symbol key for lookups (combines kind, name, and optionally function scope)
 */
export function getSymbolKey(kind: SymbolKind, name: string, functionName?: string): string {
    if (functionName && (kind === SymbolKind.LocalValue || kind === SymbolKind.Label)) {
        return `${kind}:${functionName}:${name}`;
    }
    return `${kind}:${name}`;
}

/**
 * Parse a document and extract all definitions and references
 */
export function parseDocument(document: vscode.TextDocument): ParsedDocument {
    const cached = documentCache.get(document.uri.toString());
    if (cached && cached.version === document.version) {
        return cached.parsed;
    }

    const definitions = new Map<string, SymbolDefinition>();
    const references: SymbolReference[] = [];
    const functionScopes: FunctionScope[] = [];
    const text = document.getText();
    const lines = text.split('\n');

    // First pass: find all function boundaries
    let currentFunction: string | null = null;
    let functionStartLine = -1;
    let braceDepth = 0;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const trimmedLine = line.trim();

        // Skip empty lines and comments for function detection
        if (trimmedLine === '' || trimmedLine.startsWith(';')) {
            continue;
        }

        // Function definition start: define ... @name(...) ... {
        const funcMatch = line.match(/^\s*define\s+.*?@([-a-zA-Z$._][-a-zA-Z$._0-9]*|"[^"]+"|[0-9]+)\s*\(/);
        if (funcMatch && currentFunction === null) {
            currentFunction = '@' + funcMatch[1];
            functionStartLine = lineNum;
            braceDepth = 0; // Will be counted below
        }

        // Track braces for function body
        if (currentFunction !== null) {
            // Count braces (simple approach, doesn't handle braces in strings/comments perfectly)
            for (const char of line) {
                if (char === '{') braceDepth++;
                else if (char === '}') braceDepth--;
            }

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

    // Second pass: parse definitions and references with function scope awareness
    currentFunction = null;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum];
        const trimmedLine = line.trim();

        // Determine current function scope
        currentFunction = null;
        for (const scope of functionScopes) {
            if (lineNum >= scope.startLine && lineNum <= scope.endLine) {
                currentFunction = scope.name;
                break;
            }
        }

        // Skip empty lines and comments
        if (trimmedLine === '' || trimmedLine.startsWith(';')) {
            continue;
        }

        // Parse definitions
        parseDefinitions(line, lineNum, definitions, currentFunction, functionScopes);

        // Parse references
        parseReferences(line, lineNum, references, currentFunction);
    }

    const parsed = { definitions, references, functionScopes };
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
    const typeMatch = line.match(/^\s*(%[-a-zA-Z$._][-a-zA-Z$._0-9]*|%"[^"]+")\s*=\s*type\b/);
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
    const globalVarMatch = line.match(/^\s*(@[-a-zA-Z$._][-a-zA-Z$._0-9]*|@"[^"]+"|@[0-9]+)\s*=/);
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
    const aliasMatch = line.match(/^\s*(@[-a-zA-Z$._][-a-zA-Z$._0-9]*|@"[^"]+"|@[0-9]+)\s*=.*\balias\b/);
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

    // Function definition: define ... @name(...)
    const funcDefMatch = line.match(/^\s*define\s+.*?(@[-a-zA-Z$._][-a-zA-Z$._0-9]*|@"[^"]+"|@[0-9]+)\s*\(/);
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
        const paramsMatch = line.match(/\(([^)]*)\)/);
        if (paramsMatch) {
            parseParameters(paramsMatch[1], lineNum, line, definitions, name);
        }
    }

    // Function declaration: declare ... @name(...)
    const funcDeclMatch = line.match(/^\s*declare\s+.*?(@[-a-zA-Z$._][-a-zA-Z$._0-9]*|@"[^"]+"|@[0-9]+)\s*\(/);
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
        const localMatch = line.match(/^\s*(%[-a-zA-Z$._][-a-zA-Z$._0-9]*|%"[^"]+"|%[0-9]+)\s*=/);
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
        const labelMatch = line.match(/^([-a-zA-Z$._][-a-zA-Z$._0-9]*|[0-9]+|"[^"]+"):\s*(;.*)?$/);
        if (labelMatch) {
            const name = labelMatch[1];
            const def: SymbolDefinition = {
                name,
                kind: SymbolKind.Label,
                range: new vscode.Range(lineNum, 0, lineNum, line.length),
                selectionRange: new vscode.Range(lineNum, 0, lineNum, name.length),
                detail: `label ${name}`,
                functionName: currentFunction,
            };
            definitions.set(getSymbolKey(SymbolKind.Label, name, currentFunction), def);
        }
    }

    // Metadata definition: !name = ... or !0 = ...
    const metadataMatch = line.match(/^\s*(![a-zA-Z_][a-zA-Z0-9_]*|![0-9]+)\s*=/);
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
    const attrMatch = line.match(/^\s*attributes\s+(#[0-9]+)\s*=/);
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
    const comdatMatch = line.match(/^\s*(\$[-a-zA-Z$._][-a-zA-Z$._0-9]*|\$"[^"]+")\s*=\s*comdat\b/);
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
    // Match parameters like: i32 %argc, ptr %argv
    const paramRegex = /(%[-a-zA-Z$._][-a-zA-Z$._0-9]*|%"[^"]+"|%[0-9]+)/g;
    let match;
    while ((match = paramRegex.exec(paramsStr)) !== null) {
        const name = match[1];
        const paramStart = fullLine.indexOf(paramsStr) + match.index;
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

/**
 * Parse references from a line
 */
function parseReferences(
    line: string,
    lineNum: number,
    references: SymbolReference[],
    currentFunction: string | null
): void {
    // Skip comment-only lines
    const commentStart = line.indexOf(';');
    const codePart = commentStart >= 0 ? line.substring(0, commentStart) : line;

    // Global references: @name, @"name", @0
    const globalRegex = /@([-a-zA-Z$._][-a-zA-Z$._0-9]*|"[^"]+"|[0-9]+)/g;
    let match;
    while ((match = globalRegex.exec(codePart)) !== null) {
        const fullName = '@' + match[1];
        references.push({
            name: fullName,
            kind: SymbolKind.GlobalValue,
            range: new vscode.Range(lineNum, match.index, lineNum, match.index + fullName.length),
        });
    }

    // Local references: %name, %"name", %0
    const localRegex = /%([-a-zA-Z$._][-a-zA-Z$._0-9]*|"[^"]+"|[0-9]+)/g;
    while ((match = localRegex.exec(codePart)) !== null) {
        const fullName = '%' + match[1];
        references.push({
            name: fullName,
            kind: SymbolKind.LocalValue,
            range: new vscode.Range(lineNum, match.index, lineNum, match.index + fullName.length),
            functionName: currentFunction || undefined,
        });
    }

    // Label references in branch instructions: label %labelname or br ... label %name
    const labelRefRegex = /\blabel\s+%([-a-zA-Z$._][-a-zA-Z$._0-9]*|"[^"]+"|[0-9]+)/g;
    while ((match = labelRefRegex.exec(codePart)) !== null) {
        const labelName = match[1];
        const fullMatch = match[0];
        const nameStart = match.index + fullMatch.lastIndexOf('%') + 1;
        references.push({
            name: labelName,
            kind: SymbolKind.Label,
            range: new vscode.Range(lineNum, nameStart, lineNum, nameStart + labelName.length),
            functionName: currentFunction || undefined,
        });
    }

    // Metadata references: !name, !0
    const metadataRegex = /(!(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))(?![a-zA-Z0-9_])/g;
    while ((match = metadataRegex.exec(codePart)) !== null) {
        // Skip if it's a definition (has = after it)
        const afterMatch = codePart.substring(match.index + match[1].length).trim();
        if (afterMatch.startsWith('=')) {
            continue;
        }
        references.push({
            name: match[1],
            kind: SymbolKind.Metadata,
            range: new vscode.Range(lineNum, match.index, lineNum, match.index + match[1].length),
        });
    }

    // Attribute group references: #0
    const attrRegex = /#([0-9]+)/g;
    while ((match = attrRegex.exec(codePart)) !== null) {
        const fullName = '#' + match[1];
        references.push({
            name: fullName,
            kind: SymbolKind.AttributeGroup,
            range: new vscode.Range(lineNum, match.index, lineNum, match.index + fullName.length),
        });
    }

    // Comdat references: comdat($name)
    const comdatRefRegex = /comdat\s*\((\$[-a-zA-Z$._][-a-zA-Z$._0-9]*|\$"[^"]+")\)/g;
    while ((match = comdatRefRegex.exec(codePart)) !== null) {
        const name = match[1];
        const nameStart = match.index + match[0].indexOf(name);
        references.push({
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
): { name: string; kind: SymbolKind; range: vscode.Range; functionName?: string } | null {
    const parsed = parseDocument(document);
    const currentFunction = getFunctionAtPosition(parsed, position);
    const line = document.lineAt(position.line).text;
    const col = position.character;

    // Check for global identifier
    const globalMatch = matchAtPosition(line, col, /@([-a-zA-Z$._][-a-zA-Z$._0-9]*|"[^"]+"|[0-9]+)/g);
    if (globalMatch) {
        return {
            name: '@' + globalMatch.match[1],
            kind: SymbolKind.GlobalValue,
            range: new vscode.Range(position.line, globalMatch.start, position.line, globalMatch.end),
        };
    }

    // Check for local identifier or type
    const localMatch = matchAtPosition(line, col, /%([-a-zA-Z$._][-a-zA-Z$._0-9]*|"[^"]+"|[0-9]+)/g);
    if (localMatch) {
        const name = '%' + localMatch.match[1];
        return {
            name,
            kind: SymbolKind.LocalValue,
            range: new vscode.Range(position.line, localMatch.start, position.line, localMatch.end),
            functionName: currentFunction,
        };
    }

    // Check for label (without prefix, at start of line)
    const labelDefMatch = line.match(/^([-a-zA-Z$._][-a-zA-Z$._0-9]*|[0-9]+|"[^"]+"):/);
    if (labelDefMatch && col <= labelDefMatch[1].length) {
        return {
            name: labelDefMatch[1],
            kind: SymbolKind.Label,
            range: new vscode.Range(position.line, 0, position.line, labelDefMatch[1].length),
            functionName: currentFunction,
        };
    }

    // Check for metadata
    const metadataMatch = matchAtPosition(line, col, /!([a-zA-Z_][a-zA-Z0-9_]*|[0-9]+)/g);
    if (metadataMatch) {
        return {
            name: '!' + metadataMatch.match[1],
            kind: SymbolKind.Metadata,
            range: new vscode.Range(position.line, metadataMatch.start, position.line, metadataMatch.end),
        };
    }

    // Check for attribute group
    const attrMatch = matchAtPosition(line, col, /#([0-9]+)/g);
    if (attrMatch) {
        return {
            name: '#' + attrMatch.match[1],
            kind: SymbolKind.AttributeGroup,
            range: new vscode.Range(position.line, attrMatch.start, position.line, attrMatch.end),
        };
    }

    // Check for comdat
    const comdatMatch = matchAtPosition(line, col, /\$[-a-zA-Z$._][-a-zA-Z$._0-9]*|\$"[^"]+"/g);
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
