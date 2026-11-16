import { basename, dirname, join } from 'node:path'

import { Effect, FileSystem } from 'effect'

// A file written beside its target then renamed over it: a reader never sees half of it. With
// `mode` (and `dirMode`), the file (and its directory) get it whatever the umask: a secret's 0600
export const writeAtomic = (
  fs: FileSystem.FileSystem,
  path: string,
  data: string | Uint8Array,
  options: { readonly mode?: number; readonly dirMode?: number } = {}
) =>
  Effect.gen(function* () {
    const directory = dirname(path)
    const partial = join(directory, `.${basename(path)}.partial`)
    yield* fs.makeDirectory(directory, {
      recursive: true,
      ...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
    })
    if (options.dirMode !== undefined) yield* fs.chmod(directory, options.dirMode)
    const mode = options.mode === undefined ? {} : { mode: options.mode }
    if (data instanceof Uint8Array) yield* fs.writeFile(partial, data, mode)
    else yield* fs.writeFileString(partial, data, mode)
    if (options.mode !== undefined) yield* fs.chmod(partial, options.mode)
    yield* fs.rename(partial, path)
  })
