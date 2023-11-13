import { ExecutorContext } from '@nx/devkit';
import { convertNxExecutor } from '@nx/devkit';
import {
  DevServerBuilderOutput,
  buildApplication,
} from '@angular-devkit/build-angular';
import { createBuilderContext } from 'nx/src/adapter/ngcli-adapter';

import { DevServerExecutorSchema } from './schema';
import path = require('path');
import { buildApplicationInternal } from '@angular-devkit/build-angular/src/builders/application';
import { InlineStyleLanguage } from '@angular-devkit/build-angular/src/builders/application/schema';
import { Plugin, UserConfig, normalizePath, ViteDevServer } from 'vite';
import { AddressInfo } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { BuildOutputFile } from '@angular-devkit/build-angular/src/tools/esbuild/bundler-context';

export default async function* runExecutor(
  options: DevServerExecutorSchema,
  context: ExecutorContext
) {
  console.log('Executor ran for DevServer', context.root);

  const builderContext = await createBuilderContext(
    {
      builderName: '@angular-devkit/build-angular:application',
      description: 'Build a browser application',
      optionSchema: await import(
        '@angular-devkit/build-angular/src/builders/application/schema.json'
      ),
    },
    context
  );
  let listeningAddress: AddressInfo | undefined;
  let server: ViteDevServer;
  let virtualProjectRoot = normalizePath(
    join(builderContext.workspaceRoot, `.analog/vite-root`, 'analog-app')
  );
  const { createServer } = await import('vite');
  const fg = require('fast-glob');
  const root = normalizePath(resolve(process.cwd(), 'apps/analog-app'));

  const endpointFiles: string[] = fg.sync(
    [`${root}/src/app/pages/**/*.page.ts`],
    { dot: true }
  );
  const outputFiles = new Map<string, BuildOutputFile>();
  let config: UserConfig;

  for await (const result of buildApplicationInternal(
    {
      aot: true,
      entryPoints: new Set([
        'apps/analog-app/src/main.ts',
        'apps/analog-app/src/main.server.ts',
        ...endpointFiles,
      ]),
      // browser: 'apps/analog-app/src/main.ts',
      index: false,
      // server: 'apps/analog-app/src/main.server.ts',
      outputPath: 'dist/apps/analog-app/client',
      tsConfig: 'apps/analog-app/tsconfig.app.json',
      progress: false,
      watch: true,
      optimization: false,
      inlineStyleLanguage: InlineStyleLanguage.Scss,
    },
    builderContext,
    { write: false }
  )) {
    console.log('result', result.success);
    if (result.success && Array.isArray(result.outputFiles)) {
      for (const file of result.outputFiles) {
        const ofile = join(virtualProjectRoot, file.path);
        // console.log('file', ofile);
        outputFiles.set(ofile, file);
      }
    }
    if (server) {
      server.ws.send({
        type: 'full-reload',
        path: '*',
      });
    } else {
      server = await createServer({
        server: {
          port: 3000,
        },
        root: 'apps/analog-app',
        plugins: [
          {
            name: 'angular',
            enforce: 'pre',
            transformIndexHtml(html) {
              return html.replace('/src/main.ts', 'main.js');
            },
            async resolveId(source, importer) {
              if (source === '/src/main.ts') {
                return join(virtualProjectRoot, 'main.js');
              }

              if (source === 'src/main.server.ts') {
                return join(virtualProjectRoot, 'main.server.js');
              }

              if (
                importer &&
                source[0] === '.' &&
                importer.startsWith(virtualProjectRoot)
              ) {
                // Remove query if present
                const [importerFile] = importer.split('?', 1);

                source =
                  '/' +
                  normalizePath(
                    join(
                      dirname(relative(virtualProjectRoot, importerFile)),
                      source
                    )
                  );
              }

              const [file] = source.split('?', 1);
              if (outputFiles.has(join(virtualProjectRoot, file))) {
                return join(virtualProjectRoot, source);
              }

              if (file.endsWith('page.ts')) {
                const page = file
                  .split('/')
                  .pop()
                  ?.replace('.page.ts', '.page.js') as string;
                if (outputFiles.has(join(virtualProjectRoot, page))) {
                  return join(virtualProjectRoot, page);
                }
              }
              // console.log('source', source);
              return undefined;
            },
            load(id) {
              // console.log('load', id);
              let [file] = id.split('?', 1);
              file = file.replace('.ts', '.js');
              let relativeFile = file;

              if (file === '/main.js') {
                relativeFile = join(virtualProjectRoot, '/main.js');
              }

              if (file === 'src/main.server.js') {
                relativeFile = join(virtualProjectRoot, '/main.server.js');
              }

              const codeContents = outputFiles.get(relativeFile)?.contents;
              if (codeContents === undefined) {
                // console.log('no contents', relativeFile);
                return;
              }

              const code = Buffer.from(codeContents).toString('utf-8');
              const mapContents = outputFiles.get(
                relativeFile + '.map'
              )?.contents;

              return {
                // Remove source map URL comments from the code if a sourcemap is present.
                // Vite will inline and add an additional sourcemap URL for the sourcemap.
                code: mapContents
                  ? code.replace(/^\/\/# sourceMappingURL=[^\r\n]*/gm, '')
                  : code,
                map: mapContents && Buffer.from(mapContents).toString('utf-8'),
              };
            },
          },
        ],
      });

      await server.listen();
      listeningAddress = server.httpServer?.address() as AddressInfo;

      // log connection information
      server.printUrls();

      // TODO: adjust output typings to reflect both development servers
      yield {
        success: true,
        port: listeningAddress?.port,
      } as unknown as DevServerBuilderOutput;
    }

    if (server) {
      let deferred: () => void;
      builderContext.addTeardown(async () => {
        await server?.close();
        deferred?.();
      });
      await new Promise<void>((resolve) => (deferred = resolve));
    }
  }
}