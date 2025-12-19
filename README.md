# VSCode LLVM IR Language Support

Syntax highlighting and language support for LLVM IR files (`.ll`).

## Features

- **Syntax Highlighting** - Theme-agnostic, works with light and dark themes
- **Go to Definition** (`F12` / `Ctrl+Click`)
- **Find All References** (`Shift+F12`)
- **Document Symbols** (`Ctrl+Shift+O`)
- **Hover Information**

### Supported Symbols

| Symbol | Prefix | Example |
|--------|--------|---------|
| Local values | `%` | `%result`, `%0` |
| Global values | `@` | `@global_var`, `@0` |
| Functions | `@` | `@main` |
| Labels | — | `entry:` |
| Named types | `%` | `%struct.Point` |
| Metadata | `!` | `!dbg`, `!0` |
| Attribute groups | `#` | `#0` |

## Installation

### From VSIX

```bash
npm install && npm run compile
npx vsce package
```

Then install via **Extensions → ... → Install from VSIX...**

### Development

```bash
npm install
npm run compile
```

Press `F5` to launch Extension Development Host.

## License

MIT
