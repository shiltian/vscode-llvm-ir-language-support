/**
 * Test setup file - mocks the vscode module before any tests run.
 * This is a CommonJS module that patches require() to mock vscode.
 */

const Module = require('module');

// Store the original require function
const originalRequire = Module.prototype.require;

// Position class
class MockPosition {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }

    isEqual(other) {
        return this.line === other.line && this.character === other.character;
    }

    isBefore(other) {
        if (this.line < other.line) return true;
        if (this.line === other.line && this.character < other.character) return true;
        return false;
    }

    isAfter(other) {
        if (this.line > other.line) return true;
        if (this.line === other.line && this.character > other.character) return true;
        return false;
    }

    translate(lineDelta = 0, characterDelta = 0) {
        return new MockPosition(this.line + lineDelta, this.character + characterDelta);
    }

    with(line, character) {
        return new MockPosition(line ?? this.line, character ?? this.character);
    }
}

// Range class
class MockRange {
    constructor(startOrStartLine, endOrStartCharacter, endLine, endCharacter) {
        if (typeof startOrStartLine === 'number') {
            this.start = new MockPosition(startOrStartLine, endOrStartCharacter);
            this.end = new MockPosition(endLine, endCharacter);
        } else {
            this.start = startOrStartLine;
            this.end = endOrStartCharacter;
        }
    }

    get isEmpty() {
        return this.start.isEqual(this.end);
    }

    get isSingleLine() {
        return this.start.line === this.end.line;
    }

    contains(positionOrRange) {
        if (positionOrRange.line !== undefined && positionOrRange.character !== undefined && !positionOrRange.start) {
            const pos = positionOrRange;
            if (pos.line < this.start.line || pos.line > this.end.line) return false;
            if (pos.line === this.start.line && pos.character < this.start.character) return false;
            if (pos.line === this.end.line && pos.character > this.end.character) return false;
            return true;
        }
        return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
}

// Location class
class MockLocation {
    constructor(uri, range) {
        this.uri = uri;
        this.range = range;
    }
}

// DocumentHighlight class
class MockDocumentHighlight {
    constructor(range, kind) {
        this.range = range;
        this.kind = kind;
    }
}

// Mock vscode module
const vscodeMock = {
    Range: MockRange,
    Position: MockPosition,
    Location: MockLocation,
    DocumentHighlight: MockDocumentHighlight,

    Uri: {
        file: (fsPath) => ({
            scheme: 'file',
            authority: '',
            path: fsPath,
            query: '',
            fragment: '',
            fsPath,
            toString: () => `file://${fsPath}`,
        }),
        parse: (value) => ({
            scheme: 'file',
            authority: '',
            path: value,
            query: '',
            fragment: '',
            fsPath: value,
            toString: () => value,
        }),
    },

    SymbolKind: {
        File: 0,
        Module: 1,
        Namespace: 2,
        Package: 3,
        Class: 4,
        Method: 5,
        Property: 6,
        Field: 7,
        Constructor: 8,
        Enum: 9,
        Interface: 10,
        Function: 11,
        Variable: 12,
        Constant: 13,
        String: 14,
        Number: 15,
        Boolean: 16,
        Array: 17,
        Object: 18,
        Key: 19,
        Null: 20,
        EnumMember: 21,
        Struct: 22,
        Event: 23,
        Operator: 24,
        TypeParameter: 25,
    },

    DocumentHighlightKind: {
        Text: 0,
        Read: 1,
        Write: 2,
    },
};

// Override require to intercept vscode imports
Module.prototype.require = function(id) {
    if (id === 'vscode') {
        return vscodeMock;
    }
    return originalRequire.apply(this, arguments);
};

// Export the mock for direct use in tests
module.exports = { vscodeMock };

