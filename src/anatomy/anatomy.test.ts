import { expect, layer } from '@effect/vitest'
import { Effect, Exit, Layer, Option } from 'effect'
import { describe, it } from 'vitest'

import { anatomyCatalog, put, testLayer } from '../../test/fixtures.ts'
import { Storage } from '../ingest.ts'

import { Anatomy, anatomyFile, anatomyResponse, readableCatalog } from './anatomy.ts'

describe('the anatomy files', () => {
  it('serves only its two files, whatever the name asked', () => {
    expect(anatomyFile('runner.glb')).toBe('runner.glb')
    expect(anatomyFile('structures.json')).toBe('structures.json')
    for (const name of [
      '../garmin.db',
      '../../session/password',
      'runner.glb/..',
      '%2e%2e%2fgarmin.db',
      'RUNNER.GLB',
      'runner.glb ',
      '__proto__',
      'constructor',
      'toString',
      '',
    ]) {
      expect(anatomyFile(name), name).toBeNull()
    }
  })

  it('answers a file, then 304 for the copy the browser has, every answer revalidated', async () => {
    const bytes = new Uint8Array([103, 108, 84, 70])
    const found = anatomyResponse({
      _tag: 'Found',
      etag: '"4-1"',
      type: 'model/gltf-binary',
      bytes,
    })
    expect(found.status).toBe(200)
    expect(Object.fromEntries(found.headers)).toMatchObject({
      'content-type': 'model/gltf-binary',
      etag: '"4-1"',
      'cache-control': 'private, no-cache',
    })
    expect(new Uint8Array(await found.arrayBuffer())).toEqual(bytes)
    const same = anatomyResponse({ _tag: 'NotModified', etag: '"4-1"' })
    expect(same.status).toBe(304)
    expect(same.headers.get('etag')).toBe('"4-1"')
    expect(same.headers.get('cache-control')).toBe('private, no-cache')
    expect(anatomyResponse({ _tag: 'Missing' }).status).toBe(404)
    expect(anatomyResponse({ _tag: 'Broken', message: 'kind' }).status).toBe(500)
  })
})

layer(testLayer(Anatomy.layer.pipe(Layer.provideMerge(Storage))), { excludeTestServices: true })(
  'Anatomy',
  (it) => {
    it.effect('reads the catalog: none without the model, refused when unreadable', () =>
      Effect.gen(function* () {
        const anatomy = yield* Anatomy
        expect(yield* anatomy.catalog).toEqual(Option.none())
        expect(yield* readableCatalog(anatomy)).toBeNull()

        yield* put('anatomy/structures.json', '{"vastus_lateralis_r": {"kind": "organ"}}')
        const broken = yield* anatomy.catalog.pipe(Effect.exit)
        expect(Exit.isFailure(broken) && JSON.stringify(broken.cause)).toMatch(/CatalogBroken/u)
        expect(yield* readableCatalog(anatomy)).toBeNull()

        yield* put('anatomy/structures.json', anatomyCatalog)
        const catalog = Option.getOrThrow(yield* anatomy.catalog)
        expect(catalog['vastus_lateralis_r']?.french).toBe('vaste latéral (quadriceps)')
        // The asset's extra keys are not the catalog's
        expect(catalog['vastus_lateralis_r']).not.toHaveProperty('source')
        expect(yield* readableCatalog(anatomy)).toEqual(catalog)
      })
    )

    it.effect('reads a file once per version: its ETag, then not modified', () =>
      Effect.gen(function* () {
        const anatomy = yield* Anatomy
        expect(yield* anatomy.file('runner.glb', null)).toEqual({ _tag: 'Missing' })
        yield* put('anatomy/runner.glb', new Uint8Array([103, 108, 84, 70]))
        const found = yield* anatomy.file('runner.glb', null)
        if (found._tag !== 'Found') throw new Error(`expected the file, got ${found._tag}`)
        expect(new Uint8Array(found.bytes)).toEqual(new Uint8Array([103, 108, 84, 70]))
        expect(found.etag).toMatch(/^"4-\d+"$/u)
        expect(found.type).toBe('model/gltf-binary')
        expect(yield* anatomy.file('runner.glb', found.etag)).toEqual({
          _tag: 'NotModified',
          etag: found.etag,
        })
        expect((yield* anatomy.file('runner.glb', '"4-0"'))._tag).toBe('Found')
        // A list, weak tags too
        for (const list of [`W/${found.etag}`, `"4-0", ${found.etag}`]) {
          expect((yield* anatomy.file('runner.glb', list))._tag).toBe('NotModified')
        }
      })
    )

    it.effect('never hands the page a structures.json that is not the catalog', () =>
      Effect.gen(function* () {
        const anatomy = yield* Anatomy
        yield* put('anatomy/structures.json', '{"vastus_lateralis_r": {"kind": "organ"}}')
        expect((yield* anatomy.file('structures.json', null))._tag).toBe('Broken')
        yield* put('anatomy/structures.json', anatomyCatalog)
        expect((yield* anatomy.file('structures.json', null))._tag).toBe('Found')
      })
    )
  }
)
