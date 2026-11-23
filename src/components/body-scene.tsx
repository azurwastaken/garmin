import { Bvh, Html, OrbitControls } from '@react-three/drei'
import { Canvas, events, useFrame, useLoader, type ThreeEvent } from '@react-three/fiber'
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  AdditiveBlending,
  type Blending,
  type BufferGeometry,
  Color,
  DoubleSide,
  type Intersection,
  type Matrix4,
  type Mesh,
  type Object3D,
  NormalBlending,
  ShaderMaterial,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import {
  type BodyPoint,
  type Catalog,
  painLevel,
  pinRadius,
  readPalette,
  type ScenePalette,
  structureLabel,
  type Tissue,
} from '#src/anatomy/catalog.ts'
import type { BodyPin } from '#src/journal/history.ts'

// The body map's 3D view, in the browser only (routes/body.tsx loads it lazily, never on the
// server): the anatomy model as a hologram, its structures hovered and clicked, the pains pinned.
// The model keeps the identity transform, so a hit point is the model-space point a note stores.

export const MODEL_URL = '/anatomy/runner.glb'

export interface SceneProps {
  readonly catalog: Catalog
  readonly shown: (id: string) => boolean
  readonly selected: string | null
  readonly pins: ReadonlyArray<BodyPin>
  // Each structure's highest pain over the period
  readonly heat: ReadonlyMap<string, number>
  readonly onHover: (id: string | null) => void
  readonly onPick: (id: string, point: BodyPoint) => void
  readonly onPin: (time: string) => void
}

// A media query, live
const useMediaQuery = (query: string) => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query]
  )
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => false
  )
}

// One material's look: its colour, its strength, how it composes with what is behind
interface HoloLook {
  readonly color: string
  readonly opacity: number
  readonly blending: Blending
}

const VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 position_ = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-position_.xyz);
  gl_Position = projectionMatrix * position_;
}`

// Fresnel: the edges glow, the faces seen straight on stay faint; a slow scan line across
const FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float time;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
  float scan = 0.92 + 0.08 * sin(gl_FragCoord.y * 0.6 - time * 2.5);
  gl_FragColor = vec4(color * (0.35 + 1.1 * rim) * scan, clamp((0.12 + rim) * opacity, 0.0, 1.0));
  #include <colorspace_fragment>
}`

const holoMaterial = (look: HoloLook, time: { value: number }) =>
  new ShaderMaterial({
    uniforms: { color: { value: new Color(look.color) }, opacity: { value: look.opacity }, time },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: look.blending,
  })

// How much each tissue shows when nothing is pinned on it: bones the brightest core
const TISSUE_GLOW: Record<Tissue, number> = {
  bone: 0.6,
  muscle: 0.4,
  tendon: 0.55,
  ligament: 0.55,
  fascia: 0.3,
  cartilage: 0.5,
  bursa: 0.35,
  fat_pad: 0.35,
}

interface Part {
  readonly id: string
  readonly geometry: BufferGeometry
  readonly matrix: Matrix4
}

// A hit on a hidden structure is no hit: the peeled layers stay unpickable
const visibleOnly = (store: Parameters<typeof events>[0]) => ({
  ...events(store),
  filter: (hits: Array<Intersection>) => hits.filter((hit) => hit.object.visible),
})

const round = (value: number) => Math.round(value * 1000) / 1000

const PartMesh = memo(function PartMesh({
  part,
  visible,
  material,
}: {
  readonly part: Part
  readonly visible: boolean
  readonly material: ShaderMaterial
}) {
  return (
    <mesh
      name={part.id}
      geometry={part.geometry}
      matrix={part.matrix}
      matrixAutoUpdate={false}
      visible={visible}
      material={material}
    />
  )
})

