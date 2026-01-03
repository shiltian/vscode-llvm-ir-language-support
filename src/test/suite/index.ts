/**
 * Test suite runner for integration tests.
 * This is loaded by VS Code and runs the Mocha test suite.
 */

import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'bdd',
        color: true,
        timeout: 60000, // 60 second timeout for integration tests
    });

    const testsRoot = path.resolve(__dirname, '.');

    // Find all test files
    const files = await glob('**/*.test.js', { cwd: testsRoot });

    // Add files to the test suite
    for (const f of files) {
        mocha.addFile(path.resolve(testsRoot, f));
    }

    // Run the mocha tests
    return new Promise<void>((resolve, reject) => {
        mocha.run((failures: number) => {
            if (failures > 0) {
                reject(new Error(`${failures} tests failed.`));
            } else {
                resolve();
            }
        });
    });
}

