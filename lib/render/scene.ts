import * as THREE from "three";
import type { RunState } from "@/lib/game/types";
import { LANES, LOW_BARRIER_HEIGHT, OVERHEAD_CLEARANCE, DUCK_HEIGHT, PLAYER_HEIGHT } from "@/lib/game/constants";

/**
 * §4: "three.js, fixed chase camera behind the character, three lanes on a
 * scrolling ground plane. Primitive geometry and flat color for v1."
 *
 * §2's screen-distance problem drives every colour choice here. The player is
 * 2 to 2.5m away, so "critical state (lane position, incoming obstacle type)
 * [is] communicated by shape and color, not text": each obstacle type has one
 * saturated colour and one silhouette, and they were picked to stay
 * distinguishable when the screen is small in your vision and you are out of
 * breath.
 */

const COLORS = {
  ground: 0x161b26,
  laneLine: 0x33405c,
  player: 0x4dd2ff,
  /** Jump it. Warm, low, wide. */
  low: 0xffb020,
  /** Duck it. Cool, high, hanging. */
  overhead: 0x28e0d0,
  /** Go around it. Red means "no route through". */
  block: 0xff3d55,
  train: 0xc42340,
  coin: 0xffd84d,
};

export class Renderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private player: THREE.Group;
  private playerBody: THREE.Mesh;
  private pool = new Map<number, THREE.Mesh>();
  private coinPool = new Map<number, THREE.Mesh>();
  private ground: THREE.Mesh;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.scene.background = new THREE.Color(0x0b0f17);
    this.scene.fog = new THREE.Fog(0x0b0f17, 85, 190);

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 400);
    /*
     * §4: fixed chase camera. Not dynamic -- a camera that reacts to the player
     * adds apparent latency to a game already spending 250ms on input lag.
     *
     * Higher and further back than a chase camera usually sits, because of §2's
     * screen-distance problem. The first framing put the eye at 3.4m and looked
     * only 14m ahead: the player capsule filled the middle of the screen and
     * obstacles were specks until they were nearly arrived. At 2.5m from a
     * laptop that is unreadable, and §5 needs the obstacle *type* legible a
     * full 700ms out.
     *
     * What actually fixed it was the *pitch*, not the distance. Looking far
     * down the track flattens the view toward horizontal, which compresses
     * hundreds of metres into a sliver and leaves the top 40% of the screen
     * empty sky. Pitching down about 20 degrees pushes the horizon near the top
     * of the frame and gives the track the whole screen, which is where the
     * approach time comes from. Character detail is traded away, and nobody
     * standing 2.5m back could see it anyway.
     */
    this.camera.position.set(0, 7.0, 8.0);
    this.camera.lookAt(0, 0.4, -10);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(6, 14, 8);
    this.scene.add(key);

    // Wide enough that its edges leave the frame. At 14m the ground rendered as
    // a narrow triangle floating in the void, which read as a bug rather than
    // as a road.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(13.5, 900),
      new THREE.MeshBasicMaterial({ color: COLORS.ground })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.z = -430;
    this.scene.add(this.ground);

    for (const x of [-3.9, -1.3, 1.3, 3.9]) {
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(0.13, 900),
        new THREE.MeshBasicMaterial({ color: COLORS.laneLine })
      );
      line.rotation.x = -Math.PI / 2;
      line.position.set(x, 0.02, -430);
      this.scene.add(line);
    }

    this.player = new THREE.Group();
    this.playerBody = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.42, PLAYER_HEIGHT - 0.84, 6, 12),
      new THREE.MeshLambertMaterial({ color: COLORS.player })
    );
    this.playerBody.position.y = PLAYER_HEIGHT / 2;
    this.player.add(this.playerBody);
    this.scene.add(this.player);

    this.resize();
  }

  resize = () => {
    const c = this.renderer.domElement;
    const w = c.clientWidth || window.innerWidth;
    const h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private meshFor(kind: string): THREE.Mesh {
    switch (kind) {
      case "low":
        // Wide and low: reads as something to clear.
        return new THREE.Mesh(
          new THREE.BoxGeometry(2.3, LOW_BARRIER_HEIGHT, 1.2),
          new THREE.MeshLambertMaterial({ color: COLORS.low })
        );
      case "overhead":
        // Hanging, with a visible gap under it: reads as something to go beneath.
        return new THREE.Mesh(
          new THREE.BoxGeometry(2.4, 1.1, 1.2),
          new THREE.MeshLambertMaterial({ color: COLORS.overhead })
        );
      case "train":
        return new THREE.Mesh(
          new THREE.BoxGeometry(2.3, 2.6, 34),
          new THREE.MeshLambertMaterial({ color: COLORS.train })
        );
      default:
        // Tall and solid, floor to above head: reads as no way through.
        return new THREE.Mesh(
          new THREE.BoxGeometry(2.3, 2.6, 1.6),
          new THREE.MeshLambertMaterial({ color: COLORS.block })
        );
    }
  }

  render(state: RunState) {
    const p = state.player;
    this.player.position.x = p.x;
    this.player.position.y = p.y;
    // Ducking squashes the capsule rather than swapping the mesh, so the
    // silhouette change is continuous and readable from across a room.
    const ducking = p.duckFor > 0;
    this.playerBody.scale.y = ducking ? DUCK_HEIGHT / PLAYER_HEIGHT : 1;
    this.playerBody.position.y = (ducking ? DUCK_HEIGHT : PLAYER_HEIGHT) / 2;

    const seen = new Set<number>();
    for (const o of state.obstacles) {
      seen.add(o.id);
      let m = this.pool.get(o.id);
      if (!m) {
        m = this.meshFor(o.kind);
        this.pool.set(o.id, m);
        this.scene.add(m);
      }
      const z = -(o.z - state.distance) - (o.kind === "train" ? o.length / 2 : 0);
      m.position.set(
        LANES[o.lane],
        o.kind === "overhead" ? OVERHEAD_CLEARANCE + 0.45 : o.kind === "low" ? LOW_BARRIER_HEIGHT / 2 : 1.2,
        z
      );
    }
    for (const [id, m] of this.pool) {
      if (!seen.has(id)) { this.scene.remove(m); m.geometry.dispose(); this.pool.delete(id); }
    }

    const seenCoins = new Set<number>();
    for (const c of state.coinsOnTrack) {
      if (c.taken) continue;
      seenCoins.add(c.id);
      let m = this.coinPool.get(c.id);
      if (!m) {
        m = new THREE.Mesh(
          new THREE.CylinderGeometry(0.38, 0.38, 0.09, 14),
          new THREE.MeshLambertMaterial({ color: COLORS.coin })
        );
        m.rotation.x = Math.PI / 2;
        this.coinPool.set(c.id, m);
        this.scene.add(m);
      }
      m.position.set(LANES[c.lane], c.y, -(c.z - state.distance));
      m.rotation.z = state.elapsed * 3;
    }
    for (const [id, m] of this.coinPool) {
      if (!seenCoins.has(id)) { this.scene.remove(m); m.geometry.dispose(); this.coinPool.delete(id); }
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
  }
}
