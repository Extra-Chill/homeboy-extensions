import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const runtimePackageDir = process.env.HOMEBOY_NODEJS_PLAYWRIGHT_RUNTIME_PACKAGE_DIR;

export async function resolve(specifier, context, nextResolve) {
    if (specifier !== 'playwright' && !specifier.startsWith('playwright/')) {
        return nextResolve(specifier, context);
    }

    if (!runtimePackageDir) throw new Error('HOMEBOY_NODEJS_PLAYWRIGHT_RUNTIME_PACKAGE_DIR is required.');
    const require = createRequire(`${runtimePackageDir}/package.json`);
    return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
}