function Model({
  catalog,
  shown,
  selected,
  hovered,
  heat,
  palette,
  reduced,
  onHover,
  onPick,
}: Pick<SceneProps, 'catalog' | 'shown' | 'selected' | 'heat' | 'onPick'> & {
  readonly hovered: { readonly id: string; readonly point: BodyPoint } | null
  readonly palette: ScenePalette
  readonly reduced: boolean
  readonly onHover: (hovered: { readonly id: string; readonly point: BodyPoint } | null) => void
}) {
  // Meshopt-compressed (EXT_meshopt_compression, KHR_mesh_quantization)
  const { scene } = useLoader(GLTFLoader, MODEL_URL, (loader) => {
    loader.setMeshoptDecoder(MeshoptDecoder)
  })
  // Every mesh in its place: the quantized model keeps its scale in the nodes' transforms
  const parts = useMemo(() => {
    scene.updateMatrixWorld(true)
    const found: Array<Part> = []
    scene.traverse((object: Object3D) => {
      if ((object as Partial<Mesh>).isMesh === true) {
        const mesh = object as Mesh
        found.push({ id: mesh.name, geometry: mesh.geometry, matrix: mesh.matrixWorld.clone() })
      }
    })
    return found
  }, [scene])

  const time = useMemo(() => ({ value: 0 }), [])
  useFrame((_, delta) => {
    if (!reduced) time.value += delta
  })

  // One material per look, made when first needed, all disposed with the palette
  const materials = useMemo(() => new Map<string, ShaderMaterial>(), [palette])
  useEffect(() => () => materials.forEach((material) => material.dispose()), [materials])
  const blending = palette.dark ? AdditiveBlending : NormalBlending
  const materialOf = (look: Omit<HoloLook, 'blending'>) => {
    const key = `${look.color}|${look.opacity}`
    const known = materials.get(key)
    if (known !== undefined) return known
    const made = holoMaterial({ ...look, blending }, time)
    materials.set(key, made)
    return made
  }
  const lookOf = (id: string) => {
    if (id === selected || id === hovered?.id) return { color: palette.highlight, opacity: 1 }
    const pain = heat.get(id)
    if (pain !== undefined) return { color: palette.pain[painLevel(pain)], opacity: 0.9 }
    const kind = catalog[id]?.kind
    return { color: palette.base, opacity: kind === undefined ? 0.4 : TISSUE_GLOW[kind] }
  }

  const pointOf = (event: ThreeEvent<PointerEvent | MouseEvent>): BodyPoint => [
    round(event.point.x),
    round(event.point.y),
    round(event.point.z),
  ]

  return (
    <group
      onPointerMove={(event) => {
        event.stopPropagation()
        if (event.object.name !== hovered?.id)
          onHover({ id: event.object.name, point: pointOf(event) })
      }}
      onPointerOut={() => onHover(null)}
      onClick={(event) => {
        event.stopPropagation()
        // A drag turns the model, it does not pin
        if (event.delta <= 4) onPick(event.object.name, pointOf(event))
      }}
    >
      {parts.map((part) => (
        <PartMesh
          key={part.id}
          part={part}
          visible={shown(part.id)}
          material={materialOf(lookOf(part.id))}
        />
      ))}
    </group>
  )
}

function Pins({
  pins,
  palette,
  onPin,
}: Pick<SceneProps, 'pins' | 'onPin'> & { readonly palette: ScenePalette }) {
  return pins.flatMap((pin) => {
    const point = pin.body.point
    if (point === undefined) return []
    const radius = pinRadius(pin.body.pain)
    const color = palette.pain[painLevel(pin.body.pain)]
    return [
      <group key={pin.time} position={[...point]}>
        <mesh
          onClick={(event) => {
            event.stopPropagation()
            onPin(pin.time)
          }}
        >
          <sphereGeometry args={[radius, 16, 12]} />
          <meshBasicMaterial color={color} depthTest={false} />
        </mesh>
        {palette.dark ? (
          <mesh scale={1.8} raycast={() => null}>
            <sphereGeometry args={[radius, 16, 12]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={0.35}
              blending={AdditiveBlending}
              depthWrite={false}
              depthTest={false}
            />
          </mesh>
        ) : null}
      </group>,
    ]
  })
}

export default function BodyScene({
  catalog,
  shown,
  selected,
  pins,
  heat,
  onHover,
  onPick,
  onPin,
}: SceneProps) {
  const schemeDark = useMediaQuery('(prefers-color-scheme: dark)')
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  // The sheet's colours, read again when the scheme changes
  const palette = useMemo(
    () => readPalette(getComputedStyle(document.documentElement)),
    [schemeDark]
  )
  const [hovered, setHovered] = useState<{ readonly id: string; readonly point: BodyPoint } | null>(
    null
  )
  const hover = (next: { readonly id: string; readonly point: BodyPoint } | null) => {
    setHovered(next)
    onHover(next?.id ?? null)
  }
  const tip = hovered === null ? undefined : catalog[hovered.id]

  return (
    <Canvas
      flat
      dpr={[1, 2]}
      camera={{ position: [0, 0.68, 2.6], fov: 32, near: 0.01, far: 20 }}
      events={visibleOnly}
      frameloop={reduced ? 'demand' : 'always'}
      onPointerMissed={() => hover(null)}
    >
      <color attach="background" args={[palette.stage]} />
      <OrbitControls
        makeDefault
        target={[0, 0.62, 0]}
        enableDamping={!reduced}
        minDistance={0.25}
        maxDistance={4}
      />
      <Suspense fallback={null}>
        <Bvh firstHitOnly>
          <Model
            catalog={catalog}
            shown={shown}
            selected={selected}
            hovered={hovered}
            heat={heat}
            palette={palette}
            reduced={reduced}
            onHover={hover}
            onPick={onPick}
          />
        </Bvh>
      </Suspense>
      <Pins pins={pins} palette={palette} onPin={onPin} />
      {hovered !== null && tip !== undefined ? (
        <Html position={[...hovered.point]} style={{ pointerEvents: 'none' }} zIndexRange={[10, 0]}>
          <div className="body-tip">{structureLabel(tip.french, tip.side)}</div>
        </Html>
      ) : null}
    </Canvas>
  )
}
