import path from 'path';
import pkgUp from 'pkg-up';
import { getRequestFilePath } from '@web/dev-server-core';
import { getChunkOptions } from '@chialab/esbuild-plugin-emit';
import { getEntryConfig } from '@chialab/rna-config-loader';
import { browserResolve, isCore, isJs, isJson, isCss, fsResolve, getSearchParam, appendSearchParam, removeSearchParam, getSearchParams } from '@chialab/node-resolve';
import { isHelperImport, isOutsideRootDir, resolveRelativeImport } from '@chialab/wds-plugin-node-resolve';
import { transform, transformLoaders, loadPlugins, loadTransformPlugins, build } from '@chialab/rna-bundler';
import { realpath } from 'fs/promises';

/**
 * @typedef {import('@web/dev-server-core').Plugin} Plugin
 */

/**
 * @param {string} url
 */
export function isFileRequest(url) {
    return ['file', 'chunk'].includes(getSearchParam(url, 'emit') || '') || getSearchParam(url, 'loader') === 'file';
}

/**
 * @param {string} url
 */
export function isCssModuleRequest(url) {
    return getSearchParam(url, 'loader') === 'css';
}

/**
 * @param {string} url
 */
export function isJsonModuleRequest(url) {
    return getSearchParam(url, 'loader') === 'json';
}

/**
 * @param {string} source
 */
export function appendCssModuleParam(source) {
    return appendSearchParam(source, 'loader', 'css');
}

/**
 * @param {string} source
 */
export function appendJsonModuleParam(source) {
    return appendSearchParam(source, 'loader', 'json');
}

/**
 * @param {string} source
 */
export function appendFileParam(source) {
    return appendSearchParam(source, 'loader', 'file');
}

/**
 * @param {string} source
 */
export function convertCssToJsModule(source) {
    source = removeSearchParam(source, 'loader');
    return `var link = document.createElement('link');
link.rel = 'stylesheet';
link.href = '${source}';
document.head.appendChild(link);
`;
}

/**
 * @param {string} source
 */
export function convertFileToJsModule(source) {
    source = removeSearchParam(source, 'emit');
    source = removeSearchParam(source, 'loader');
    return `export default new URL('${source}', import.meta.url).href;`;
}

/**
 * @param {import('koa').Context} context
 */
export function getRequestLoader(context) {
    const fileExtension = path.posix.extname(context.path);
    return transformLoaders[fileExtension];
}

/**
 * @param {import('@chialab/rna-config-loader').Entrypoint} entrypoint
 * @param {import('@web/dev-server-core').DevServerCoreConfig} serverConfig
 * @param {Partial<import('@chialab/rna-config-loader').CoreTransformConfig>} config
 */
export async function createConfig(entrypoint, serverConfig, config) {
    const { rootDir } = serverConfig;
    const input = /** @type {string} */ (entrypoint.input);
    const filePath = path.resolve(rootDir, input);

    return getEntryConfig(entrypoint, {
        sourcemap: 'inline',
        target: 'es2020',
        platform: 'browser',
        jsxFactory: config.jsxFactory,
        jsxFragment: config.jsxFragment,
        jsxModule: config.jsxModule,
        jsxExport: config.jsxExport,
        alias: config.alias,
        plugins: [
            ...(await loadPlugins({
                postcss: {
                    async transform(importPath) {
                        if (isOutsideRootDir(importPath)) {
                            return;
                        }

                        return resolveRelativeImport(
                            await fsResolve(importPath, filePath),
                            filePath,
                            rootDir
                        );
                    },
                },
            })),
            ...(config.plugins || []),
        ],
        transformPlugins: [
            ...(await loadTransformPlugins({
                commonjs: {
                    ignore: async (specifier) => {
                        try {
                            await browserResolve(specifier, filePath);
                        } catch (err) {
                            return isCore(specifier);
                        }

                        return false;
                    },
                },
                worker: {
                    proxy: true,
                },
            })),
            ...(config.transformPlugins || []),
        ],
        logLevel: 'error',
    });
}

const VALID_MODULE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * @param {string} name
 */
function isBareModuleSource(name) {
    return VALID_MODULE_NAME.test(name);
}

/**
 * @param {Partial<import('@chialab/rna-config-loader').CoreTransformConfig>} config
 */
export function rnaPlugin(config) {
    /**
     * @type {import('@web/dev-server-core').DevServerCoreConfig}
     */
    let serverConfig;

    /**
     * @type {{ [key: string]: Promise<string> }}
     */
    const virtualFs = {};

    /**
     * @type {Plugin}
     */
    const plugin = {
        name: 'rna',

        async serverStart({ config }) {
            serverConfig = config;
        },

        resolveMimeType(context) {
            if (isJs(context.path) ||
                isJson(context.path) ||
                isCssModuleRequest(context.url) ||
                isFileRequest(context.url)) {
                return 'js';
            }
            if (isCss(context.path)) {
                return 'css';
            }
        },

        async serve(context) {
            if (isFileRequest(context.url)) {
                const { rootDir } = serverConfig;
                const { path: pathname, searchParams } = getSearchParams(context.url);
                const filePath = resolveRelativeImport(getRequestFilePath(pathname, rootDir), context.url, rootDir);
                return {
                    body: convertFileToJsModule(`${filePath}?${searchParams.toString()}`),
                    headers: {
                        'content-type': 'text/javascript',
                    },
                };
            }
            if (isCssModuleRequest(context.url)) {
                return {
                    body: convertCssToJsModule(context.url),
                    headers: {
                        'content-type': 'text/javascript',
                    },
                };
            }

            const { rootDir } = serverConfig;
            const filePath = getRequestFilePath(context.url, rootDir);
            if (filePath in virtualFs) {
                return {
                    body: await virtualFs[filePath],
                    transformCacheKey: false,
                };
            }
        },

        async transform(context) {
            if (isHelperImport(context.path)) {
                return;
            }

            if (isCssModuleRequest(context.url) ||
                isFileRequest(context.url)
            ) {
                // do not transpile to js module
                return;
            }

            const loader = getRequestLoader(context);
            if (!loader) {
                return;
            }

            if (loader === 'json' && !isJsonModuleRequest(context.url)) {
                // do not transpile to js module
                return;
            }

            const { rootDir } = serverConfig;
            const filePath = getRequestFilePath(context.url, rootDir);
            if (filePath in virtualFs) {
                return;
            }

            const contextConfig = getChunkOptions(context.url);

            /**
             * @type {import('@chialab/rna-config-loader').Entrypoint}
             */
            const entrypoint = {
                root: rootDir,
                input: `./${path.relative(rootDir, filePath)}`,
                code: /** @type {string} */ (context.body),
                loader,
                bundle: false,
                ...contextConfig,
            };

            const transformConfig = await createConfig(entrypoint, serverConfig, config);
            const { code } = await transform(transformConfig);
            return code;
        },

        async transformImport({ source }) {
            if (isJson(source)) {
                return appendJsonModuleParam(source);
            }

            if (isCss(source)) {
                return appendCssModuleParam(source);
            }

            if (!isJs(source)) {
                return appendFileParam(source);
            }
        },

        async resolveImport({ source, context }) {
            if (config.alias && config.alias[source]) {
                source = /** @type {string} */ (config.alias[source]);
            }

            if (!isBareModuleSource(source)) {
                return;
            }

            const { rootDir } = serverConfig;
            const filePath = getRequestFilePath(context.url, rootDir);
            const resolved = await browserResolve(source, filePath).catch(() => null);
            if (!resolved) {
                return;
            }

            const realPath = await realpath(resolved);
            if (realPath !== resolved) {
                // ignore symlinked files
                return;
            }

            if (resolved in virtualFs) {
                return resolveRelativeImport(resolved, filePath, rootDir);
            }

            const modulePackageFile = await pkgUp({ cwd: resolved });
            const moduleRootDir = modulePackageFile ? path.dirname(modulePackageFile) : rootDir;

            /**
             * @type {import('@chialab/rna-config-loader').Entrypoint}
             */
            const entrypoint = {
                root: moduleRootDir,
                input: `./${path.relative(moduleRootDir, resolved)}`,
                loader: getRequestLoader(context),
                bundle: false,
            };

            virtualFs[resolved] = createConfig(entrypoint, serverConfig, config)
                .then((transformConfig) =>
                    build({
                        ...transformConfig,
                        chunkNames: '[name]-[hash]',
                        output: resolved,
                        jsxModule: undefined,
                        write: false,
                    })
                ).then((result) => {
                    if (!result.outputFiles) {
                        throw new Error('Failed to bundle dependency');
                    }
                    result.outputFiles.forEach(({ path, text }) => {
                        virtualFs[path] = Promise.resolve(text);
                    });

                    return virtualFs[resolved];
                });

            return resolveRelativeImport(resolved, filePath, rootDir);
        },
    };

    return plugin;
}
